/**
 * HTTP Service for claude-research-team
 * Provides API endpoints and web UI dashboard
 */

// Load environment variables from .env file (must be first import)
import 'dotenv/config';

import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'http';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

import { QueueManager } from '../queue/manager.js';
import { InjectionManager } from '../injection/manager.js';
import { getDatabase, closeDatabase } from '../database/index.js';
import { getConfig, ConfigManager } from '../utils/config.js';
import { Logger, setLogLevel, setLogFile } from '../utils/logger.js';
import { getConversationAnalyzer } from '../conversation/analyzer.js';
import type { ResearchFinding } from '../types.js';
import { getSessionManager } from './session-manager.js';
import { getConversationWatcher, type WatcherDecision } from '../agents/conversation-watcher.js';
import { getAutonomousCrew } from '../crew/autonomous-crew.js';
import type {
  ServiceStatus,
  ApiResponse,
  ResearchTask,
  ResearchDepth,
} from '../types.js';

const VERSION = '1.0.0';

export class ResearchService {
  private app: express.Application;
  private server: Server;
  private wss: WebSocketServer;
  private queue: QueueManager;
  private injector: InjectionManager;
  private sessionManager = getSessionManager();
  private watcher = getConversationWatcher();
  private config: ConfigManager;
  private logger: Logger;
  private startTime: number = Date.now();
  private clients: Set<WebSocket> = new Set();

  constructor() {
    this.config = getConfig();
    this.logger = new Logger('Service');

    // Initialize logging
    setLogLevel(this.config.getValue('logLevel'));
    setLogFile(join(this.config.getDataDir(), 'logs', 'service.log'));

    // Initialize components
    this.queue = new QueueManager(this.config.getValue('queue'));
    this.injector = new InjectionManager(this.config.getValue('injection'));

    // Setup watcher events
    this.setupWatcherEvents();

    // Setup Express
    this.app = express();
    this.app.use(express.json());
    this.app.use(this.corsMiddleware.bind(this));

    // Create HTTP server
    this.server = createServer(this.app);

    // Setup WebSocket
    this.wss = new WebSocketServer({ server: this.server });
    this.setupWebSocket();

    // Setup routes
    this.setupRoutes();

    // Setup queue event forwarding
    this.setupQueueEvents();
  }

  /**
   * CORS middleware
   */
  private corsMiddleware(_req: Request, res: Response, next: NextFunction): void {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  }

