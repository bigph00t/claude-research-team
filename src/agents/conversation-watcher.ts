/**
 * ConversationWatcher Agent
 *
 * Always-on Claude Haiku agent that watches all Claude Code sessions simultaneously.
 * It maintains rich context per session and intelligently decides when research would help.
 *
 * Key responsibilities:
 * - Analyze user prompts and tool outputs in real-time
 * - Maintain understanding of what each session is working on
 * - Detect research opportunities (knowledge gaps, errors, questions)
 * - Apply creative thinking to detect when alternative approaches might be better
 * - Respect cooldowns and avoid redundant research
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { queryAI } from '../ai/provider.js';
import { getSessionManager, type ConversationEntry } from '../service/session-manager.js';
import { getProjectContextService, type QuickProjectContext } from '../context/project-context.js';
import { getDatabase } from '../database/index.js';
import type { Config, ResearchSettings } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Research types the watcher can identify
 */
export type ResearchType = 'error' | 'stuck' | 'unknown_api' | 'proactive' | 'direct';

/**
 * Watcher's decision about whether to research
 */
export interface WatcherDecision {
  shouldResearch: boolean;
  query?: string;
  researchType: ResearchType;
  confidence: number;       // 0-1
  priority: number;         // 1-10
  reason: string;
  alternativeHint?: string; // If suspecting different approach
  blockedBy?: string;       // What we already researched
  projectPath?: string;     // Project this research is for
  projectContext?: QuickProjectContext;  // Cached project analysis
}

/**
 * Events emitted by the watcher
 */
export interface WatcherEvents {
  'research:triggered': (sessionId: string, decision: WatcherDecision) => void;
  'analysis:complete': (sessionId: string, decision: WatcherDecision) => void;
  'cooldown:active': (sessionId: string, remainingMs: number) => void;
}

// ============================================================================
// ConversationWatcher
// ============================================================================

export class ConversationWatcher extends EventEmitter {
  private logger: Logger;
  private sessionManager = getSessionManager();

  // Cooldown tracking per session
  private lastResearchTime: Map<string, number> = new Map();

  // GLOBAL rate limiting - prevents runaway costs
  private globalResearchCount = 0;
  private globalResearchResetTime = Date.now();

  // Dynamic configuration from dashboard settings
  private settings: ResearchSettings = DEFAULT_CONFIG.research;
  private autonomousEnabled = true;

  constructor() {
    super();
    this.logger = new Logger('ConversationWatcher');
  }

  /**
   * Update configuration from dashboard settings
   */
  updateConfig(config: Config): void {
    this.settings = config.research;
    this.autonomousEnabled = config.research.autonomousEnabled;
    this.logger.info('Config updated', {
      autonomousEnabled: this.autonomousEnabled,
      confidenceThreshold: this.settings.confidenceThreshold,
      sessionCooldownMs: this.settings.sessionCooldownMs,
      maxResearchPerHour: this.settings.maxResearchPerHour,
    });
  }

  /**
   * Get current settings (for status display)
   */
  getSettings(): ResearchSettings {
    return { ...this.settings };
  }

  /**
   * Check global rate limit
   */
  private checkGlobalRateLimit(): boolean {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;

    // Reset counter every hour
    if (now - this.globalResearchResetTime > hourMs) {
      this.globalResearchCount = 0;
      this.globalResearchResetTime = now;
    }

    const maxPerHour = this.settings.maxResearchPerHour;
    if (this.globalResearchCount >= maxPerHour) {
      this.logger.warn(`Global rate limit reached: ${this.globalResearchCount}/${maxPerHour} per hour`);
      return false;
    }

    return true;
  }

  /**
   * Increment global research counter
   */
  private incrementGlobalCounter(): void {
    this.globalResearchCount++;
    this.logger.info(`Global research count: ${this.globalResearchCount}/${this.settings.maxResearchPerHour} this hour`);
  }

