/**
 * SessionManager - Multi-terminal session tracking with rich context
 *
 * Each Claude Code terminal gets its own isolated session context that tracks:
 * - Full conversation history (prompts + tool outputs)
 * - Extracted topics and current task
 * - Recent errors encountered
 * - What's already been researched (avoids redundancy)
 *
 * The ConversationWatcher agent will use this context to make intelligent
 * decisions about when research would help.
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { getDatabase } from '../database/index.js';
import type { Session } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single entry in the conversation history
 */
export interface ConversationEntry {
  type: 'user_prompt' | 'tool_use' | 'tool_output' | 'assistant' | 'injection';
  content: string;
  timestamp: number;
  metadata?: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    truncated?: boolean;  // If content was truncated
    researchId?: string;  // If this was an injection
  };
}

/**
 * Research that was performed for this session
 */
export interface SessionResearch {
  query: string;
  taskId: string;
  performedAt: number;
  injected: boolean;
  confidence: number;
}

/**
 * Rich context for a session - what the watcher agent uses to decide
 */
export interface SessionContext {
  sessionId: string;
  projectPath?: string;

  // Conversation tracking
  messages: ConversationEntry[];
  messageCount: number;

  // Semantic understanding
  topics: Set<string>;
  currentTask: string | null;
  taskHistory: string[];  // Previous tasks in this session

  // Error tracking
  recentErrors: string[];
  errorPatterns: Map<string, number>;  // Error type -> count

  // Research tracking
  researchHistory: SessionResearch[];
  pendingInjections: PendingInjection[];

  // Timing
  startedAt: number;
  lastActivityAt: number;
  lastAnalyzedAt: number;
  lastStrategicAnalysisAt: number;  // Last periodic strategic analysis

  // State
  isActive: boolean;

  // === NEW: Proactive research triggers ===

  // Tool use tracking for periodic strategic analysis
  toolUseCount: number;
  toolUseCountSinceLastStrategic: number;

  // Iteration detection - track focus areas
  focusArea: string | null;           // Current area of focus (file, component, etc.)
  focusAreaTurns: number;             // How many turns on this focus area
  focusAreaHistory: Array<{area: string; turns: number; resolvedAt?: number}>;

  // Files/areas touched for broader context
  filesTouched: Set<string>;
  directoriesActive: Set<string>;

  // Technologies detected
  techStack: Set<string>;

  // claude-mem context (populated from claude-mem if available)
  claudeMemContext?: {
    recentSummary?: string;
    relatedObservations?: string[];
    projectContext?: string;
  };
}

/**
 * Research results waiting to be injected
 */
export interface PendingInjection {
  taskId?: string;
  query: string;
  summary: string;
  relevance: number;
  queuedAt: number;
  priority: number;
  pivot?: {
    alternative: string;
    reason: string;
    urgency: 'low' | 'medium' | 'high';
  };
}

/**
 * Event types emitted by SessionManager
 */
export interface SessionEvents {
  'session:created': (session: SessionContext) => void;
  'session:updated': (session: SessionContext) => void;
  'session:ended': (sessionId: string) => void;
  'research:opportunity': (sessionId: string, context: SessionContext) => void;
  'injection:ready': (sessionId: string, injection: PendingInjection) => void;
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionContext> = new Map();
  private logger: Logger;

  // Configuration
  private readonly MAX_MESSAGES = 100;          // Keep last N messages per session
  private readonly MAX_ERRORS = 20;             // Keep last N errors
  private readonly MAX_TOPICS = 50;             // Max topics to track
  private readonly MAX_RESEARCH_HISTORY = 50;   // Max research records
  private readonly SESSION_TIMEOUT_MS = 3600000; // 1 hour inactive = stale
  private readonly PRUNE_INTERVAL_MS = 300000;  // Check every 5 minutes

  private pruneTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.logger = new Logger('SessionManager');

