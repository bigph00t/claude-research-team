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
    });

    this.queue.on('taskFailed', (task: ResearchTask) => {
      this.broadcast('taskFailed', task);
    });
  }

  /**
   * Setup watcher events for autonomous research
   */
  private setupWatcherEvents(): void {
    // When watcher triggers research, execute via autonomous crew
    this.watcher.on('research:triggered', async (sessionId: string, decision: WatcherDecision) => {
      this.logger.info(`Watcher triggered research for ${sessionId}`, {
        query: decision.query,
        type: decision.researchType,
        confidence: decision.confidence,
      });

      if (!decision.query) return;

      try {
        // Use autonomous crew for background research
        const crew = getAutonomousCrew();
        const result = await crew.explore({
          query: decision.query,
          sessionId,
          context: decision.alternativeHint,
          depth: decision.researchType === 'direct' ? 'medium' : 'deep',
        });

        // Queue injection when complete
        if (result.summary) {
          this.sessionManager.queueInjection(sessionId, {
            summary: result.summary,
            query: decision.query,
            relevance: result.confidence,
            priority: decision.priority,
            pivot: result.pivot,
          });

          this.logger.info(`Research complete for ${sessionId}`, {
            query: decision.query,
            confidence: result.confidence,
            hasPivot: !!result.pivot,
          });
        }
      } catch (error) {
        this.logger.error(`Background research failed for ${sessionId}`, error);
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
        const { query, context, depth, priority, sessionId } = req.body;

        if (!query || typeof query !== 'string') {
          res.status(400).json(this.errorResponse('Query is required'));
          return;
        }

        const task = await this.queue.queue({
          query,
          context,
          depth: depth as ResearchDepth || 'medium',
          trigger: 'manual',
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
    this.app.post('/api/conversation/tool-use', async (req, res) => {
      try {
        const { sessionId, toolName, toolInput, toolOutput, projectPath } = req.body;
        if (!sessionId || !toolName) {
          res.status(400).json(this.errorResponse('sessionId and toolName required'));
          return;
        }

        // Use SessionManager to track the tool use
        this.sessionManager.addToolUse(sessionId, toolName, toolInput || {}, toolOutput || '', projectPath);

        // Check proactive triggers (stuck detection, periodic analysis)
        const proactiveDecision = this.watcher.checkProactiveTriggers(sessionId);
        if (proactiveDecision?.shouldResearch) {
          this.logger.info(`Proactive research triggered for ${sessionId}`, {
            reason: proactiveDecision.reason,
            query: proactiveDecision.query,
          });
          // Emit the research trigger - watcher events will handle execution
          this.watcher.emit('research:triggered', sessionId, proactiveDecision);
        }

        // Check for pending injections from previous research
        const pendingInjection = this.sessionManager.popInjection(sessionId);
        let injection: string | null = null;

        if (pendingInjection) {
          // Format injection with pivot info if present
          injection = this.formatInjection(pendingInjection);
        }

        // Run watcher analysis
        const decision = await this.watcher.analyze(sessionId, 'tool_output');

        // Also maintain legacy analyzer for injection handling
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

        // Combine decisions
        const shouldResearch = decision.shouldResearch ||
          (opportunity.shouldResearch && opportunity.confidence > 0.6);
        const query = decision.query || opportunity.query;

        if (shouldResearch && query) {
          analyzer.markResearchPerformed(sessionId);
          // Watcher events will handle the research execution
        }

        res.json(this.successResponse({
          injection,
          researchQueued: shouldResearch,
          queuedQuery: query,
          researchType: decision.researchType,
          pivot: decision.alternativeHint,
        }));
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
   * Format injection content with pivot handling
   */
  private formatInjection(pending: {
    summary: string;
    query: string;
    relevance: number;
    pivot?: {
      alternative: string;
      reason: string;
      urgency: 'low' | 'medium' | 'high';
    };
  }): string {
    const parts: string[] = [];

    parts.push(`<research-context query="${pending.query}">`);
    parts.push(pending.summary);

    // Add pivot suggestion if present
    if (pending.pivot) {
      parts.push('');
      const urgencyEmoji = pending.pivot.urgency === 'high' ? '🚨' :
                          pending.pivot.urgency === 'medium' ? '💡' : 'ℹ️';
      parts.push(`${urgencyEmoji} **Alternative Approach Detected:**`);
      parts.push(`${pending.pivot.alternative}`);
      parts.push(`_Reason: ${pending.pivot.reason}_`);
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
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--primary);
      text-decoration: none;
    }
    .logo-icon {
      width: 36px;
      height: 36px;
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

    <div class="feed" id="feed">
      <div class="empty">
        <div class="empty-icon">&#128269;</div>
        <p>No research tasks yet. Enter a query above to start.</p>
      </div>
    </div>
  </main>

  <script>
    const ws = new WebSocket('ws://' + location.host);
    let tasks = [];
    let expandedTasks = new Set();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        updateStats(msg.data.queue);
      } else if (msg.type.startsWith('task')) {
        fetchTasks();
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

    function toggleTask(id) {
      if (expandedTasks.has(id)) {
        expandedTasks.delete(id);
      } else {
        expandedTasks.add(id);
      }
      renderTasks();
    }

    function renderTasks() {
      const feed = document.getElementById('feed');
      if (tasks.length === 0) {
        feed.innerHTML = \`
          <div class="empty">
            <div class="empty-icon">&#128269;</div>
            <p>No research tasks yet. Enter a query above to start.</p>
          </div>
        \`;
        return;
      }

      feed.innerHTML = tasks.map(t => {
        const isExpanded = expandedTasks.has(t.id);
        const hasResult = t.result && t.result.summary;
        const hasSources = t.result && t.result.sources && t.result.sources.length > 0;

        let contentHtml = '';
        if (hasResult) {
          // Use fullContent if available (includes summary + key findings), otherwise fallback to summary
          const content = t.result.fullContent || t.result.summary;
          // Convert markdown-like formatting to HTML
          const formattedContent = escapeHtml(content)
            .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')  // **bold** → <strong>
            .replace(/\\*(.+?)\\*/g, '<em>$1</em>')              // *italic* → <em>
            .replace(/\\\`(.+?)\\\`/g, '<code>$1</code>')          // \`code\` → <code>
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

          if (t.result.confidence !== undefined) {
            const pct = Math.round(t.result.confidence * 100);
            contentHtml += \`
              <div class="confidence-bar">
                <label>Confidence</label>
                <div class="confidence-track">
                  <div class="confidence-fill" style="width: \${pct}%"></div>
                </div>
                <span class="confidence-value">\${pct}%</span>
              </div>
            \`;
          }
        }

        if (hasSources) {
          contentHtml += \`
            <div class="task-sources">
              <h4>Sources (\${t.result.sources.length})</h4>
              \${t.result.sources.slice(0, 5).map(s => \`
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

        return \`
          <div class="task-card" data-id="\${t.id}">
            <div class="task-card-header">
              <span class="task-badge \${t.status}">
                \${t.status === 'running' ? '<span class="spinner"></span>' : ''}\${t.status}
              </span>
              <div class="task-main">
                <div class="task-query">\${escapeHtml(t.query)}</div>
                <div class="task-meta">
                  <span class="task-depth">\${t.depth}</span>
                  <span>\${formatTime(t.createdAt)}</span>
                  \${t.result ? \`<span>· \${t.result.tokensUsed || 0} tokens</span>\` : ''}
                </div>
              </div>
              <div class="task-actions">
                \${hasResult ? \`
                  <button class="task-action-btn \${isExpanded ? 'active' : ''}" onclick="toggleTask('\${t.id}')">
                    \${isExpanded ? 'Hide' : 'View'} Details
                  </button>
                \` : ''}
              </div>
            </div>
            \${contentHtml ? \`<div class="task-content \${isExpanded ? 'expanded' : ''}">\${contentHtml}</div>\` : ''}
          </div>
        \`;
      }).join('');
    }

    async function fetchTasks() {
      const res = await fetch('/api/tasks?limit=30');
      const json = await res.json();
      if (json.success) {
        tasks = json.data;
        renderTasks();
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
        body: JSON.stringify({ query, depth })
      });

      input.value = '';
      fetchTasks();
    };

    fetchTasks();
    fetchStats();
    setInterval(fetchStats, 3000);
    setInterval(fetchTasks, 5000);
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