  /**
   * Analyze a session and decide if PASSIVE research would help
   * Called when new events arrive (user prompt, tool output)
   *
   * IMPORTANT: This is for PASSIVE research only - triggered during Claude's work.
   * User questions should NOT trigger this - Claude should manually call research() instead.
   *
   * Focus areas for passive research:
   * - Tool outputs with errors/issues (Claude's work needs help)
   * - Repeated failed attempts (Claude might be stuck)
   * - Complex technical implementations (might benefit from best practices)
   * - Alternative approaches (Claude might have tunnel vision)
   */
  async analyze(sessionId: string, trigger: 'user_prompt' | 'tool_output'): Promise<WatcherDecision> {
    // Check if autonomous research is enabled
    if (!this.autonomousEnabled) {
      return this.createNoResearchDecision('Autonomous research disabled in settings');
    }

    // IMPORTANT: Skip analysis on user prompts - let Claude decide if it needs manual research
    if (trigger === 'user_prompt') {
      this.logger.debug(`Skipping analysis for user prompt - manual research should be used`);
      return this.createNoResearchDecision('User prompts should use manual research()');
    }

    // Check GLOBAL rate limit first - prevents runaway costs
    if (!this.checkGlobalRateLimit()) {
      return this.createNoResearchDecision('Global rate limit reached');
    }

    // Check cooldown
    const cooldownRemaining = this.getCooldownRemaining(sessionId);
    if (cooldownRemaining > 0) {
      this.logger.debug(`Cooldown active for ${sessionId}: ${cooldownRemaining}ms remaining`);
      this.emit('cooldown:active', sessionId, cooldownRemaining);
      return this.createNoResearchDecision('Cooldown active');
    }

    // Get session context
    const context = this.sessionManager.getWatcherContext(sessionId);
    if (!context) {
      return this.createNoResearchDecision('Session not found');
    }

    // Check for recent similar research in DATABASE (not just session memory)
    // This prevents repeating the same queries across sessions
    const recentMessages = context.recentMessages.slice(-5);
    const combinedText = recentMessages.map(m => m.content).join(' ');

    // Check in-memory session history
    if (this.sessionManager.hasRecentSimilarResearch(sessionId, combinedText, 3600000)) {
      return this.createNoResearchDecision('Similar research performed recently (session)');
    }

    // Check database for recent similar queries (persistent deduplication)
    try {
      const db = getDatabase();
      const dbCheck = db.hasRecentSimilarQuery(combinedText, 3600000);
      if (dbCheck.found) {
        this.logger.debug(`Skipping - similar query already in database: "${dbCheck.existingQuery}"`);
        return this.createNoResearchDecision(`Similar research in database: ${dbCheck.existingQuery}`);
      }
    } catch (e) {
      this.logger.debug('Database dedup check failed', e);
    }

    // Get project context if project path available
    let projectContext: QuickProjectContext | undefined;
    const projectPath = context.projectPath;
    if (projectPath) {
      try {
        const projectService = getProjectContextService();
        projectContext = await projectService.getQuickContext(projectPath);
      } catch (e) {
        this.logger.debug('Failed to get project context', e);
      }
    }

    // Build prompt and call Claude for analysis
    const prompt = this.buildAnalysisPrompt(context, trigger, sessionId);

    try {
      const response = await this.callClaude(prompt);
      const decision = this.parseWatcherResponse(response);

      // Log decision for debugging
      this.logger.info('Watcher decision', {
        shouldResearch: decision.shouldResearch,
        query: decision.query?.slice(0, 50),
        type: decision.researchType,
        confidence: decision.confidence,
        reason: decision.reason?.slice(0, 100),
      });

      // Add project context to decision
      decision.projectPath = projectPath;
      decision.projectContext = projectContext;

      // DEDUP CHECK: If AI suggests a query, check if it's already in the database
      if (decision.shouldResearch && decision.query) {
        try {
          const db = getDatabase();
          const dbCheck = db.hasRecentSimilarQuery(decision.query, 3600000);
          if (dbCheck.found) {
            this.logger.info(`Blocking duplicate query: "${decision.query}" similar to "${dbCheck.existingQuery}"`);
            return this.createNoResearchDecision(`Duplicate query blocked: ${dbCheck.existingQuery}`);
          }
        } catch (e) {
          this.logger.debug('Database dedup check failed for suggested query', e);
        }
      }

      // Apply confidence thresholds
      if (!this.meetsThreshold(decision)) {
        this.logger.debug(`Decision below threshold: ${decision.researchType} at ${decision.confidence}`);
        return { ...decision, shouldResearch: false };
      }

      // Record decision
      this.emit('analysis:complete', sessionId, decision);

      if (decision.shouldResearch) {
        this.lastResearchTime.set(sessionId, Date.now());
        this.sessionManager.markAnalyzed(sessionId);
        this.incrementGlobalCounter();  // Track global research count
        this.emit('research:triggered', sessionId, decision);
      }

      return decision;
    } catch (error) {
      this.logger.error('Analysis failed', error);
      return this.createNoResearchDecision('Analysis failed');
    }
  }

