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

import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { getSessionManager, type ConversationEntry } from '../service/session-manager.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Research types the watcher can identify
 */
export type ResearchType = 'direct' | 'alternative' | 'validation';

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

  // Configuration
  private readonly COOLDOWN_MS = 30000;            // 30s between research per session
  private readonly MIN_CONFIDENCE_DIRECT = 0.4;    // Threshold for direct research
  private readonly MIN_CONFIDENCE_ALTERNATIVE = 0.6; // Higher bar for suggesting pivots
  private readonly MIN_CONFIDENCE_VALIDATION = 0.5;  // For confirming approaches
  // Reserved for future rate limiting
  // private readonly MAX_ANALYSIS_CALLS = 3;

  constructor() {
    super();
    this.logger = new Logger('ConversationWatcher');
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
    // IMPORTANT: Skip analysis on user prompts - let Claude decide if it needs manual research
    if (trigger === 'user_prompt') {
      this.logger.debug(`Skipping analysis for user prompt - manual research should be used`);
      return this.createNoResearchDecision('User prompts should use manual research()');
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

    // Check for recent similar research
    const recentMessages = context.recentMessages.slice(-5);
    const combinedText = recentMessages.map(m => m.content).join(' ');
    if (this.sessionManager.hasRecentSimilarResearch(sessionId, combinedText, 3600000)) {
      return this.createNoResearchDecision('Similar research performed recently');
    }

    // Build prompt and call Claude for analysis
    const prompt = this.buildAnalysisPrompt(context, trigger, sessionId);

    try {
      const response = await this.callClaude(prompt);
      const decision = this.parseWatcherResponse(response);

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
          researchType: 'direct',
          confidence: 0.6,
          priority: 7,
          reason: 'Error detected in tool output - passive research triggered',
        };
      }
    }

    // Check for deprecation warnings
    if (/deprecated/i.test(text) || /will be removed/i.test(text)) {
      return {
        shouldResearch: true,
        query: this.extractDeprecationQuery(text),
        researchType: 'validation',
        confidence: 0.5,
        priority: 5,
        reason: 'Deprecation warning detected - checking for alternatives',
      };
    }

    // No quick match - return null (no passive research needed)
    return null;
  }

  /**
   * Check if proactive/strategic research should be triggered
   * This is for broader context research, not reactive error handling
   */
  checkProactiveTriggers(sessionId: string): WatcherDecision | null {
    // Check if Claude seems stuck on something
    const stuckIndicator = this.sessionManager.getStuckIndicator(sessionId, 8);
    if (stuckIndicator.isStuck && stuckIndicator.focusArea) {
      this.logger.info(`Stuck detected: ${stuckIndicator.focusArea} for ${stuckIndicator.turns} turns`);
      return {
        shouldResearch: true,
        query: `alternative approaches to ${stuckIndicator.focusArea}`,
        researchType: 'alternative',
        confidence: 0.7,
        priority: 6,
        reason: `Claude has been focused on "${stuckIndicator.focusArea}" for ${stuckIndicator.turns} turns - may benefit from alternative perspectives`,
        alternativeHint: `Consider different approach to ${stuckIndicator.focusArea}`,
      };
    }

    // Check if it's time for periodic strategic analysis
    if (this.sessionManager.shouldTriggerStrategicAnalysis(sessionId, 15)) {
      const strategic = this.sessionManager.getStrategicContext(sessionId);
      if (strategic && strategic.complementaryAreas.length > 0) {
        this.sessionManager.markStrategicAnalysis(sessionId);
        const area = strategic.complementaryAreas[0];
        this.logger.info(`Strategic analysis triggered: ${area}`);
        return {
          shouldResearch: true,
          query: `${area} for ${strategic.techStack.slice(0, 3).join(' ')} project`,
          researchType: 'validation',
          confidence: 0.5,
          priority: 4,
          reason: `Periodic strategic check - complementary research on "${area}"`,
        };
      }
    }

    return null;
  }

  /**
   * Get cooldown remaining for a session
   */
  getCooldownRemaining(sessionId: string): number {
    const lastTime = this.lastResearchTime.get(sessionId);
    if (!lastTime) return 0;

    const elapsed = Date.now() - lastTime;
    return Math.max(0, this.COOLDOWN_MS - elapsed);
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
    const queryGenerator = query({
      prompt,
      options: {
        maxTurns: 1,
        tools: [],
        // Haiku is used for efficiency
      },
    });

    let result = '';
    for await (const message of queryGenerator) {
      if (message.type === 'result' && message.subtype === 'success') {
        result = message.result;
        break;
      }
    }

    return result;
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

    parts.push('You are a CREATIVE research strategist watching Claude work on coding tasks.');
    parts.push('');
    parts.push('## Your Role');
    parts.push('You are NOT here to answer user questions - Claude will manually call research() for that.');
    parts.push('Instead, you PROACTIVELY identify research that would help Claude work better:');
    parts.push('- Research that anticipates problems before they happen');
    parts.push('- Best practices Claude might not be considering');
    parts.push('- Alternative approaches when Claude seems stuck');
    parts.push('- Complementary knowledge (e.g., frontend patterns when building backend)');
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

    parts.push('## Research Opportunities to Consider');
    parts.push('');
    parts.push('**1. Error Resolution** (High priority if errors present)');
    parts.push('   - Troubleshooting guides, common fixes, root cause analysis');
    parts.push('');
    parts.push('**2. Alternative Approaches** (When Claude seems stuck or iterating)');
    parts.push('   - Different libraries, patterns, or architectural approaches');
    parts.push('   - "Is there a fundamentally better way to do this?"');
    parts.push('');
    parts.push('**3. Best Practices & Patterns** (Proactive quality improvement)');
    parts.push('   - Industry standards for the detected tech stack');
    parts.push('   - Security considerations, performance patterns');
    parts.push('');
    parts.push('**4. Complementary Knowledge** (Broader project context)');
    parts.push('   - If backend: how will frontend consume this?');
    parts.push('   - If feature: what about testing, deployment, monitoring?');
    parts.push('   - What related areas might benefit from research?');
    parts.push('');
    parts.push('**5. Future-Proofing** (Anticipate problems)');
    parts.push('   - Scalability concerns for current approach');
    parts.push('   - Known issues with detected dependencies');
    parts.push('   - Migration paths from deprecated patterns');
    parts.push('');

    parts.push('## Your Task');
    parts.push('Think creatively: What research would make Claude more effective?');
    parts.push("Don't just react to problems - anticipate needs and suggest proactive research.");
    parts.push('');
    parts.push('If suggesting research, be SPECIFIC with the query.');
    parts.push('Bad: "best practices" → Good: "TypeScript Express error handling middleware patterns 2024"');
    parts.push('');

    parts.push('Respond in this exact JSON format:');
    parts.push('{');
    parts.push('  "shouldResearch": true/false,');
    parts.push('  "query": "specific, targeted search query",');
    parts.push('  "researchType": "direct|alternative|validation|proactive",');
    parts.push('  "confidence": 0.0-1.0,');
    parts.push('  "priority": 1-10,');
    parts.push('  "reason": "why this research would help Claude",');
    parts.push('  "alternativeHint": "if suggesting a pivot, describe the alternative",');
    parts.push('  "blockedBy": "skip if too similar to recent research"');
    parts.push('}');

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

    switch (decision.researchType) {
      case 'direct':
        return decision.confidence >= this.MIN_CONFIDENCE_DIRECT;
      case 'alternative':
        return decision.confidence >= this.MIN_CONFIDENCE_ALTERNATIVE;
      case 'validation':
        return decision.confidence >= this.MIN_CONFIDENCE_VALIDATION;
      default:
        return decision.confidence >= this.MIN_CONFIDENCE_DIRECT;
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

  private extractDeprecationQuery(text: string): string {
    // Try to extract what's deprecated
    const deprecatedMatch = text.match(/['"]?(\w+)['"]?\s*(?:is|has been)?\s*deprecated/i);
    if (deprecatedMatch) {
      return `${deprecatedMatch[1]} deprecated alternative replacement`;
    }

    // Try to extract "will be removed" context
    const removedMatch = text.match(/(\w+)\s*will be removed/i);
    if (removedMatch) {
      return `${removedMatch[1]} replacement migration guide`;
    }

    return 'deprecated API migration guide';
  }
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