    // Start periodic pruning
    this.startPruning();
  }

  /**
   * Get or create a session context
   */
  getOrCreateSession(sessionId: string, projectPath?: string): SessionContext {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = this.createSession(sessionId, projectPath);
      this.sessions.set(sessionId, session);

      // Persist to database
      this.persistSession(session);

      this.logger.info(`Session created: ${sessionId}`, { projectPath });
      this.emit('session:created', session);
    } else {
      // Update activity
      session.lastActivityAt = Date.now();
      if (projectPath && !session.projectPath) {
        session.projectPath = projectPath;
      }
    }

    return session;
  }

  /**
   * Get session without creating
   */
  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SessionContext[] {
    return Array.from(this.sessions.values()).filter(s => s.isActive);
  }

  /**
   * Add a user prompt to session history
   */
  addUserPrompt(sessionId: string, prompt: string, projectPath?: string): SessionContext {
    const session = this.getOrCreateSession(sessionId, projectPath);

    // Add to messages
    this.addMessage(session, {
      type: 'user_prompt',
      content: prompt,
      timestamp: Date.now(),
    });

    // Extract topics from prompt
    this.extractTopics(session, prompt);

    // Try to detect current task
    this.detectCurrentTask(session, prompt);

    session.lastActivityAt = Date.now();
    this.emit('session:updated', session);

    return session;
  }

  /**
   * Add tool use to session history
   */
  addToolUse(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
    projectPath?: string
  ): SessionContext {
    const session = this.getOrCreateSession(sessionId, projectPath);

    // Increment tool use counters
    session.toolUseCount++;
    session.toolUseCountSinceLastStrategic++;

    // Add tool use entry
    this.addMessage(session, {
      type: 'tool_use',
      content: `${toolName}: ${JSON.stringify(toolInput).slice(0, 500)}`,
      timestamp: Date.now(),
      metadata: { toolName, toolInput },
    });

    // Add tool output (truncated for memory)
    const truncatedOutput = toolOutput.slice(0, 2000);
    this.addMessage(session, {
      type: 'tool_output',
      content: truncatedOutput,
      timestamp: Date.now(),
      metadata: {
        toolName,
        truncated: toolOutput.length > 2000,
      },
    });

    // Track files touched
    this.trackFilesFromToolUse(session, toolName, toolInput, toolOutput);

    // Track focus area for iteration detection
    this.trackFocusArea(session, toolName, toolInput);

    // Extract topics from tool output
    this.extractTopics(session, toolOutput.slice(0, 5000));

    // Detect tech stack
    this.detectTechStack(session, toolOutput.slice(0, 5000));

    // Check for errors
    this.detectErrors(session, toolOutput, toolName);

    session.lastActivityAt = Date.now();
    this.emit('session:updated', session);

    return session;
  }

  /**
   * Record that research was performed
   */
  recordResearch(
    sessionId: string,
    query: string,
    taskId: string,
    confidence: number = 0.5
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const research: SessionResearch = {
      query,
      taskId,
      performedAt: Date.now(),
      injected: false,
      confidence,
    };

    session.researchHistory.push(research);

    // Trim if too many
    if (session.researchHistory.length > this.MAX_RESEARCH_HISTORY) {
      session.researchHistory = session.researchHistory.slice(-this.MAX_RESEARCH_HISTORY);
    }

    this.logger.debug(`Research recorded for ${sessionId}: "${query}"`);
  }

  /**
   * Queue an injection for a session
   */
  queueInjection(sessionId: string, injection: Omit<PendingInjection, 'queuedAt'>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.pendingInjections.push({
      ...injection,
      queuedAt: Date.now(),
    });

    // Sort by priority (highest first)
    session.pendingInjections.sort((a, b) => b.priority - a.priority);

    this.emit('injection:ready', sessionId, session.pendingInjections[0]);
    this.logger.debug(`Injection queued for ${sessionId}: "${injection.query}"`);
  }

  /**
   * Get and remove the next pending injection
   */
  popInjection(sessionId: string): PendingInjection | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.pendingInjections.length === 0) return undefined;

    const injection = session.pendingInjections.shift()!;

    // Mark research as injected
    const research = session.researchHistory.find(r => r.taskId === injection.taskId);
    if (research) {
      research.injected = true;
    }

    // Add to conversation history
    this.addMessage(session, {
      type: 'injection',
      content: injection.summary,
      timestamp: Date.now(),
      metadata: { researchId: injection.taskId },
    });

    return injection;
  }

  /**
   * Check if query is similar to recent research (avoid redundancy)
   */
  hasRecentSimilarResearch(sessionId: string, query: string, maxAgeMs: number = 3600000): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const now = Date.now();
    const queryLower = query.toLowerCase();
    const queryWords = new Set(queryLower.split(/\s+/).filter(w => w.length > 3));

    for (const research of session.researchHistory) {
      // Skip old research
      if (now - research.performedAt > maxAgeMs) continue;

      // Check similarity
      const researchWords = new Set(
        research.query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      );

      // Calculate Jaccard similarity
      const intersection = new Set([...queryWords].filter(w => researchWords.has(w)));
      const union = new Set([...queryWords, ...researchWords]);
      const similarity = intersection.size / union.size;

      if (similarity > 0.6) {
        this.logger.debug(`Query similar to recent research: "${query}" ~ "${research.query}" (${(similarity * 100).toFixed(0)}%)`);
        return true;
      }
    }

    return false;
  }

  /**
   * Get context for the watcher agent
   * Returns a trimmed version suitable for LLM context
   */
  getWatcherContext(sessionId: string, maxMessages: number = 10): {
    currentTask: string | null;
    topics: string[];
    recentErrors: string[];
    researchHistory: string[];
    recentMessages: ConversationEntry[];
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      currentTask: session.currentTask,
      topics: Array.from(session.topics).slice(0, 20),
      recentErrors: session.recentErrors.slice(-5),
      researchHistory: session.researchHistory
        .slice(-10)
        .map(r => r.query),
      recentMessages: session.messages.slice(-maxMessages),
    };
  }

  /**
   * Mark session analysis time
   */
  markAnalyzed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAnalyzedAt = Date.now();
    }
  }

  /**
   * End a session
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.isActive = false;

    // Persist final state
    this.persistSession(session);

    this.logger.info(`Session ended: ${sessionId}`, {
      duration: Date.now() - session.startedAt,
      messageCount: session.messageCount,
      researchCount: session.researchHistory.length,
    });

    this.emit('session:ended', sessionId);
  }

  /**
   * Remove inactive sessions
   */
  pruneInactiveSessions(maxAgeMs: number = this.SESSION_TIMEOUT_MS): number {
    const now = Date.now();
    let pruned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivityAt > maxAgeMs) {
        this.endSession(sessionId);
        this.sessions.delete(sessionId);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.info(`Pruned ${pruned} inactive sessions`);
    }

    return pruned;
  }

  // ============================================================================
  // Proactive Research Triggers
  // ============================================================================

  /**
   * Check if it's time for periodic strategic analysis
   * Triggers every N tool uses for broader context review
   */
  shouldTriggerStrategicAnalysis(sessionId: string, threshold: number = 15): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Don't trigger too frequently
    const minIntervalMs = 120000; // 2 minutes minimum
    if (Date.now() - session.lastStrategicAnalysisAt < minIntervalMs) {
      return false;
    }

    return session.toolUseCountSinceLastStrategic >= threshold;
  }

  /**
   * Mark that strategic analysis was performed
   */
  markStrategicAnalysis(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastStrategicAnalysisAt = Date.now();
      session.toolUseCountSinceLastStrategic = 0;
    }
  }

  /**
   * Check if Claude seems stuck (iteration detection)
   * Returns focus area if stuck on same thing for too many turns
   */
  getStuckIndicator(sessionId: string, turnThreshold: number = 8): {
    isStuck: boolean;
    focusArea?: string;
    turns?: number;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) return { isStuck: false };

    if (session.focusArea && session.focusAreaTurns >= turnThreshold) {
      return {
        isStuck: true,
        focusArea: session.focusArea,
        turns: session.focusAreaTurns,
      };
    }

    return { isStuck: false };
  }

  /**
   * Get strategic context for proactive research
   * Returns broader project understanding for creative research decisions
   */
  getStrategicContext(sessionId: string): {
    techStack: string[];
    directoriesActive: string[];
    focusHistory: Array<{area: string; turns: number}>;
    sessionDuration: number;
    toolUseCount: number;
    complementaryAreas: string[];
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Suggest complementary areas based on current work
    const complementaryAreas = this.suggestComplementaryAreas(session);

    return {
      techStack: Array.from(session.techStack),
      directoriesActive: Array.from(session.directoriesActive).slice(-10),
      focusHistory: session.focusAreaHistory.slice(-5),
      sessionDuration: Date.now() - session.startedAt,
      toolUseCount: session.toolUseCount,
      complementaryAreas,
    };
  }

  /**
   * Suggest complementary areas to research based on current work
   */
  private suggestComplementaryAreas(session: SessionContext): string[] {
    const suggestions: string[] = [];
    const techStack = session.techStack;
    const dirs = Array.from(session.directoriesActive).join(' ');

    // If working on backend, suggest frontend considerations
    if (techStack.has('express') || techStack.has('fastapi') || techStack.has('django')) {
      if (!dirs.includes('frontend') && !dirs.includes('client') && !dirs.includes('ui')) {
        suggestions.push('frontend integration patterns');
      }
    }

    // If working on frontend, suggest API/backend considerations
    if (techStack.has('react') || techStack.has('vue') || techStack.has('svelte')) {
      if (!dirs.includes('api') && !dirs.includes('server') && !dirs.includes('backend')) {
        suggestions.push('API design best practices');
      }
    }

    // If working with database, suggest caching/performance
    if (techStack.has('postgres') || techStack.has('mongodb') || techStack.has('sqlite')) {
      suggestions.push('database query optimization');
    }

    // If no tests detected, suggest testing
    if (!session.filesTouched.has('test') && !techStack.has('jest') && !techStack.has('pytest')) {
      suggestions.push('testing strategies');
    }

    // If docker detected but no k8s, suggest deployment
    if (techStack.has('docker') && !techStack.has('kubernetes')) {
      suggestions.push('container orchestration options');
    }

    return suggestions.slice(0, 3);
  }

  /**
   * Load context from claude-mem if available
   */
  async loadClaudeMemContext(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      // Query claude-mem's API/database for relevant context
      const response = await fetch('http://localhost:37777/api/recent', {
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        const data = await response.json() as {
          summary?: string;
          observations?: Array<{content: string}>;
          project?: string;
        };

        session.claudeMemContext = {
          recentSummary: data.summary,
          relatedObservations: data.observations?.map(o => o.content).slice(0, 5),
          projectContext: data.project,
        };

        this.logger.debug(`Loaded claude-mem context for ${sessionId}`);
      }
    } catch {
      // claude-mem might not be running, that's okay
      this.logger.debug('Could not load claude-mem context');
    }
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalMessages: number;
    totalResearch: number;
    pendingInjections: number;
  } {
    let totalMessages = 0;
    let totalResearch = 0;
    let pendingInjections = 0;
    let activeSessions = 0;

    for (const session of this.sessions.values()) {
      if (session.isActive) activeSessions++;
      totalMessages += session.messageCount;
      totalResearch += session.researchHistory.length;
      pendingInjections += session.pendingInjections.length;
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      totalMessages,
      totalResearch,
      pendingInjections,
    };
  }

  /**
   * Shutdown - clean up resources
   */
  shutdown(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
    }

    // Persist all sessions
    for (const session of this.sessions.values()) {
      this.persistSession(session);
    }

    this.logger.info('SessionManager shutdown');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private createSession(sessionId: string, projectPath?: string): SessionContext {
    const now = Date.now();
    return {
      sessionId,
      projectPath,
      messages: [],
      messageCount: 0,
      topics: new Set(),
      currentTask: null,
      taskHistory: [],
      recentErrors: [],
      errorPatterns: new Map(),
      researchHistory: [],
      pendingInjections: [],
      startedAt: now,
      lastActivityAt: now,
      lastAnalyzedAt: 0,
      lastStrategicAnalysisAt: 0,
      isActive: true,
      // New proactive triggers
      toolUseCount: 0,
      toolUseCountSinceLastStrategic: 0,
      focusArea: null,
      focusAreaTurns: 0,
      focusAreaHistory: [],
      filesTouched: new Set(),
      directoriesActive: new Set(),
      techStack: new Set(),
    };
  }

  private addMessage(session: SessionContext, entry: ConversationEntry): void {
    session.messages.push(entry);
    session.messageCount++;

    // Trim old messages
    if (session.messages.length > this.MAX_MESSAGES) {
      session.messages = session.messages.slice(-this.MAX_MESSAGES);
    }
  }

  private extractTopics(session: SessionContext, text: string): void {
    // Simple topic extraction - can be enhanced with NLP later
    const patterns = [
      // Technology mentions
      /\b(react|vue|angular|svelte|nextjs|nuxt|remix)\b/gi,
      /\b(node|deno|bun|python|rust|go|typescript|javascript)\b/gi,
      /\b(docker|kubernetes|k8s|aws|gcp|azure|vercel|netlify)\b/gi,
      /\b(postgres|mysql|mongodb|redis|sqlite|prisma|drizzle)\b/gi,
      /\b(api|rest|graphql|grpc|websocket|http|https)\b/gi,
      /\b(auth|authentication|authorization|oauth|jwt|session)\b/gi,
      /\b(test|testing|jest|vitest|playwright|cypress)\b/gi,
      /\b(css|tailwind|scss|sass|styled-components)\b/gi,
      /\b(webpack|vite|esbuild|rollup|turbopack)\b/gi,

      // Concepts
      /\b(performance|optimization|caching|scaling)\b/gi,
      /\b(security|vulnerability|xss|csrf|injection)\b/gi,
      /\b(error|exception|bug|issue|problem)\b/gi,
      /\b(deploy|deployment|ci|cd|pipeline)\b/gi,
      /\b(database|migration|schema|query)\b/gi,
    ];

    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          session.topics.add(match.toLowerCase());
        }
      }
    }

    // Limit topics
    if (session.topics.size > this.MAX_TOPICS) {
      const topicsArray = Array.from(session.topics);
      session.topics = new Set(topicsArray.slice(-this.MAX_TOPICS));
    }
  }

  private detectCurrentTask(session: SessionContext, prompt: string): void {
    // Detect task from user prompt patterns
    const taskPatterns = [
      /(?:help me|i need to|i want to|let's|can you)\s+(.{10,100})/i,
      /(?:implement|create|build|fix|debug|add|update|refactor)\s+(.{10,100})/i,
      /(?:working on|trying to)\s+(.{10,100})/i,
    ];

    for (const pattern of taskPatterns) {
      const match = prompt.match(pattern);
      if (match) {
        const newTask = match[1].trim().replace(/[.!?].*/, '');

        if (session.currentTask && session.currentTask !== newTask) {
          // Task changed - save previous
          session.taskHistory.push(session.currentTask);
          if (session.taskHistory.length > 10) {
            session.taskHistory = session.taskHistory.slice(-10);
          }
        }

        session.currentTask = newTask;
        break;
      }
    }
  }

  private detectErrors(session: SessionContext, output: string, toolName: string): void {
    // Detect errors from tool output
    const errorPatterns = [
      /error[:\s]+(.{10,200})/gi,
      /exception[:\s]+(.{10,200})/gi,
      /failed[:\s]+(.{10,200})/gi,
      /cannot\s+(.{10,100})/gi,
      /unable to\s+(.{10,100})/gi,
      /not found[:\s]+(.{10,100})/gi,
      /permission denied/gi,
      /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT/g,
      /TypeError|ReferenceError|SyntaxError|RangeError/g,
      /ModuleNotFoundError|ImportError|AttributeError/g,
    ];

    for (const pattern of errorPatterns) {
      const matches = output.match(pattern);
      if (matches) {
        for (const match of matches) {
          const errorText = match.slice(0, 200);
          session.recentErrors.push(`[${toolName}] ${errorText}`);

          // Track error pattern frequency
          const errorType = this.categorizeError(errorText);
          session.errorPatterns.set(
            errorType,
            (session.errorPatterns.get(errorType) || 0) + 1
          );
        }
      }
    }

    // Limit errors
    if (session.recentErrors.length > this.MAX_ERRORS) {
      session.recentErrors = session.recentErrors.slice(-this.MAX_ERRORS);
    }
  }

  private categorizeError(errorText: string): string {
    const lower = errorText.toLowerCase();

    if (lower.includes('not found') || lower.includes('enoent')) return 'not_found';
    if (lower.includes('permission') || lower.includes('eacces')) return 'permission';
    if (lower.includes('connection') || lower.includes('network')) return 'network';
    if (lower.includes('syntax')) return 'syntax';
    if (lower.includes('type')) return 'type';
    if (lower.includes('import') || lower.includes('module')) return 'import';
    if (lower.includes('timeout')) return 'timeout';

    return 'other';
  }

  /**
   * Track files from tool use for broader context awareness
   */
  private trackFilesFromToolUse(
    session: SessionContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    _toolOutput: string
  ): void {
    // Extract file paths from tool input
    const possiblePathFields = ['file_path', 'path', 'file', 'filename'];

    for (const field of possiblePathFields) {
      if (typeof toolInput[field] === 'string') {
        const filePath = toolInput[field] as string;
        session.filesTouched.add(filePath);

        // Extract directory
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash > 0) {
          const dir = filePath.substring(0, lastSlash);
          session.directoriesActive.add(dir);
        }
      }
    }

    // For Glob/Grep, track the search path
    if (toolName === 'Glob' || toolName === 'Grep') {
      if (typeof toolInput['path'] === 'string') {
        session.directoriesActive.add(toolInput['path'] as string);
      }
    }

    // Limit set sizes
    if (session.filesTouched.size > 100) {
      const files = Array.from(session.filesTouched);
      session.filesTouched = new Set(files.slice(-100));
    }
    if (session.directoriesActive.size > 50) {
      const dirs = Array.from(session.directoriesActive);
      session.directoriesActive = new Set(dirs.slice(-50));
    }
  }

  /**
   * Track focus area for iteration detection
   */
  private trackFocusArea(
    session: SessionContext,
    toolName: string,
    toolInput: Record<string, unknown>
  ): void {
    // Determine current focus from tool use
    let currentFocus: string | null = null;

    // File-based tools indicate focus on a specific file
    if (['Read', 'Edit', 'Write'].includes(toolName)) {
      const filePath = toolInput['file_path'] as string;
      if (filePath) {
        // Focus is the filename or last path component
        const parts = filePath.split('/');
        currentFocus = parts[parts.length - 1] || filePath;
      }
    }

    // Bash commands might indicate focus area
    if (toolName === 'Bash' && typeof toolInput['command'] === 'string') {
      const cmd = toolInput['command'] as string;
      // Extract test/build/run focus
      if (cmd.includes('npm test') || cmd.includes('jest') || cmd.includes('pytest')) {
        currentFocus = 'testing';
      } else if (cmd.includes('npm run build') || cmd.includes('tsc')) {
        currentFocus = 'build';
      } else if (cmd.includes('npm start') || cmd.includes('node ')) {
        currentFocus = 'running';
      }
    }

    if (!currentFocus) return;

    // Check if focus changed
    if (session.focusArea === currentFocus) {
      session.focusAreaTurns++;
    } else {
      // Focus changed - record previous
      if (session.focusArea) {
        session.focusAreaHistory.push({
          area: session.focusArea,
          turns: session.focusAreaTurns,
          resolvedAt: Date.now(),
        });
        // Keep last 10
        if (session.focusAreaHistory.length > 10) {
          session.focusAreaHistory = session.focusAreaHistory.slice(-10);
        }
      }
      session.focusArea = currentFocus;
      session.focusAreaTurns = 1;
    }
  }

  /**
   * Detect tech stack from content
   */
  private detectTechStack(session: SessionContext, content: string): void {
    const techPatterns: Record<string, RegExp> = {
      // Languages
      'typescript': /typescript|\.tsx?|tsconfig/i,
      'javascript': /javascript|\.jsx?|package\.json/i,
      'python': /python|\.py|pip|venv|requirements\.txt/i,
      'rust': /rust|cargo|\.rs/i,
      'go': /golang|\.go|go\.mod/i,

      // Frontend
      'react': /react|jsx|tsx|use[A-Z]\w+Hook/i,
      'vue': /vue|\.vue|v-bind|v-model/i,
      'svelte': /svelte|\.svelte/i,
      'nextjs': /next\.js|nextjs|next\.config/i,

      // Backend
      'express': /express|app\.listen|router\./i,
      'fastapi': /fastapi|uvicorn|pydantic/i,
      'django': /django|wsgi|asgi/i,

      // Database
      'postgres': /postgres|psql|pg_/i,
      'mongodb': /mongodb|mongoose|mongo/i,
      'redis': /redis|redisClient/i,
      'sqlite': /sqlite|better-sqlite/i,

      // Infrastructure
      'docker': /docker|dockerfile|container/i,
      'kubernetes': /kubernetes|k8s|kubectl/i,
      'aws': /aws|s3|lambda|ec2|dynamodb/i,
    };

    for (const [tech, pattern] of Object.entries(techPatterns)) {
      if (pattern.test(content)) {
        session.techStack.add(tech);
      }
    }

    // Limit size
    if (session.techStack.size > 30) {
      const techs = Array.from(session.techStack);
      session.techStack = new Set(techs.slice(-30));
    }
  }

  private persistSession(session: SessionContext): void {
    try {
      const db = getDatabase();
      const dbSession: Session = {
        id: session.sessionId,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        projectPath: session.projectPath,
        injectionsCount: session.researchHistory.filter(r => r.injected).length,
        injectionsTokens: 0, // Would need to track this
      };
      db.upsertSession(dbSession);
    } catch (error) {
      this.logger.error('Failed to persist session', error);
    }
  }

  private startPruning(): void {
    this.pruneTimer = setInterval(() => {
      this.pruneInactiveSessions();
    }, this.PRUNE_INTERVAL_MS);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}

export function shutdownSessionManager(): void {
  if (sessionManager) {
    sessionManager.shutdown();
    sessionManager = null;
  }
}