  /**
   * Setup WebSocket connections
   */
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      this.logger.debug('WebSocket client connected', { totalClients: this.clients.size });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.logger.debug('WebSocket client disconnected', { totalClients: this.clients.size });
      });

      // Send initial status
      ws.send(JSON.stringify({ type: 'status', data: this.getStatus() }));
    });
  }

  /**
   * Broadcast message to all WebSocket clients
   */
  private broadcast(type: string, data: unknown): void {
    const message = JSON.stringify({ type, data });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Compute relevance of research results to the current task
   * This is a POST-research check to ensure we only inject useful info
   */
  private async computeRelevance(
    sessionId: string,
    query: string,
    summary: string
  ): Promise<number> {
    try {
      const { getSessionTracker } = await import('../context/session-tracker.js');
      const { getAIProvider } = await import('../ai/provider.js');

      const tracker = getSessionTracker();
      const ai = getAIProvider();

      const sessionSummary = tracker.getSessionSummary(sessionId);

      const prompt = `Evaluate how relevant this research result is to the current task.

## Current Task Context
${sessionSummary}

## Research Query
${query}

## Research Result Summary
${summary.slice(0, 1500)}

## Evaluation
Rate the relevance from 0.0 to 1.0:
- 1.0 = Directly answers the current question/problem
- 0.8 = Very helpful for the current task
- 0.6 = Somewhat relevant, might be useful
- 0.4 = Tangentially related
- 0.2 = Barely relevant
- 0.0 = Not relevant at all

Consider:
1. Does this help with what Claude is CURRENTLY trying to do?
2. Is this information Claude likely already knows?
3. Would injecting this be valuable or just noise?

Respond with JSON only: { "relevance": 0.0-1.0, "reason": "brief explanation" }`;

      const response = await ai.analyze(prompt);
      const jsonMatch = response.match(/\{[\s\S]*?\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return Math.min(1, Math.max(0, parsed.relevance || 0.5));
      }
    } catch (error) {
      this.logger.debug('Relevance computation failed, using default', { error });
    }

    // Default to moderate relevance if AI analysis fails
    return 0.5;
  }

  /**
   * Setup queue event forwarding to WebSocket
   */
  private setupQueueEvents(): void {
    this.queue.on('taskQueued', (task: ResearchTask) => {
      this.broadcast('taskQueued', task);
    });

    this.queue.on('taskStarted', (task: ResearchTask) => {
      this.broadcast('taskStarted', task);
    });

    this.queue.on('taskCompleted', (task: ResearchTask) => {
      this.broadcast('taskCompleted', task);
      // NOTE: Injection is handled by setupWatcherEvents with proper relevance checking
      // Do NOT inject here - it bypasses relevance threshold and causes over-injection
    });

    this.queue.on('taskFailed', (task: ResearchTask) => {
      this.broadcast('taskFailed', task);
    });
  }

  /**
   * Setup watcher events for autonomous research
   */
  // Track in-flight research to prevent duplicates
  private inFlightResearch: Map<string, Set<string>> = new Map();

  private setupWatcherEvents(): void {
    // When watcher triggers research, execute via autonomous crew
    this.watcher.on('research:triggered', async (sessionId: string, decision: WatcherDecision) => {
      if (!decision.query) return;

      // Strip years from queries - search engines handle recency automatically
      decision.query = decision.query
        .replace(/\b20(2[0-9]|1[0-9])\b/g, '') // Remove years 2010-2029
        .replace(/\s{2,}/g, ' ')  // Collapse multiple spaces
        .trim();

      // Deduplicate: Check if similar query is already in-flight for this session
      const sessionInFlight = this.inFlightResearch.get(sessionId) || new Set();
      const queryKey = decision.query.toLowerCase().trim();

      // Check for exact match OR similar in-flight queries
      for (const inFlightQuery of sessionInFlight) {
        if (inFlightQuery === queryKey || this.calculateSimilarity(inFlightQuery, queryKey) > 0.4) {
          this.logger.debug(`Skipping similar in-flight research: "${decision.query}" (similar to "${inFlightQuery}")`);
          return;
        }
      }

      // Also check for similar recent research (15 min window)
      if (this.sessionManager.hasRecentSimilarResearch(sessionId, decision.query, 900000)) { // 15 min
        this.logger.debug(`Skipping similar recent research: "${decision.query}"`);
        return;
      }

      // Mark as in-flight
      sessionInFlight.add(queryKey);
      this.inFlightResearch.set(sessionId, sessionInFlight);

      this.logger.info(`Watcher triggered research for ${sessionId}`, {
        query: decision.query,
        type: decision.researchType,
        confidence: decision.confidence,
      });

      // Create task in database to track status (for dashboard Running/Completed)
      const db = this.queue.getDatabase();
      const task = db.createTask({
        id: crypto.randomUUID(),
        query: decision.query,
        context: decision.alternativeHint,
        depth: 'quick',
        status: 'running',
        trigger: 'tool_output',  // Watcher-triggered research comes from tool output analysis
        sessionId,
        priority: decision.priority,
      });

      // Broadcast running status to dashboard
      this.broadcast('taskUpdate', { task, action: 'started' });

      try {
        // Use autonomous crew for background research
        // Always use 'quick' for background research - user can request deeper manually
        const crew = getAutonomousCrew();
        const result = await crew.explore({
          query: decision.query,
          sessionId,
          context: decision.alternativeHint,
          depth: 'quick',
        });

        // Queue injection when complete - but only if relevant to current task
        if (result.summary) {
          // Compute relevance score - how well does this help the current task?
          const relevance = await this.computeRelevance(sessionId, decision.query, result.summary);
          const relevanceThreshold = this.config.getValue('research').relevanceThreshold ?? 0.7;

          this.logger.info(`Research complete for ${sessionId}`, {
            query: decision.query,
            confidence: result.confidence,  // Source quality
            relevance: relevance,           // Task relevance
            meetsThreshold: relevance >= relevanceThreshold,
            hasPivot: !!result.pivot,
            findingId: result.findingId,
          });

          // Only queue injection if relevance meets threshold
          if (relevance >= relevanceThreshold) {
            try {
              this.sessionManager.queueInjection(sessionId, {
                summary: result.summary,
                query: decision.query,
                relevance: relevance,
                priority: decision.priority,
                findingId: result.findingId,
                sources: result.sources?.slice(0, 3).map(s => ({ title: s.title, url: s.url })),
              });
            } catch (e) {
              this.logger.error('Failed at queueInjection', e);
              throw e;
            }
          } else {
            this.logger.info(`Research not relevant enough to inject`, {
              query: decision.query,
              relevance,
              threshold: relevanceThreshold,
            });
          }

          // CRITICAL: Record research in session history to prevent duplicates
          try {
            this.sessionManager.recordResearch(
              sessionId,
              decision.query,
              result.findingId || 'unknown',
              result.confidence
            );
          } catch (e) {
            this.logger.error('Failed at recordResearch', e);
            throw e;
          }

          // Update task to completed - with detailed error tracking
          try {
            db.updateTaskStatus(task.id, 'completed', { completedAt: Date.now() });
          } catch (e) {
            this.logger.error('Failed at updateTaskStatus', e);
            throw e;
          }

          if (result.summary) {
            try {
              db.saveTaskResult(task.id, {
                summary: result.summary,
                confidence: result.confidence,
                relevance: relevance,
                sources: (result.sources || []).map(s => ({
                  title: s.title,
                  url: s.url,
                  snippet: s.snippet,
                  relevance: s.relevance ?? 0.5,
                })),
                fullContent: result.summary,
                tokensUsed: 0,
                findingId: result.findingId,
              });
            } catch (e) {
              this.logger.error('Failed at saveTaskResult', e);
              throw e;
            }
          }

          try {
            this.broadcast('taskUpdate', { task: { ...task, status: 'completed' }, action: 'completed' });
          } catch (e) {
            this.logger.error('Failed at broadcast', e);
            throw e;
          }
        } else {
          // No result - mark as failed
          db.updateTaskStatus(task.id, 'failed', { completedAt: Date.now() });
          this.broadcast('taskUpdate', { task: { ...task, status: 'failed' }, action: 'failed' });
        }
      } catch (error) {
        this.logger.error(`Background research failed for ${sessionId}`, error);
        // Update task to failed
        db.updateTaskStatus(task.id, 'failed', { completedAt: Date.now() });
        this.broadcast('taskUpdate', { task: { ...task, status: 'failed' }, action: 'failed' });
      } finally {
        // Remove from in-flight tracking
        const sessionInFlight = this.inFlightResearch.get(sessionId);
        if (sessionInFlight) {
          sessionInFlight.delete(queryKey);
          if (sessionInFlight.size === 0) {
            this.inFlightResearch.delete(sessionId);
          }
        }
      }
    });

    this.watcher.on('analysis:complete', (sessionId: string, decision: WatcherDecision) => {
      this.broadcast('watcherAnalysis', { sessionId, decision });
    });

    this.watcher.on('cooldown:active', (sessionId: string, remainingMs: number) => {
      this.logger.debug(`Cooldown active for ${sessionId}: ${remainingMs}ms`);
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // ===== Status Routes =====

    this.app.get('/api/status', (_req, res) => {
      res.json(this.successResponse(this.getStatus()));
    });

    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // ===== Research Queue Routes =====

    // Queue new research
    this.app.post('/api/research', async (req, res): Promise<void> => {
      try {
        const { query, context, depth, priority, sessionId, trigger } = req.body;

        if (!query || typeof query !== 'string') {
          res.status(400).json(this.errorResponse('Query is required'));
          return;
        }

        // Strip years from queries - search engines handle recency automatically
        const cleanQuery = query
          .replace(/\b20(2[0-9]|1[0-9])\b/g, '') // Remove years 2010-2029
          .replace(/\s{2,}/g, ' ')  // Collapse multiple spaces
          .trim();

        const task = await this.queue.queue({
          query: cleanQuery,
          context,
          depth: depth as ResearchDepth || 'medium',
          trigger: trigger || 'manual', // 'user' from dashboard, 'manual' from Claude
          sessionId,
          priority: priority || 5,
        });

        res.json(this.successResponse(task));
      } catch (error) {
        this.logger.error('Failed to queue research', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get queue stats
    this.app.get('/api/queue/stats', (_req, res) => {
      res.json(this.successResponse(this.queue.getStats()));
    });

    // Get recent tasks
    this.app.get('/api/tasks', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      const tasks = this.queue.getRecentTasks(limit);
      res.json(this.successResponse(tasks));
    });

    // Get specific task
    this.app.get('/api/tasks/:id', (req, res): void => {
      const task = this.queue.getTask(req.params.id);
      if (!task) {
        res.status(404).json(this.errorResponse('Task not found'));
        return;
      }
      res.json(this.successResponse(task));
    });

    // Alias for /api/tasks/:id - Claude often tries /api/research/:id for polling
    this.app.get('/api/research/:id', (req, res): void => {
      const task = this.queue.getTask(req.params.id);
      if (!task) {
        res.status(404).json(this.errorResponse('Research task not found'));
        return;
      }
      res.json(this.successResponse(task));
    });

    // Search tasks
    this.app.get('/api/search/tasks', (req, res): void => {
      const query = req.query.q as string;
      if (!query) {
        res.status(400).json(this.errorResponse('Query parameter q is required'));
        return;
      }
      const limit = parseInt(req.query.limit as string) || 20;
      const tasks = this.queue.searchTasks(query, limit);
      res.json(this.successResponse(tasks));
    });

    // ===== Trigger Detection Routes =====
    // Now uses ConversationWatcher for AI-powered detection

    // Quick pattern-based analysis (no Claude call)
    this.app.post('/api/analyze/quick', (req, res): void => {
      const { sessionId } = req.body;
      if (!sessionId) {
        res.status(400).json(this.errorResponse('sessionId is required'));
        return;
      }
      const result = this.watcher.quickAnalyze(sessionId);
      res.json(this.successResponse(result || { shouldResearch: false, reason: 'No patterns matched' }));
    });

    // Full AI-powered analysis
    this.app.post('/api/analyze/full', async (req, res): Promise<void> => {
      try {
        const { sessionId, eventType } = req.body;
        if (!sessionId) {
          res.status(400).json(this.errorResponse('sessionId is required'));
          return;
        }
        const result = await this.watcher.analyze(sessionId, eventType || 'user_prompt');
        res.json(this.successResponse(result));
      } catch (error) {
        this.logger.error('Analysis failed', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // ===== Injection Routes =====

    // Get injection for session
    this.app.get('/api/injection/:sessionId', (req, res) => {
      const context = req.query.context as string;
      const injection = this.injector.getInjection(req.params.sessionId, context);
      res.json(this.successResponse({ injection }));
    });

    // Get injection history
    this.app.get('/api/injection/:sessionId/history', (req, res) => {
      const history = this.injector.getHistory(req.params.sessionId);
      res.json(this.successResponse(history));
    });

    // ===== Session Routes =====

    // Register session
    this.app.post('/api/sessions', (req, res): void => {
      const { sessionId, projectPath } = req.body;
      if (!sessionId) {
        res.status(400).json(this.errorResponse('sessionId is required'));
        return;
      }

      // Create session in SessionManager (in-memory for injections)
      this.sessionManager.getOrCreateSession(sessionId, projectPath);

      // Also persist to database
      const db = getDatabase();
      db.upsertSession({
        id: sessionId,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        projectPath,
        injectionsCount: 0,
        injectionsTokens: 0,
      });

      res.json(this.successResponse({ sessionId }));
    });

    // End session
    this.app.post('/api/sessions/:sessionId/end', (req, res) => {
      const { sessionId } = req.params;
      const analyzer = getConversationAnalyzer();
      analyzer.endSession(sessionId);
      res.json(this.successResponse({ sessionId, ended: true }));
    });

    // Get active sessions
    this.app.get('/api/sessions', (req, res) => {
      const sinceMs = parseInt(req.query.since as string) || 3600000;
      const db = getDatabase();
      const sessions = db.getActiveSessions(sinceMs);
      res.json(this.successResponse(sessions));
    });

    // Debug: Get session state from SessionManager (in-memory)
    this.app.get('/api/sessions/:sessionId/debug', (req, res) => {
      const session = this.sessionManager.getSession(req.params.sessionId);
      if (!session) {
        res.status(404).json(this.errorResponse('Session not found in memory'));
        return;
      }
      res.json(this.successResponse({
        sessionId: session.sessionId,
        pendingInjections: session.pendingInjections.length,
        injectionDetails: session.pendingInjections.map(i => ({
          query: i.query,
          queuedAt: i.queuedAt,
          findingId: i.findingId,
        })),
        messageCount: session.messageCount,
        isActive: session.isActive,
      }));
    });

    // ===== Conversation Streaming Routes =====
    // These endpoints receive streaming data from hooks

    // Process user prompt from UserPromptSubmit hook
    this.app.post('/api/conversation/user-prompt', async (req, res) => {
      try {
        const { sessionId, prompt, projectPath } = req.body;
        if (!sessionId || !prompt) {
          res.status(400).json(this.errorResponse('sessionId and prompt required'));
          return;
        }

        // Use SessionManager to track the prompt
        this.sessionManager.addUserPrompt(sessionId, prompt, projectPath);

        // Try quick analysis first (pattern-based, no Claude call)
        let decision = this.watcher.quickAnalyze(sessionId);

        // If no quick match, run full analysis with Claude
        if (!decision) {
          decision = await this.watcher.analyze(sessionId, 'user_prompt');
        }

        // Also maintain legacy analyzer for backward compatibility
        const analyzer = getConversationAnalyzer();
        const opportunity = analyzer.processUserPrompt(sessionId, prompt, projectPath);

        // Combine decisions - prefer watcher if confident
        const shouldResearch = decision?.shouldResearch ||
          (opportunity.shouldResearch && opportunity.confidence > 0.6);
        const query = decision?.query || opportunity.query;

        if (shouldResearch && query) {
          analyzer.markResearchPerformed(sessionId);
          // Watcher events will handle the research execution
        }

        res.json(this.successResponse({
          researchQueued: shouldResearch,
          queuedQuery: query,
          confidence: decision?.confidence || opportunity.confidence,
          reason: decision?.reason || opportunity.reason,
          researchType: decision?.researchType || 'direct',
        }));
      } catch (error) {
        this.logger.error('Failed to process user prompt', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Process tool use from PostToolUse hook
    // CRITICAL: Must respond quickly (<1s) to not block Claude
    this.app.post('/api/conversation/tool-use', (req, res) => {
      try {
        const { sessionId, toolName, toolInput, toolOutput, projectPath } = req.body;
        if (!sessionId || !toolName) {
          res.status(400).json(this.errorResponse('sessionId and toolName required'));
          return;
        }

        // Use SessionManager to track the tool use (fast, in-memory)
        this.sessionManager.addToolUse(sessionId, toolName, toolInput || {}, toolOutput || '', projectPath);

        // Check for pending injections from previous research (fast, in-memory)
        const pendingInjection = this.sessionManager.popInjection(sessionId);
        let injection: string | null = null;

        if (pendingInjection) {
          // Format injection with pivot info if present
          injection = this.formatInjection(pendingInjection);

          // Log injection for dashboard visibility
          if (pendingInjection.findingId) {
            const db = this.queue.getDatabase();
            db.logInjection({
              findingId: pendingInjection.findingId,
              sessionId,
              injectedAt: Date.now(),
              injectionLevel: 1,
              triggerReason: 'proactive',
              followupInjected: false,
              resolvedIssue: false,
            });
            this.logger.info('Injection delivered', {
              sessionId,
              query: pendingInjection.query,
              findingId: pendingInjection.findingId,
            });
            // Broadcast injection event to dashboard
            this.broadcast('injection', {
              sessionId,
              query: pendingInjection.query,
              summary: pendingInjection.summary.slice(0, 200),
              injectedAt: Date.now(),
            });
          }
        } else {
          // PAST RESEARCH RE-INJECTION: Check if relevant past findings exist
          // This helps when Claude "forgot" something already researched
          try {
            const db = this.queue.getDatabase();
            const context = this.sessionManager.getWatcherContext(sessionId);
            if (context) {
              // Build a search query from recent context
              const recentText = context.recentMessages
                .slice(-3)
                .map(m => m.content)
                .join(' ')
                .slice(0, 500);

              if (recentText.length > 50) {
                // Search for relevant past findings
                const relevantFindings = db.searchFindings(recentText, 3);

                // Check if any finding is recent enough and relevant
                const oneHourAgo = Date.now() - 3600000;
                const recentRelevant = relevantFindings.find(f =>
                  f.createdAt > oneHourAgo && f.confidence > 0.7
                );

                if (recentRelevant) {
                  // Format a shorter "remembered" injection
                  const keyPoints = recentRelevant.keyPoints?.slice(0, 3) || [];
                  const summary = keyPoints.length > 0
                    ? keyPoints.map(p => `- ${p}`).join('\n')
                    : recentRelevant.summary.slice(0, 300);

                  injection = `<research-context query="${recentRelevant.query}" remembered="true">
${summary}

_Previously researched - use /research-detail ${recentRelevant.id} for more_
</research-context>`;

                  this.logger.info('Past research re-injected', {
                    sessionId,
                    query: recentRelevant.query,
                    findingId: recentRelevant.id,
                  });

                  // Log the re-injection
                  db.logInjection({
                    findingId: recentRelevant.id,
                    sessionId,
                    injectedAt: Date.now(),
                    injectionLevel: 1,
                    triggerReason: 'proactive',
                    followupInjected: false,
                    resolvedIssue: false,
                  });
                }
              }
            }
          } catch (e) {
            this.logger.debug('Past research re-injection check failed', e);
          }
        }

        // Also check legacy analyzer for injection (fast, in-memory)
        const analyzer = getConversationAnalyzer();
        const { opportunity, injection: legacyInjection } = analyzer.processToolUse(
          sessionId,
          toolName,
          toolInput || {},
          toolOutput || '',
          projectPath
        );

        // Use new injection if available, otherwise fallback to legacy
        injection = injection || legacyInjection;

        // RESPOND IMMEDIATELY - Don't block on slow analysis
        // NOTE: We removed checkProactiveTriggers() - dual trigger was causing duplicate research spam
        const injectionConfig = this.config.getValue('injection');
        res.json(this.successResponse({
          injection,
          injectionQuery: pendingInjection?.query,  // For visible display
          showInConversation: injectionConfig?.showInConversation ?? false,
          researchQueued: opportunity.shouldResearch && opportunity.confidence > 0.6,
          queuedQuery: opportunity.query,
          researchType: 'proactive',
          pivot: null,
        }));

        // BACKGROUND: Run watcher analysis after response sent (single trigger path)
        // This won't block the hook
        setImmediate(async () => {
          try {
            // Only run watcher analysis - single trigger path prevents duplicates
            const decision = await this.watcher.analyze(sessionId, 'tool_output');
            if (decision.shouldResearch && decision.query) {
              analyzer.markResearchPerformed(sessionId);
              this.watcher.emit('research:triggered', sessionId, decision);
            }
          } catch (err) {
            this.logger.error('Background analysis failed', err);
          }
        });
      } catch (error) {
        this.logger.error('Failed to process tool use', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get session conversation stats
    this.app.get('/api/conversation/:sessionId/stats', (req, res) => {
      const analyzer = getConversationAnalyzer();
      const stats = analyzer.getSessionStats(req.params.sessionId);
      if (!stats) {
        res.status(404).json(this.errorResponse('Session not found'));
        return;
      }
      res.json(this.successResponse(stats));
    });

    // ===== Memory/Knowledge Routes =====

    // Get research stats (from local database)
    this.app.get('/api/memory/stats', async (_req, res) => {
      try {
        const db = this.queue.getDatabase();
        const queueStats = db.getQueueStats();
        const sourceStats = db.getSourceQualityStats();
        const recentFindings = db.getRecentFindings(10);

        res.json(this.successResponse({
          totalResearch: queueStats.totalProcessed,
          recentFindings: recentFindings.length,
          sourceStats,
          byStatus: {
            queued: queueStats.queued,
            running: queueStats.running,
            completed: queueStats.completed,
            failed: queueStats.failed,
          },
        }));
      } catch (error) {
        this.logger.error('Failed to get memory stats', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Search past research (from local database)
    this.app.get('/api/memory/search', async (req, res) => {
      try {
        const query = req.query.q as string;
        if (!query) {
          res.status(400).json(this.errorResponse('Query parameter q is required'));
          return;
        }
        const limit = parseInt(req.query.limit as string) || 10;
        const db = this.queue.getDatabase();
        const results = db.searchFindings(query, limit);
        res.json(this.successResponse(results));
      } catch (error) {
        this.logger.error('Failed to search memory', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Find related research (from local database)
    this.app.get('/api/memory/related', async (req, res) => {
      try {
        const query = req.query.q as string;
        if (!query) {
          res.status(400).json(this.errorResponse('Query parameter q is required'));
          return;
        }
        const limit = parseInt(req.query.limit as string) || 5;
        const db = this.queue.getDatabase();
        const results = db.searchFindings(query, limit);
        res.json(this.successResponse(results));
      } catch (error) {
        this.logger.error('Failed to find related research', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get research by domain
    this.app.get('/api/memory/topics', async (req, res) => {
      try {
        const db = this.queue.getDatabase();
        const domain = req.query.domain as string;
        const limit = parseInt(req.query.limit as string) || 20;

        const findings = domain
          ? db.getFindingsByDomain(domain, limit)
          : db.getRecentFindings(limit);

        // Group by domain
        const byDomain: Record<string, number> = {};
        for (const f of findings) {
          const d = f.domain || 'general';
          byDomain[d] = (byDomain[d] || 0) + 1;
        }

        res.json(this.successResponse({
          findings: findings.length,
          byDomain,
          recent: findings.slice(0, 5).map((f: ResearchFinding) => ({
            query: f.query,
            domain: f.domain,
            confidence: f.confidence,
            createdAt: f.createdAt,
          })),
        }));
      } catch (error) {
        this.logger.error('Failed to get topics', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get source quality data
    this.app.get('/api/memory/gaps', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 10;
        const db = this.queue.getDatabase();

        // Get low-quality sources as "gaps"
        const stats = db.getSourceQualityStats();
        const reliableSources = db.getReliableSources(undefined, limit);

        res.json(this.successResponse({
          sourceStats: stats,
          reliableSources,
        }));
      } catch (error) {
        this.logger.error('Failed to get knowledge gaps', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Check for existing research (from local database)
    this.app.get('/api/memory/check', async (req, res) => {
      try {
        const query = req.query.q as string;
        if (!query) {
          res.status(400).json(this.errorResponse('Query parameter q is required'));
          return;
        }
        const db = this.queue.getDatabase();
        const results = db.searchFindings(query, 5);

        res.json(this.successResponse({
          exists: results.length > 0,
          related: results,
          suggestion: results.length > 0
            ? `Found ${results.length} related findings. Consider reviewing before new research.`
            : 'No related research found.',
        }));
      } catch (error) {
        this.logger.error('Failed to check existing research', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get recent autonomous findings (for dashboard visibility)
    // Supports filtering by project: /api/findings?project=/path/to/project
    this.app.get('/api/findings', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 20;
        const projectPath = req.query.project as string | undefined;
        const domain = req.query.domain as string | undefined;
        const db = this.queue.getDatabase();

        const findings = db.getRecentFindingsFiltered({ limit, projectPath, domain });
        res.json(this.successResponse(findings));
      } catch (error) {
        this.logger.error('Failed to get findings', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get a specific finding by ID (for /research-detail skill)
    this.app.get('/api/findings/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const db = this.queue.getDatabase();
        const finding = db.getFinding(id);

        if (!finding) {
          res.status(404).json(this.errorResponse(`Finding not found: ${id}`));
          return;
        }

        res.json(this.successResponse(finding));
      } catch (error) {
        this.logger.error('Failed to get finding', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Search unified knowledge base (claude-mem + research)
    // NOTE: This route must come BEFORE /api/knowledge/:id to avoid matching "search" as an ID
    this.app.get('/api/knowledge/search', async (req, res) => {
      try {
        const query = req.query.q as string;
        if (!query) {
          res.status(400).json(this.errorResponse('Query parameter "q" required'));
          return;
        }

        const limit = parseInt(req.query.limit as string) || 10;
        const project = req.query.project as string | undefined;

        const db = this.queue.getDatabase();
        const claudeMemAdapter = db.getClaudeMemAdapter();

        if (!claudeMemAdapter.isReady()) {
          res.status(503).json(this.errorResponse('claude-mem not available'));
          return;
        }

        const results = claudeMemAdapter.searchUnifiedKnowledge(query, {
          limit,
          project,
        });

        res.json(this.successResponse(results));
      } catch (error) {
        this.logger.error('Failed to search knowledge', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get a specific observation from claude-mem by ID
    // For unified knowledge lookup (memory + research)
    this.app.get('/api/knowledge/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          res.status(400).json(this.errorResponse('Invalid observation ID'));
          return;
        }

        const db = this.queue.getDatabase();
        const claudeMemAdapter = db.getClaudeMemAdapter();

        if (!claudeMemAdapter.isReady()) {
          res.status(503).json(this.errorResponse('claude-mem not available'));
          return;
        }

        const observation = claudeMemAdapter.getObservation(id);
        if (!observation) {
          res.status(404).json(this.errorResponse(`Observation not found: ${id}`));
          return;
        }

        res.json(this.successResponse(observation));
      } catch (error) {
        this.logger.error('Failed to get knowledge', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get all projects with research findings
    this.app.get('/api/projects', async (_req, res) => {
      try {
        const db = this.queue.getDatabase();
        const projects = db.getProjectsWithResearch();
        res.json(this.successResponse(projects));
      } catch (error) {
        this.logger.error('Failed to get projects', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get research stats for a specific project
    this.app.get('/api/projects/stats', async (req, res) => {
      try {
        const projectPath = req.query.path as string;
        if (!projectPath) {
          res.status(400).json(this.errorResponse('Project path required'));
          return;
        }
        const db = this.queue.getDatabase();
        const stats = db.getProjectResearchStats(projectPath);
        res.json(this.successResponse(stats));
      } catch (error) {
        this.logger.error('Failed to get project stats', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // Get recent injections (for dashboard visibility)
    this.app.get('/api/injections', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 20;
        const sessionId = req.query.sessionId as string | undefined;
        const projectPath = req.query.project as string | undefined;
        const db = this.queue.getDatabase();
        const injections = db.getRecentInjections(limit, { sessionId, projectPath });
        res.json(this.successResponse(injections));
      } catch (error) {
        this.logger.error('Failed to get injections', error);
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // ===== Config Routes =====

    this.app.get('/api/config', (_req, res) => {
      res.json(this.successResponse(this.config.get()));
    });

    this.app.patch('/api/config', (req, res) => {
      try {
        this.config.update(req.body);
        res.json(this.successResponse(this.config.get()));
      } catch (error) {
        res.status(400).json(this.errorResponse(String(error)));
      }
    });

    // ===== Settings API (for dashboard) =====

    this.app.get('/api/settings', (_req, res) => {
      const config = this.config.get();
      // Check for Gemini API key in env or config
      const geminiKeyFromEnv = process.env.GEMINI_API_KEY;
      const geminiAvailable = !!(geminiKeyFromEnv || config.aiProvider.geminiApiKey);

      res.json(this.successResponse({
        research: config.research,
        aiProvider: {
          provider: config.aiProvider.provider,
          claudeModel: config.aiProvider.claudeModel,
          geminiModel: config.aiProvider.geminiModel,
        },
        geminiAvailable,
      }));
    });

    this.app.post('/api/settings', (req, res) => {
      try {
        const { research, aiProvider } = req.body;

        // Validate research settings
        if (research) {
          if (typeof research.autonomousEnabled !== 'boolean') {
            throw new Error('autonomousEnabled must be boolean');
          }
          if (research.confidenceThreshold < 0.5 || research.confidenceThreshold > 0.95) {
            throw new Error('confidenceThreshold must be between 0.5 and 0.95');
          }
          if (research.relevanceThreshold !== undefined &&
              (research.relevanceThreshold < 0.5 || research.relevanceThreshold > 0.95)) {
            throw new Error('relevanceThreshold must be between 0.5 and 0.95');
          }
          if (![30000, 60000, 120000, 300000].includes(research.sessionCooldownMs)) {
            throw new Error('Invalid sessionCooldownMs value');
          }
          if (research.maxResearchPerHour < 5 || research.maxResearchPerHour > 100) {
            throw new Error('maxResearchPerHour must be between 5 and 100');
          }
          // Merge with existing config to preserve fields not sent
          const currentResearch = this.config.getValue('research');
          this.config.setValue('research', { ...currentResearch, ...research });
        }

        // Validate AI provider settings
        if (aiProvider) {
          const validProviders = ['claude', 'gemini'];
          if (!validProviders.includes(aiProvider.provider)) {
            throw new Error('provider must be claude or gemini');
          }

          const validClaudeModels = ['haiku', 'sonnet', 'opus'];
          if (aiProvider.claudeModel && !validClaudeModels.includes(aiProvider.claudeModel)) {
            throw new Error('claudeModel must be haiku, sonnet, or opus');
          }

          const validGeminiModels = ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-pro'];
          if (aiProvider.geminiModel && !validGeminiModels.includes(aiProvider.geminiModel)) {
            throw new Error('Invalid geminiModel');
          }

          const currentAiConfig = this.config.getValue('aiProvider');
          const newAiConfig = {
            ...currentAiConfig,
            provider: aiProvider.provider,
            claudeModel: aiProvider.claudeModel || currentAiConfig.claudeModel,
            geminiModel: aiProvider.geminiModel || currentAiConfig.geminiModel,
          };

          this.config.setValue('aiProvider', newAiConfig);
        }

        // Notify watcher of config changes
        this.watcher.updateConfig(this.config.get());

        res.json(this.successResponse({ message: 'Settings saved' }));
      } catch (error) {
        res.status(400).json(this.errorResponse(String(error)));
      }
    });

    this.app.post('/api/settings/reset', (_req, res) => {
      try {
        this.config.reset();
        this.watcher.updateConfig(this.config.get());
        res.json(this.successResponse({ message: 'Settings reset to defaults' }));
      } catch (error) {
        res.status(500).json(this.errorResponse(String(error)));
      }
    });

    // ===== Web UI =====

    this.app.get('/', (_req, res) => {
      res.send(this.getDashboardHTML());
    });

    // Serve static assets if they exist
    const staticPath = join(this.config.getDataDir(), 'static');
    if (existsSync(staticPath)) {
      this.app.use('/static', express.static(staticPath));
    }

    // Serve assets directory (logos, etc.)
    // Use __dirname equivalent for ES modules to find assets relative to compiled server.js
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const assetsPath = join(__dirname, '..', '..', 'assets');
    if (existsSync(assetsPath)) {
      this.app.use('/assets', express.static(assetsPath));
      this.logger.debug(`Serving assets from: ${assetsPath}`);
    }
  }

  /**
   * Get service status
   */
  private getStatus(): ServiceStatus {
    return {
      running: true,
      uptime: Date.now() - this.startTime,
      version: VERSION,
      queue: this.queue.getStats(),
      activeSessions: getDatabase().getActiveSessions().length,
      config: {
        port: this.config.getValue('port'),
        logLevel: this.config.getValue('logLevel'),
        claudeMemSync: this.config.getValue('claudeMemSync'),
      },
    };
  }

  /**
   * Start the service
   */
  async start(): Promise<void> {
    const port = this.config.getValue('port');

    // Start queue processor
    this.queue.start();

    // Start HTTP server
    await new Promise<void>((resolve) => {
      this.server.listen(port, () => {
        this.logger.info(`Research service started on port ${port}`);
        this.logger.info(`Dashboard: http://localhost:${port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping research service...');

    // Stop queue
    this.queue.stop();

    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Close database
    closeDatabase();

    this.logger.info('Research service stopped');
  }

  /**
   * Success response helper
   */
  private successResponse<T>(data: T): ApiResponse<T> {
    return { success: true, data };
  }

  /**
   * Error response helper
   */
  private errorResponse(error: string): ApiResponse {
    return { success: false, error };
  }

  /**
   * Calculate Jaccard similarity between two strings
   * Used for deduplicating similar research queries
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * Format injection content with pivot handling and sources
   */
  private formatInjection(pending: {
    summary: string;
    query: string;
    relevance: number;
    findingId?: string;
    pivot?: {
      alternative: string;
      reason: string;
      urgency: 'low' | 'medium' | 'high';
    };
    sources?: Array<{ title: string; url: string }>;
  }): string {
    const parts: string[] = [];

    parts.push(`<research-context query="${pending.query}">`);
    parts.push(pending.summary);

    // Add sources if present
    if (pending.sources && pending.sources.length > 0) {
      parts.push('');
      parts.push('**Sources:**');
      for (const source of pending.sources) {
        parts.push(`- [${source.title}](${source.url})`);
      }
    }

    // Add pivot suggestion if present
    if (pending.pivot) {
      parts.push('');
      const urgencyEmoji = pending.pivot.urgency === 'high' ? '🚨' :
                          pending.pivot.urgency === 'medium' ? '💡' : 'ℹ️';
      parts.push(`${urgencyEmoji} **Alternative Approach Detected:**`);
      parts.push(`${pending.pivot.alternative}`);
      parts.push(`_Reason: ${pending.pivot.reason}_`);
    }

    // Add findingId for progressive disclosure (allows requesting more detail)
    if (pending.findingId) {
      parts.push('');
      parts.push(`_More detail available: use /research-detail ${pending.findingId}_`);
    }

    parts.push('</research-context>');

    return parts.join('\n');
  }

  /**
   * Generate dashboard HTML
   */
  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Research Team</title>
  <link rel="icon" type="image/webp" href="/assets/logo.webp">
  <link rel="apple-touch-icon" href="/assets/logo.webp">
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --border: #e5e7eb;
      --text: #1f2937;
      --text-muted: #6b7280;
      --primary: #f97316;
      --primary-light: #fff7ed;
      --success: #22c55e;
      --success-light: #f0fdf4;
      --warning: #eab308;
      --warning-light: #fefce8;
      --error: #ef4444;
      --error-light: #fef2f2;
      --info: #3b82f6;
      --info-light: #eff6ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }

    /* Header */
    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 1rem 2rem;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-inner {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-left: 0;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--primary);
      text-decoration: none;
      margin-left: -1rem;
    }
    .logo-icon {
      width: 80px;
      height: 80px;
      object-fit: contain;
      transition: opacity 0.3s ease;
    }
    .header-stats {
      display: flex;
      gap: 1.5rem;
      font-size: 0.875rem;
    }
    .header-stat {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }
    .header-stat-value {
      font-weight: 600;
      min-width: 1.5rem;
    }
    .header-stat-label { color: var(--text-muted); }

    /* Main content */
    .main {
      max-width: 900px;
      margin: 0 auto;
      padding: 1.5rem 2rem;
    }

    /* Research form */
    .research-form {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      display: flex;
      gap: 0.75rem;
    }
    .research-input {
      flex: 1;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .research-input:focus {
      border-color: var(--primary);
    }
    .depth-select {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      background: var(--surface);
      cursor: pointer;
      min-width: 110px;
    }
    .submit-btn {
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 0.75rem 1.5rem;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .submit-btn:hover { opacity: 0.9; }

    /* Feed */
    .feed { display: flex; flex-direction: column; gap: 1rem; }

    /* Task card */
    .task-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      transition: box-shadow 0.2s;
    }
    .task-card:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }
    .task-card-header {
      padding: 1rem 1.25rem;
      display: flex;
      align-items: flex-start;
      gap: 1rem;
    }
    .task-badge {
      padding: 0.25rem 0.625rem;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.025em;
      flex-shrink: 0;
    }
    .task-badge.queued { background: var(--warning-light); color: #a16207; }
    .task-badge.running { background: var(--info-light); color: #1d4ed8; }
    .task-badge.completed { background: var(--success-light); color: #15803d; }
    .task-badge.failed { background: var(--error-light); color: #b91c1c; }
    .task-badge.user { background: #f0f9ff; color: #0369a1; }
    .task-badge.manual { background: #fef3c7; color: #b45309; }
    .task-badge.autonomous { background: #faf5ff; color: #7c3aed; }
    .task-badge.injected { background: #ecfdf5; color: #059669; }
    .task-badge.injected.memory-only { background: #fef3c7; color: #92400e; }
    .task-badge.injected.combined { background: #dbeafe; color: #1e40af; }
    .task-badge.injected.warning { background: #fef2f2; color: #b91c1c; }

    .task-card.user { border-left: 3px solid #0369a1; }
    .task-card.manual { border-left: 3px solid #b45309; }
    .task-card.autonomous { border-left: 3px solid #7c3aed; }
    .task-card.injected { border-left: 3px solid #059669; }
    .task-card.injected.memory-only { border-left-color: #d97706; }
    .task-card.injected.combined { border-left-color: #2563eb; }
    .task-card.injected.warning { border-left-color: #dc2626; }

    .filter-bar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
      padding: 0.5rem;
      background: var(--bg);
      border-radius: 8px;
    }
    .filter-btn {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--card);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.15s;
    }
    .filter-btn:hover { background: var(--bg); }
    .filter-btn.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }

    .task-main { flex: 1; min-width: 0; }
    .task-query {
      font-size: 1rem;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 0.25rem;
      word-wrap: break-word;
    }
    .task-meta {
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .task-depth {
      background: var(--bg);
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
      font-size: 0.7rem;
      text-transform: uppercase;
    }
    .task-actions {
      display: flex;
      gap: 0.5rem;
    }
    .task-action-btn {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s;
    }
    .task-action-btn:hover {
      background: var(--primary-light);
      border-color: var(--primary);
      color: var(--primary);
    }
    .task-action-btn.active {
      background: var(--primary-light);
      border-color: var(--primary);
      color: var(--primary);
    }
    .task-action-btn.running-placeholder {
      cursor: not-allowed;
      opacity: 0.7;
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }
    .btn-spinner {
      width: 10px;
      height: 10px;
      border: 2px solid var(--text-muted);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    /* Task content (expandable) */
    .task-content {
      display: none;
      padding: 0 1.25rem 1.25rem;
      border-top: 1px solid var(--border);
      margin-top: 0;
    }
    .task-content.expanded { display: block; }

    .task-summary {
      padding: 1rem;
      background: var(--bg);
      border-radius: 8px;
      margin-top: 1rem;
      font-size: 0.9rem;
      line-height: 1.7;
    }
    .task-summary h4 {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      letter-spacing: 0.05em;
    }
    .findings-content p {
      margin: 0 0 0.75rem 0;
    }
    .findings-header {
      display: block;
      color: var(--primary);
      margin: 1rem 0 0.5rem 0;
      font-size: 0.85rem;
    }
    .findings-list {
      margin: 0.5rem 0;
      padding-left: 1.25rem;
    }
    .findings-list li {
      margin: 0.4rem 0;
      line-height: 1.5;
    }

    .task-sources {
      margin-top: 1rem;
    }
    .task-sources h4 {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
      letter-spacing: 0.05em;
    }
    .source-item {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg);
      border-radius: 8px;
      margin-bottom: 0.5rem;
      text-decoration: none;
      transition: background 0.2s;
    }
    .source-item:hover { background: var(--primary-light); }
    .source-favicon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: var(--border);
      flex-shrink: 0;
    }
    .source-info { flex: 1; min-width: 0; }
    .source-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 0.125rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .source-url {
      font-size: 0.75rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .source-relevance {
      font-size: 0.7rem;
      color: var(--success);
      background: var(--success-light);
      padding: 0.125rem 0.375rem;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .confidence-bar {
      margin-top: 1rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .confidence-bar label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
    }
    .confidence-track {
      flex: 1;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    .confidence-fill {
      height: 100%;
      background: var(--success);
      border-radius: 3px;
      transition: width 0.3s;
    }
    .confidence-value {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text);
      min-width: 2.5rem;
    }

    /* Dual score display (Quality + Relevance) */
    .scores-container {
      margin-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .score-bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .score-bar label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      min-width: 60px;
    }
    .score-track {
      flex: 1;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    .score-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }
    .score-fill.quality-fill {
      background: var(--success);
    }
    .score-fill.relevance-fill.high {
      background: #10b981;
    }
    .score-fill.relevance-fill.medium {
      background: #f59e0b;
    }
    .score-fill.relevance-fill.low {
      background: #ef4444;
    }
    .score-value {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text);
      min-width: 2.5rem;
    }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 3rem;
      color: var(--text-muted);
    }
    .empty-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    /* Loading spinner */
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      margin-right: 0.5rem;
    }

    /* Settings Panel */
    .settings-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 1.5rem;
      overflow: hidden;
    }
    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      cursor: pointer;
      user-select: none;
      transition: background 0.2s;
    }
    .settings-header:hover {
      background: var(--bg);
    }
    .settings-title {
      font-weight: 600;
      font-size: 0.95rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .settings-toggle {
      font-size: 0.8rem;
      color: var(--text-muted);
      transition: transform 0.2s;
    }
    .settings-toggle.open {
      transform: rotate(180deg);
    }
    .settings-body {
      display: none;
      padding: 0 1.25rem 1.25rem;
      border-top: 1px solid var(--border);
    }
    .settings-body.open {
      display: block;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      padding-top: 1rem;
    }
    .settings-section {
      background: var(--bg);
      border-radius: 8px;
      padding: 1rem;
    }
    .settings-section h4 {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
      letter-spacing: 0.05em;
    }
    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
    }
    .setting-label {
      font-size: 0.875rem;
      color: var(--text);
    }
    .setting-sublabel {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.125rem;
    }
    .setting-input {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .setting-input input[type="range"] {
      width: 100px;
      accent-color: var(--primary);
    }
    .setting-input input[type="number"] {
      width: 70px;
      padding: 0.375rem 0.5rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.875rem;
      text-align: center;
    }
    .setting-input select {
      padding: 0.375rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.875rem;
      background: var(--surface);
    }
    .setting-value {
      font-size: 0.8rem;
      color: var(--primary);
      font-weight: 600;
      min-width: 3rem;
      text-align: right;
    }
    /* Toggle switch */
    .toggle {
      position: relative;
      width: 44px;
      height: 24px;
    }
    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: var(--border);
      transition: 0.3s;
      border-radius: 24px;
    }
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: 0.3s;
      border-radius: 50%;
    }
    .toggle input:checked + .toggle-slider {
      background-color: var(--success);
    }
    .toggle input:checked + .toggle-slider:before {
      transform: translateX(20px);
    }
    .settings-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }
    .settings-btn {
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .settings-btn.primary {
      background: var(--primary);
      color: white;
      border: none;
    }
    .settings-btn.primary:hover {
      opacity: 0.9;
    }
    .settings-btn.secondary {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .settings-btn.secondary:hover {
      background: var(--bg);
    }
    .settings-status {
      font-size: 0.8rem;
      padding: 0.375rem 0.75rem;
      border-radius: 4px;
      display: none;
    }
    .settings-status.success {
      display: inline-block;
      background: var(--success-light);
      color: var(--success);
    }
    .settings-status.error {
      display: inline-block;
      background: var(--error-light);
      color: var(--error);
    }
    .api-key-input {
      width: 100%;
      padding: 0.5rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.8rem;
      font-family: monospace;
      margin-top: 0.5rem;
    }
    .api-key-input::placeholder {
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <a href="/" class="logo">
        <img id="logo-img" src="/assets/logo.webp" alt="Claude Research Team" class="logo-icon">
        claude-research-team
      </a>
      <div class="header-stats">
        <div class="header-stat">
          <span class="header-stat-value" id="stat-queued">0</span>
          <span class="header-stat-label">queued</span>
        </div>
        <div class="header-stat">
          <span class="header-stat-value" id="stat-running">0</span>
          <span class="header-stat-label">running</span>
        </div>
        <div class="header-stat">
          <span class="header-stat-value" id="stat-completed">0</span>
          <span class="header-stat-label">completed</span>
        </div>
        <div class="header-stat" style="border-left: 1px solid var(--border); padding-left: 1rem; margin-left: 0.5rem;">
          <span class="header-stat-value" id="stat-findings">0</span>
          <span class="header-stat-label">findings</span>
        </div>
        <div class="header-stat">
          <span class="header-stat-value" id="stat-injections" style="color: var(--success);">0</span>
          <span class="header-stat-label">injected</span>
        </div>
      </div>
    </div>
  </header>

  <main class="main">
    <form class="research-form" id="research-form">
      <input type="text" class="research-input" id="query-input"
             placeholder="What would you like to research?" required>
      <select class="depth-select" id="depth-select">
        <option value="quick">Quick (~15s)</option>
        <option value="medium" selected>Medium (~30s)</option>
        <option value="deep">Deep (~60s)</option>
      </select>
      <button type="submit" class="submit-btn">Research</button>
    </form>

    <!-- Settings Panel -->
    <div class="settings-panel" id="settings-panel">
      <div class="settings-header" onclick="toggleSettings()">
        <span class="settings-title">Settings</span>
        <span class="settings-toggle" id="settings-toggle-icon">&#9660;</span>
      </div>
      <div class="settings-body" id="settings-body">
        <div class="settings-grid">
          <!-- Autonomous Research Section -->
          <div class="settings-section">
            <h4>Autonomous Research</h4>
            <div class="setting-row">
              <div>
                <div class="setting-label">Enable Autonomous</div>
                <div class="setting-sublabel">Auto-research during Claude sessions</div>
              </div>
              <label class="toggle">
                <input type="checkbox" id="setting-autonomous" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Confidence Threshold</div>
                <div class="setting-sublabel">Minimum confidence to trigger</div>
              </div>
              <div class="setting-input">
                <input type="range" id="setting-confidence" min="50" max="95" step="5" value="85">
                <span class="setting-value" id="confidence-value">85%</span>
              </div>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Relevance Threshold</div>
                <div class="setting-sublabel">Minimum relevance to inject</div>
              </div>
              <div class="setting-input">
                <input type="range" id="setting-relevance" min="50" max="95" step="5" value="70">
                <span class="setting-value" id="relevance-value">70%</span>
              </div>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Session Cooldown</div>
                <div class="setting-sublabel">Min time between researches</div>
              </div>
              <div class="setting-input">
                <select id="setting-cooldown">
                  <option value="30000">30 sec</option>
                  <option value="60000" selected>1 min</option>
                  <option value="120000">2 min</option>
                  <option value="300000">5 min</option>
                </select>
              </div>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Max Per Hour</div>
                <div class="setting-sublabel">Global hourly limit</div>
              </div>
              <div class="setting-input">
                <input type="number" id="setting-max-hour" min="5" max="100" value="20">
              </div>
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Show Injections</div>
                <div class="setting-sublabel">Display injections in conversation</div>
              </div>
              <label class="toggle">
                <input type="checkbox" id="setting-show-injections">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- AI Provider Section -->
          <div class="settings-section">
            <h4>AI Provider</h4>
            <div class="setting-row">
              <div>
                <div class="setting-label">Provider</div>
                <div class="setting-sublabel">Which AI to use for synthesis</div>
              </div>
              <div class="setting-input">
                <select id="setting-provider">
                  <option value="claude" selected>Claude (your account)</option>
                  <option value="gemini" id="gemini-option" style="display: none;">Gemini (free API)</option>
                </select>
              </div>
            </div>
            <div id="claude-model-settings">
              <div class="setting-row">
                <div>
                  <div class="setting-label">Claude Model</div>
                  <div class="setting-sublabel">Balance speed vs capability</div>
                </div>
                <div class="setting-input">
                  <select id="setting-claude-model">
                    <option value="haiku" selected>Haiku (fastest)</option>
                    <option value="sonnet">Sonnet (balanced)</option>
                    <option value="opus">Opus (most capable)</option>
                  </select>
                </div>
              </div>
            </div>
            <div id="gemini-settings" style="display: none;">
              <div class="setting-row">
                <div>
                  <div class="setting-label">Gemini Model</div>
                  <div class="setting-sublabel">Select Gemini model</div>
                </div>
                <div class="setting-input">
                  <select id="setting-gemini-model">
                    <option value="gemini-2.0-flash-exp" selected>2.0 Flash (experimental)</option>
                    <option value="gemini-1.5-flash">1.5 Flash (stable)</option>
                    <option value="gemini-1.5-pro">1.5 Pro (advanced)</option>
                  </select>
                </div>
              </div>
            </div>
            <div class="setting-row" style="margin-top: 0.5rem;">
              <div style="font-size: 0.75rem; color: var(--text-muted); line-height: 1.4;">
                <strong>Claude:</strong> Uses your Claude Max subscription<br>
                <span id="gemini-status">Checking for Gemini API key...</span>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-actions">
          <span class="settings-status" id="settings-status"></span>
          <button type="button" class="settings-btn secondary" onclick="resetSettings()">Reset</button>
          <button type="button" class="settings-btn primary" onclick="saveSettings()">Save Settings</button>
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
      <button class="filter-btn" data-filter="user" onclick="setFilter('user')">👤 User</button>
      <button class="filter-btn" data-filter="manual" onclick="setFilter('manual')">🤖 Claude</button>
      <button class="filter-btn" data-filter="autonomous" onclick="setFilter('autonomous')">✨ Auto</button>
      <button class="filter-btn" data-filter="injected" onclick="setFilter('injected')">💉 Injected</button>
    </div>

    <div class="feed" id="feed">
      <div class="empty">
        <div class="empty-icon">&#128269;</div>
        <p>No research tasks yet. Enter a query above to start.</p>
      </div>
    </div>
  </main>

  <script>
    const ws = new WebSocket('ws://' + location.host);
    let feedItems = [];
    let expandedItems = new Set();
    let activeFilter = 'all'; // 'all', 'manual', 'autonomous', 'injected'
    let currentSettings = null;

    // ========== Settings Functions ==========
    function toggleSettings() {
      const body = document.getElementById('settings-body');
      const icon = document.getElementById('settings-toggle-icon');
      body.classList.toggle('open');
      icon.classList.toggle('open');
    }

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const json = await res.json();
        if (json.success && json.data) {
          currentSettings = json.data;
          applySettingsToForm(json.data);
        }
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }

    function applySettingsToForm(settings) {
      // Research settings
      if (settings.research) {
        document.getElementById('setting-autonomous').checked = settings.research.autonomousEnabled;
        document.getElementById('setting-confidence').value = settings.research.confidenceThreshold * 100;
        document.getElementById('confidence-value').textContent = Math.round(settings.research.confidenceThreshold * 100) + '%';
        document.getElementById('setting-relevance').value = (settings.research.relevanceThreshold || 0.7) * 100;
        document.getElementById('relevance-value').textContent = Math.round((settings.research.relevanceThreshold || 0.7) * 100) + '%';
        document.getElementById('setting-cooldown').value = settings.research.sessionCooldownMs;
        document.getElementById('setting-max-hour').value = settings.research.maxResearchPerHour;
      }
      // Injection settings
      if (settings.injection) {
        document.getElementById('setting-show-injections').checked = settings.injection.showInConversation || false;
      }
      // AI provider settings
      if (settings.aiProvider) {
        document.getElementById('setting-provider').value = settings.aiProvider.provider;
        document.getElementById('setting-claude-model').value = settings.aiProvider.claudeModel || 'haiku';
        document.getElementById('setting-gemini-model').value = settings.aiProvider.geminiModel || 'gemini-2.0-flash-exp';
        toggleProviderSettings(settings.aiProvider.provider);

        // Check if Gemini is available
        if (settings.geminiAvailable) {
          document.getElementById('gemini-option').style.display = 'block';
          document.getElementById('gemini-status').innerHTML = '<span style="color: var(--success);">Gemini API key detected</span>';
        } else {
          document.getElementById('gemini-option').style.display = 'none';
          document.getElementById('gemini-status').innerHTML = 'Gemini: No API key (set GEMINI_API_KEY in .env)';
        }
      }
    }

    function getSettingsFromForm() {
      return {
        research: {
          autonomousEnabled: document.getElementById('setting-autonomous').checked,
          confidenceThreshold: parseInt(document.getElementById('setting-confidence').value) / 100,
          relevanceThreshold: parseInt(document.getElementById('setting-relevance').value) / 100,
          sessionCooldownMs: parseInt(document.getElementById('setting-cooldown').value),
          maxResearchPerHour: parseInt(document.getElementById('setting-max-hour').value)
        },
        injection: {
          showInConversation: document.getElementById('setting-show-injections').checked
        },
        aiProvider: {
          provider: document.getElementById('setting-provider').value,
          claudeModel: document.getElementById('setting-claude-model').value,
          geminiModel: document.getElementById('setting-gemini-model').value
        }
      };
    }

    async function saveSettings() {
      const settings = getSettingsFromForm();
      const status = document.getElementById('settings-status');

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        const json = await res.json();

        if (json.success) {
          status.textContent = 'Settings saved!';
          status.className = 'settings-status success';
          currentSettings = { ...currentSettings, ...settings };
          setTimeout(() => { status.className = 'settings-status'; }, 3000);
        } else {
          throw new Error(json.error || 'Failed to save');
        }
      } catch (e) {
        status.textContent = 'Error: ' + e.message;
        status.className = 'settings-status error';
      }
    }

    async function resetSettings() {
      try {
        const res = await fetch('/api/settings/reset', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          await loadSettings();
          const status = document.getElementById('settings-status');
          status.textContent = 'Settings reset to defaults';
          status.className = 'settings-status success';
          setTimeout(() => { status.className = 'settings-status'; }, 3000);
        }
      } catch (e) {
        console.error('Failed to reset settings:', e);
      }
    }

    function toggleProviderSettings(provider) {
      const isGemini = provider === 'gemini';
      document.getElementById('gemini-settings').style.display = isGemini ? 'block' : 'none';
      document.getElementById('claude-model-settings').style.display = isGemini ? 'none' : 'block';
    }

    // Settings event listeners
    document.getElementById('setting-confidence').addEventListener('input', (e) => {
      document.getElementById('confidence-value').textContent = e.target.value + '%';
    });

    document.getElementById('setting-relevance').addEventListener('input', (e) => {
      document.getElementById('relevance-value').textContent = e.target.value + '%';
    });

    document.getElementById('setting-provider').addEventListener('change', (e) => {
      toggleProviderSettings(e.target.value);
    });

    // ========== WebSocket & Data Functions ==========
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        updateStats(msg.data.queue);
      } else if (msg.type === 'injection') {
        fetchAllData();
        fetchStats(); // Also refresh queue stats
      } else if (msg.type.startsWith('task')) {
        fetchAllData();
        fetchStats(); // Also refresh queue stats (completed count, etc.)
      }
    };

    function updateStats(queue) {
      document.getElementById('stat-queued').textContent = queue.queued;
      document.getElementById('stat-running').textContent = queue.running;
      document.getElementById('stat-completed').textContent = queue.completed;

      // Swap logo based on running state
      const logoImg = document.getElementById('logo-img');
      if (logoImg) {
        logoImg.src = queue.running > 0
          ? '/assets/logo-animated.webp'
          : '/assets/logo.webp';
      }
    }

    function formatTime(timestamp) {
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now - date;

      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return date.toLocaleDateString();
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function getDomain(url) {
      try {
        return new URL(url).hostname.replace('www.', '');
      } catch { return url; }
    }

    function toggleItem(id) {
      if (expandedItems.has(id)) {
        expandedItems.delete(id);
      } else {
        expandedItems.add(id);
      }
      renderFeed();
    }

    function setFilter(filter) {
      activeFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });
      renderFeed();
    }

    function renderFeed() {
      const feed = document.getElementById('feed');

      // Filter items based on active filter
      const filtered = activeFilter === 'all'
        ? feedItems
        : feedItems.filter(item => item.itemType === activeFilter);

      if (filtered.length === 0) {
        feed.innerHTML = \`
          <div class="empty">
            <div class="empty-icon">&#128269;</div>
            <p>\${activeFilter === 'all' ? 'No research activity yet. Enter a query above to start.' : 'No ' + activeFilter + ' items found.'}</p>
          </div>
        \`;
        return;
      }

      feed.innerHTML = filtered.map(item => {
        const isExpanded = expandedItems.has(item.id);
        const hasContent = item.summary || (item.result && item.result.summary);
        const hasSources = item.sources?.length > 0 || (item.result?.sources?.length > 0);
        const sources = item.sources || item.result?.sources || [];

        // Get badge info based on item type
        let badgeClass, badgeText, badgeIcon;
        switch(item.itemType) {
          case 'user':
            badgeClass = item.status || 'user';
            badgeText = item.status === 'running' ? 'running' : 'user';
            badgeIcon = item.status === 'running' ? '<span class="spinner"></span>' : '👤 ';
            break;
          case 'manual':
            badgeClass = item.status || 'manual';
            badgeText = item.status === 'running' ? 'running' : 'manual';
            badgeIcon = item.status === 'running' ? '<span class="spinner"></span>' : '🤖 ';
            break;
          case 'autonomous':
            badgeClass = 'autonomous';
            badgeText = 'auto';
            badgeIcon = '✨ ';
            break;
          case 'injected':
            // Differentiate injection types for unified knowledge
            switch(item.injectionType) {
              case 'memory-only':
                badgeClass = 'injected memory-only';
                badgeText = 'memory';
                badgeIcon = '🧠 ';
                break;
              case 'combined':
                badgeClass = 'injected combined';
                badgeText = 'mem+research';
                badgeIcon = '🔗 ';
                break;
              case 'warning':
                badgeClass = 'injected warning';
                badgeText = 'pivot';
                badgeIcon = '⚠️ ';
                break;
              case 'research-only':
              default:
                badgeClass = 'injected';
                badgeText = 'research';
                badgeIcon = '🔬 ';
                break;
            }
            break;
        }

        let contentHtml = '';
        if (hasContent) {
          const content = item.summary || item.result?.fullContent || item.result?.summary || '';
          const formattedContent = escapeHtml(content)
            .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
            .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
            .replace(/\\\`(.+?)\\\`/g, '<code>$1</code>')
            .replace(/## (.+)/g, '<strong class="findings-header">$1</strong>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\\/li>)/gs, '<ul class="findings-list">$1</ul>')
            .replace(/\\n\\n/g, '</p><p>')
            .replace(/\\n/g, '<br>');
          contentHtml += \`
            <div class="task-summary">
              <h4>Research Findings</h4>
              <div class="findings-content"><p>\${formattedContent}</p></div>
            </div>
          \`;

          const confidence = item.confidence ?? item.result?.confidence;
          const relevance = item.relevance ?? item.result?.relevance;

          if (confidence !== undefined || relevance !== undefined) {
            contentHtml += \`<div class="scores-container">\`;

            if (confidence !== undefined) {
              const confPct = Math.round(confidence * 100);
              contentHtml += \`
                <div class="score-bar">
                  <label>Quality</label>
                  <div class="score-track">
                    <div class="score-fill quality-fill" style="width: \${confPct}%"></div>
                  </div>
                  <span class="score-value">\${confPct}%</span>
                </div>
              \`;
            }

            if (relevance !== undefined) {
              const relPct = Math.round(relevance * 100);
              const relClass = relevance >= 0.7 ? 'high' : relevance >= 0.4 ? 'medium' : 'low';
              contentHtml += \`
                <div class="score-bar">
                  <label>Relevance</label>
                  <div class="score-track">
                    <div class="score-fill relevance-fill \${relClass}" style="width: \${relPct}%"></div>
                  </div>
                  <span class="score-value">\${relPct}%</span>
                </div>
              \`;
            }

            contentHtml += \`</div>\`;
          }
        }

        if (hasSources && sources.length > 0) {
          contentHtml += \`
            <div class="task-sources">
              <h4>Sources (\${sources.length})</h4>
              \${sources.slice(0, 5).map(s => \`
                <a href="\${escapeHtml(s.url)}" target="_blank" class="source-item">
                  <img class="source-favicon" src="https://www.google.com/s2/favicons?domain=\${getDomain(s.url)}&sz=32" alt="">
                  <div class="source-info">
                    <div class="source-title">\${escapeHtml(s.title)}</div>
                    <div class="source-url">\${getDomain(s.url)}</div>
                  </div>
                  \${s.relevance ? \`<span class="source-relevance">\${Math.round(s.relevance * 100)}%</span>\` : ''}
                </a>
              \`).join('')}
            </div>
          \`;
        }

        // Extra info for injected items
        let metaExtra = '';
        if (item.itemType === 'injected' && item.sessionId) {
          metaExtra = \`<span>· session: \${item.sessionId.slice(0, 8)}...</span>\`;
        } else if (item.itemType === 'manual' && item.result) {
          metaExtra = \`<span>· \${item.result.tokensUsed || 0} tokens</span>\`;
        }

        // Include injection type class for proper styling
        const injectionTypeClass = item.itemType === 'injected' && item.injectionType ? item.injectionType : '';

        return \`
          <div class="task-card \${item.itemType} \${injectionTypeClass}" data-id="\${item.id}">
            <div class="task-card-header">
              <span class="task-badge \${badgeClass}">
                \${badgeIcon}\${badgeText}
              </span>
              <div class="task-main">
                <div class="task-query">\${escapeHtml(item.query)}</div>
                <div class="task-meta">
                  <span class="task-depth">\${item.depth || 'medium'}</span>
                  <span>\${formatTime(item.timestamp)}</span>
                  \${metaExtra}
                </div>
              </div>
              <div class="task-actions">
                \${hasContent ? \`
                  <button class="task-action-btn \${isExpanded ? 'active' : ''}" onclick="toggleItem('\${item.id}')">
                    \${isExpanded ? 'Hide' : 'View'} Details
                  </button>
                \` : (item.status === 'running' || item.status === 'queued') ? \`
                  <button class="task-action-btn running-placeholder" disabled>
                    <span class="btn-spinner"></span> Running...
                  </button>
                \` : ''}
              </div>
            </div>
            \${contentHtml ? \`<div class="task-content \${isExpanded ? 'expanded' : ''}">\${contentHtml}</div>\` : ''}
          </div>
        \`;
      }).join('');
    }

    async function fetchAllData() {
      try {
        const [tasksRes, findingsRes, injectionsRes] = await Promise.all([
          fetch('/api/tasks?limit=50'),
          fetch('/api/findings?limit=100'),
          fetch('/api/injections?limit=50')
        ]);
        const [tasksJson, findingsJson, injectionsJson] = await Promise.all([
          tasksRes.json(),
          findingsRes.json(),
          injectionsRes.json()
        ]);

        const items = [];
        const taskFindingIds = new Set(); // Track findingIds from tasks to avoid duplicates
        const taskQueries = new Set(); // Track queries from tasks for fallback deduplication

        // Add queued/manual tasks (distinguish 'user' from 'manual')
        if (tasksJson.success) {
          for (const t of tasksJson.data) {
            // Use trigger type for itemType: 'user' for dashboard, 'manual' for Claude, 'autonomous' for watcher
            let itemType = 'manual';
            if (t.trigger === 'user') itemType = 'user';
            else if (t.trigger === 'tool_output' || t.trigger === 'auto') itemType = 'autonomous';

            items.push({
              id: 'task-' + t.id,
              itemType,
              trigger: t.trigger,
              query: t.query,
              summary: t.result?.summary,
              sources: t.result?.sources,
              confidence: t.result?.confidence,
              relevance: t.result?.relevance,
              depth: t.depth,
              status: t.status,
              result: t.result,
              timestamp: t.createdAt
            });

            // Track findingId to avoid showing duplicate finding
            if (t.result?.findingId) {
              taskFindingIds.add(t.result.findingId);
            }
            // Also track query for fallback deduplication (normalize)
            taskQueries.add(t.query.toLowerCase().trim());
          }
        }

        // Add autonomous findings (only if not already shown as a task)
        if (findingsJson.success) {
          for (const f of findingsJson.data) {
            // Skip if this finding is already represented by a task (by findingId or query)
            if (taskFindingIds.has(f.id)) continue;
            if (taskQueries.has(f.query.toLowerCase().trim())) continue;

            items.push({
              id: 'finding-' + f.id,
              itemType: 'autonomous',
              query: f.query,
              summary: f.summary,
              sources: f.sources,
              confidence: f.confidence,
              depth: f.depth || 'medium',
              timestamp: f.createdAt
            });
          }
        }

        // Add injections
        if (injectionsJson.success) {
          for (const i of injectionsJson.data) {
            items.push({
              id: 'injection-' + i.id,
              itemType: 'injected',
              injectionType: i.injectionType || 'research-only',
              query: i.query,
              summary: i.summary,
              confidence: i.confidence,
              depth: i.depth || 'quick',
              sessionId: i.sessionId,
              timestamp: i.injectedAt
            });
          }
        }

        // Sort by timestamp descending
        items.sort((a, b) => b.timestamp - a.timestamp);
        feedItems = items;

        // Update stats
        document.getElementById('stat-findings').textContent = findingsJson.success ? findingsJson.data.length : 0;
        document.getElementById('stat-injections').textContent = injectionsJson.success ? injectionsJson.data.length : 0;

        renderFeed();
      } catch (e) {
        console.error('Failed to fetch data:', e);
      }
    }

    async function fetchStats() {
      const res = await fetch('/api/queue/stats');
      const json = await res.json();
      if (json.success) {
        updateStats(json.data);
      }
    }

    document.getElementById('research-form').onsubmit = async (e) => {
      e.preventDefault();
      const input = document.getElementById('query-input');
      const depth = document.getElementById('depth-select').value;
      const query = input.value.trim();
      if (!query) return;

      await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, depth, trigger: 'user' })
      });

      input.value = '';
      fetchAllData();
    };

    fetchAllData();
    fetchStats();
    loadSettings();
    setInterval(fetchStats, 3000);
    setInterval(fetchAllData, 5000);
  </script>
</body>
</html>`;
  }
}

// Main entry point
if (process.argv[1].includes('server')) {
  const service = new ResearchService();

  process.on('SIGINT', async () => {
    await service.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await service.stop();
    process.exit(0);
  });

  service.start().catch((error) => {
    console.error('Failed to start service:', error);
    process.exit(1);
  });
}