  /**
   * Quick analysis without Claude call - pattern-based detection
   * Use for common, obvious cases to save API costs
   *
   * IMPORTANT: This should ONLY trigger on tool outputs (Claude's work),
   * NOT on user questions. User questions should be handled by Claude
   * manually calling the research() MCP tool.
   */
  quickAnalyze(sessionId: string): WatcherDecision | null {
    const context = this.sessionManager.getWatcherContext(sessionId);
    if (!context) return null;

    const lastMessage = context.recentMessages[context.recentMessages.length - 1];
    if (!lastMessage) return null;

    // IMPORTANT: Only analyze tool outputs, not user prompts
    // User questions should trigger manual research calls by Claude, not passive research
    if (lastMessage.type === 'user_prompt') {
      return null; // Let Claude decide if it needs to call research() manually
    }

    const text = lastMessage.content.toLowerCase();

    // Check for errors in tool outputs (Claude's work)
    const errorPatterns = [
      /error[:\s]/i,
      /exception/i,
      /failed/i,
      /cannot\s+find/i,
      /module not found/i,
      /undefined is not/i,
      /typeerror/i,
      /syntaxerror/i,
      /referenceerror/i,
      /enoent/i,
      /eacces/i,
      /etimedout/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(text)) {
        return {
          shouldResearch: true,
          query: this.extractErrorQuery(text),
          researchType: 'error',
          confidence: 0.85,  // Still below 0.9 threshold - let AI decide
          priority: 7,
          reason: 'Error detected - but need AI confirmation',
        };
      }
    }

    // DISABLED: Deprecation warnings are too noisy and Claude can handle them
    // if (/deprecated/i.test(text) || /will be removed/i.test(text)) {
    //   return { ... };
    // }

    // No quick match - return null (no passive research needed)
    return null;
  }

  /**
   * Check if proactive/strategic research should be triggered
   * DISABLED: This was causing too much irrelevant research
   */
  checkProactiveTriggers(_sessionId: string): WatcherDecision | null {
    // DISABLED: Proactive triggers were causing irrelevant research spam
    // Claude knows best practices already - only help on actual errors
    return null;
  }

  /**
   * Get cooldown remaining for a session
   */
  getCooldownRemaining(sessionId: string): number {
    const lastTime = this.lastResearchTime.get(sessionId);
    if (!lastTime) return 0;

    const elapsed = Date.now() - lastTime;
    return Math.max(0, this.settings.sessionCooldownMs - elapsed);
  }

  /**
   * Reset cooldown for a session (e.g., after user explicitly requests research)
   */
  resetCooldown(sessionId: string): void {
    this.lastResearchTime.delete(sessionId);
  }

  // ============================================================================
  // Private: Claude Interaction
  // ============================================================================

  private async callClaude(prompt: string): Promise<string> {
    const result = await queryAI(prompt, {
      maxTokens: 512,
      temperature: 0.3, // Lower temperature for consistent decisions
    });

    this.logger.debug(`Analysis by ${result.provider}`, { model: result.model });
    return result.content;
  }

  // ============================================================================
  // Private: Prompt Building
  // ============================================================================

  private buildAnalysisPrompt(
    context: {
      currentTask: string | null;
      topics: string[];
      recentErrors: string[];
      researchHistory: string[];
      recentMessages: ConversationEntry[];
    },
    trigger: 'user_prompt' | 'tool_output',
    sessionId?: string
  ): string {
    const parts: string[] = [];

    parts.push('You are a research assistant watching Claude work on coding tasks.');
    parts.push('');
    parts.push('## Your Role');
    parts.push('Identify research that would DIRECTLY help with what Claude is CURRENTLY working on.');
    parts.push('');
    parts.push('GOOD research triggers:');
    parts.push('- Actual errors Claude is trying to fix');
    parts.push('- Specific APIs or libraries Claude is actively using');
    parts.push('- Technical questions directly related to the current task');
    parts.push('');
    parts.push('BAD research triggers (DO NOT suggest):');
    parts.push('- Generic "best practices" for technologies mentioned in passing');
    parts.push('- Topics tangentially related to keywords (e.g., seeing "session" and researching session management)');
    parts.push('- Things Claude already knows (common patterns, standard library usage)');
    parts.push('- Anything not DIRECTLY related to the current task');
    parts.push('');

    parts.push('## Current Session Context');
    if (context.currentTask) {
      parts.push(`- **Working on:** ${context.currentTask}`);
    }
    if (context.topics.length > 0) {
      parts.push(`- **Topics:** ${context.topics.slice(0, 10).join(', ')}`);
    }

    // Add strategic context if available
    if (sessionId) {
      const strategic = this.sessionManager.getStrategicContext(sessionId);
      if (strategic) {
        if (strategic.techStack.length > 0) {
          parts.push(`- **Tech stack:** ${strategic.techStack.slice(0, 8).join(', ')}`);
        }
        if (strategic.complementaryAreas.length > 0) {
          parts.push(`- **Suggested complementary areas:** ${strategic.complementaryAreas.join(', ')}`);
        }
        parts.push(`- **Session duration:** ${Math.round(strategic.sessionDuration / 60000)} minutes`);
        parts.push(`- **Tool uses:** ${strategic.toolUseCount}`);
      }

      // Check stuck indicator
      const stuck = this.sessionManager.getStuckIndicator(sessionId);
      if (stuck.isStuck) {
        parts.push(`- **⚠️ STUCK INDICATOR:** Claude has been focused on "${stuck.focusArea}" for ${stuck.turns} turns`);
      }
    }

    if (context.recentErrors.length > 0) {
      parts.push(`- **Recent errors:** ${context.recentErrors.slice(-3).join('; ')}`);
    }
    if (context.researchHistory.length > 0) {
      parts.push(`- **Already researched:** ${context.researchHistory.slice(-5).join('; ')}`);
    }
    parts.push('');

    parts.push('## Recent Conversation');
    for (const msg of context.recentMessages.slice(-8)) {
      const prefix = msg.type === 'user_prompt' ? 'USER' :
                     msg.type === 'tool_use' ? 'TOOL' :
                     msg.type === 'tool_output' ? 'OUTPUT' :
                     msg.type === 'injection' ? 'RESEARCH' : 'MSG';
      parts.push(`[${prefix}] ${msg.content.slice(0, 500)}${msg.content.length > 500 ? '...' : ''}`);
    }
    parts.push('');

    parts.push(`## Trigger: ${trigger === 'user_prompt' ? 'New user message' : 'Tool completed'}`);
    parts.push('');

    parts.push('## Research Triggers (pick ONE if applicable):');
    parts.push('');
    parts.push('**error** - Real error in tool output (not hypothetical)');
    parts.push('**stuck** - Claude tried 2+ times without success');
    parts.push('**unknown_api** - Using unfamiliar third-party library/package');
    parts.push('**proactive** - Quick lookup could help current task:');
    parts.push('   - Working with specific package (expo-*, react-native-*, etc)');
    parts.push('   - Implementing feature that has common patterns');
    parts.push('   - API usage that might have gotchas');
    parts.push('');
    parts.push('**Stay relevant to CURRENT TASK** - avoid tangential topics');
    parts.push('');

    parts.push('## Query Formatting');
    parts.push('- Do NOT append years (2024, 2025) to queries - search engines handle recency');
    parts.push('- Keep queries concise and specific');
    parts.push('- Focus on the technical problem, not general topics');
    parts.push('');

    parts.push('## When to SET shouldResearch: true');
    parts.push('');
    parts.push('SET TRUE when Claude is:');
    parts.push('- Working with expo-*, react-native-*, or other packages');
    parts.push('- Implementing features (uploads, audio, video, etc)');
    parts.push('- Hitting any error, even if making progress');
    parts.push('- Using APIs that have specific patterns');
    parts.push('');
    parts.push('KEEP FALSE only when:');
    parts.push('- Just reading files');
    parts.push('- Making trivial edits');
    parts.push('- Standard patterns Claude knows well');
    parts.push('');

    parts.push('Example TRUE response:');
    parts.push('{"shouldResearch": true, "query": "expo-file-system File class API", "researchType": "proactive", "confidence": 0.7, "priority": 5, "reason": "Claude working with expo-file-system"}');
    parts.push('');
    parts.push('Example FALSE response:');
    parts.push('{"shouldResearch": false, "query": "", "researchType": "direct", "confidence": 0.2, "priority": 1, "reason": "Just reading files"}');

    return parts.join('\n');
  }

  // ============================================================================
  // Private: Response Parsing
  // ============================================================================

  private parseWatcherResponse(response: string): WatcherDecision {
    // Try to parse as JSON
    try {
      // Find JSON in response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          shouldResearch?: boolean;
          query?: string;
          researchType?: string;
          confidence?: number;
          priority?: number;
          reason?: string;
          alternativeHint?: string;
          blockedBy?: string;
        };

        return {
          shouldResearch: parsed.shouldResearch ?? false,
          query: parsed.query,
          researchType: (parsed.researchType as ResearchType) || 'direct',
          confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
          priority: Math.max(1, Math.min(10, parsed.priority ?? 5)),
          reason: parsed.reason || 'Unknown reason',
          alternativeHint: parsed.alternativeHint,
          blockedBy: parsed.blockedBy,
        };
      }
    } catch (error) {
      this.logger.debug('Failed to parse JSON response', error);
    }

    // Fallback: try to extract information from text
    const shouldResearch = response.toLowerCase().includes('shouldresearch": true') ||
                          response.toLowerCase().includes('research') && !response.toLowerCase().includes('no research');

    return {
      shouldResearch,
      researchType: 'direct',
      confidence: 0.4,
      priority: 5,
      reason: 'Parsed from text response',
    };
  }

  // ============================================================================
  // Private: Helpers
  // ============================================================================

  private createNoResearchDecision(reason: string): WatcherDecision {
    return {
      shouldResearch: false,
      researchType: 'direct',
      confidence: 0,
      priority: 0,
      reason,
    };
  }

  private meetsThreshold(decision: WatcherDecision): boolean {
    if (!decision.shouldResearch) return false;

    // Use configured threshold (default 0.6)
    const baseThreshold = this.settings.confidenceThreshold;

    switch (decision.researchType) {
      case 'error':
        // Errors are actionable
        return decision.confidence >= baseThreshold;
      case 'stuck':
        // Stuck needs slightly higher confidence
        return decision.confidence >= Math.min(0.8, baseThreshold + 0.1);
      case 'unknown_api':
        return decision.confidence >= baseThreshold;
      case 'proactive':
        // Proactive uses base threshold
        return decision.confidence >= baseThreshold;
      default:
        return decision.confidence >= baseThreshold;
    }
  }

  // Reserved for future use - extractQueryFromText
  // Not used since we no longer trigger on user questions
  // private extractQueryFromText(text: string): string {
  //   const cleaned = text
  //     .replace(/^(how|what|why|can|could|would|should|is|are|does|do)\s+(you|we|i)\s*/i, '')
  //     .replace(/\?/g, '')
  //     .trim();
  //   return cleaned.slice(0, 200);
  // }

  private extractErrorQuery(text: string): string {
    // Try to extract the error type and context
    const errorMatch = text.match(/(?:error|exception|failed)[:\s]+(.{20,150})/i);
    if (errorMatch) {
      return `fix ${errorMatch[1].trim()}`;
    }

    // Try to extract module/package errors
    const moduleMatch = text.match(/(?:module not found|cannot find module)[:\s]*['"]?([^'"]+)['"]?/i);
    if (moduleMatch) {
      return `install or fix ${moduleMatch[1]} module`;
    }

    // Generic error query
    const firstLine = text.split('\n')[0].slice(0, 100);
    return `troubleshoot ${firstLine}`;
  }

  // extractDeprecationQuery removed - deprecation triggers disabled
}

// ============================================================================
// Singleton
// ============================================================================

let watcherInstance: ConversationWatcher | null = null;

export function getConversationWatcher(): ConversationWatcher {
  if (!watcherInstance) {
    watcherInstance = new ConversationWatcher();
  }
  return watcherInstance;
}
