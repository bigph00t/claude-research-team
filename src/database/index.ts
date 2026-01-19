/**
 * Database module for claude-research-team
 * Uses SQLite with FTS5 for full-text search
 * Supports both Bun's native SQLite and better-sqlite3
 */

import { openDatabaseSync, type SqliteDatabase } from './sqlite-adapter.js';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  ResearchTask,
  ResearchResult,
  ResearchSource,
  InjectionRecord,
  InjectionRecordType,
  Session,
  QueueStats,
  ResearchFinding,
  InjectionLogEntry,
  SourceQualityEntry,
  InjectionTriggerReason,
  ClaudeMemConfig,
} from '../types.js';
import { VectorService, type SemanticSearchOptions, type VectorSearchResult } from '../vector/index.js';
import { ClaudeMemAdapter, type SaveResearchResult } from '../adapters/claude-mem-adapter.js';

export class ResearchDatabase {
  private db: SqliteDatabase;
  private dataDir: string;
  private vectorService: VectorService;
  private vectorReady: boolean = false;
  private claudeMemAdapter: ClaudeMemAdapter;

  constructor(dataDir: string = '~/.claude-research-team', claudeMemConfig?: Partial<ClaudeMemConfig>) {
    this.dataDir = dataDir.replace('~', homedir());
    this.ensureDataDir();
    this.db = openDatabaseSync(join(this.dataDir, 'research.db'));
    this.vectorService = new VectorService();
    this.claudeMemAdapter = new ClaudeMemAdapter(claudeMemConfig);
    this.initialize();
    // Initialize vector service asynchronously
    this.initVectorService();
  }

  private async initVectorService(): Promise<void> {
    try {
      await this.vectorService.init();
      this.vectorReady = this.vectorService.isReady();
      if (this.vectorReady) {
        console.log('[DB] Vector service initialized successfully');
      }
    } catch (error) {
      console.warn('[DB] Vector service failed to initialize, falling back to FTS5:', error);
      this.vectorReady = false;
    }
  }

  isVectorReady(): boolean {
    return this.vectorReady;
  }

  getVectorService(): VectorService {
    return this.vectorService;
  }

  // ============================================================================
  // Claude-Mem Integration Status
  // ============================================================================

  isClaudeMemReady(): boolean {
    return this.claudeMemAdapter.isReady();
  }

  isClaudeMemFallback(): boolean {
    return this.claudeMemAdapter.isFallbackMode();
  }

  getClaudeMemAdapter(): ClaudeMemAdapter {
    return this.claudeMemAdapter;
  }

  getClaudeMemStats(): { observationsCount: number; researchTasksCount: number } | null {
    return this.claudeMemAdapter.getStats();
  }

  private ensureDataDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    const logsDir = join(this.dataDir, 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
  }

  /**
   * Run database migrations for existing databases
   * Safe to run multiple times - checks if columns exist
   */
  private runMigrations(): void {
    // Migration: Add project_path to research_findings
    try {
      const columns = this.db.pragma('table_info(research_findings)') as Array<{ name: string }>;
      const hasProjectPath = columns.some(col => col.name === 'project_path');
      if (!hasProjectPath) {
        this.db.exec('ALTER TABLE research_findings ADD COLUMN project_path TEXT');
      }
    } catch {
      // Table doesn't exist yet - will be created in initialize()
    }

    // Migration: Add project_path to injection_log
    try {
      const columns = this.db.pragma('table_info(injection_log)') as Array<{ name: string }>;
      const hasProjectPath = columns.some(col => col.name === 'project_path');
      if (!hasProjectPath) {
        this.db.exec('ALTER TABLE injection_log ADD COLUMN project_path TEXT');
      }
    } catch {
      // Table doesn't exist yet - will be created in initialize()
    }

    // Migration: Add injection_type to injection_log (for unified knowledge tracking)
    try {
      const columns = this.db.pragma('table_info(injection_log)') as Array<{ name: string }>;
      const hasType = columns.some(col => col.name === 'injection_type');
      if (!hasType) {
        this.db.exec("ALTER TABLE injection_log ADD COLUMN injection_type TEXT DEFAULT 'research-only'");
      }
    } catch {
      // Table doesn't exist yet - will be created in initialize()
    }

    // Migration: Add result_finding_id to research_tasks (for deduplication)
    try {
      const columns = this.db.pragma('table_info(research_tasks)') as Array<{ name: string }>;
      const hasFindingId = columns.some(col => col.name === 'result_finding_id');
      if (!hasFindingId) {
        this.db.exec('ALTER TABLE research_tasks ADD COLUMN result_finding_id TEXT');
      }
    } catch {
      // Table doesn't exist yet - will be created in initialize()
    }

    // Migration: Add result_relevance to research_tasks (for injection decisions)
    try {
      const columns = this.db.pragma('table_info(research_tasks)') as Array<{ name: string }>;
      const hasRelevance = columns.some(col => col.name === 'result_relevance');
      if (!hasRelevance) {
        this.db.exec('ALTER TABLE research_tasks ADD COLUMN result_relevance REAL');
      }
    } catch {
      // Table doesn't exist yet - will be created in initialize()
    }

    // Migration: Add injection_type to injection_records (for unified knowledge injections)
    try {
      const columns = this.db.pragma('table_info(injection_records)') as Array<{ name: string }>;
      const hasType = columns.some(col => col.name === 'injection_type');
      if (!hasType) {
        this.db.exec('ALTER TABLE injection_records ADD COLUMN injection_type TEXT DEFAULT \'task\'');
      }
    } catch {
      // Table doesn't exist yet - will be created in initialize()
    }
  }

  private initialize(): void {
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Run migrations first (for existing databases)
    this.runMigrations();

    // Create tables
    this.db.exec(`
      -- Research tasks table
      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        context TEXT,
        depth TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'queued',
        trigger TEXT NOT NULL,
        session_id TEXT,
        priority INTEGER NOT NULL DEFAULT 5,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        result_summary TEXT,
        result_full TEXT,
        result_tokens INTEGER,
        result_confidence REAL,
        result_relevance REAL,
        result_finding_id TEXT,
        error TEXT
      );

      -- FTS5 index for research tasks
      CREATE VIRTUAL TABLE IF NOT EXISTS research_tasks_fts USING fts5(
        query,
        context,
        result_summary,
        result_full,
        content='research_tasks',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS research_tasks_ai AFTER INSERT ON research_tasks BEGIN
        INSERT INTO research_tasks_fts(rowid, query, context, result_summary, result_full)
        VALUES (NEW.rowid, NEW.query, NEW.context, NEW.result_summary, NEW.result_full);
      END;

      CREATE TRIGGER IF NOT EXISTS research_tasks_ad AFTER DELETE ON research_tasks BEGIN
        INSERT INTO research_tasks_fts(research_tasks_fts, rowid, query, context, result_summary, result_full)
        VALUES('delete', OLD.rowid, OLD.query, OLD.context, OLD.result_summary, OLD.result_full);
      END;

      CREATE TRIGGER IF NOT EXISTS research_tasks_au AFTER UPDATE ON research_tasks BEGIN
        INSERT INTO research_tasks_fts(research_tasks_fts, rowid, query, context, result_summary, result_full)
        VALUES('delete', OLD.rowid, OLD.query, OLD.context, OLD.result_summary, OLD.result_full);
        INSERT INTO research_tasks_fts(rowid, query, context, result_summary, result_full)
        VALUES (NEW.rowid, NEW.query, NEW.context, NEW.result_summary, NEW.result_full);
      END;

      -- Research sources table
      CREATE TABLE IF NOT EXISTS research_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        snippet TEXT,
        relevance REAL,
        FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE CASCADE
      );

      -- Injection records table
      CREATE TABLE IF NOT EXISTS injection_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        content TEXT NOT NULL,
        tokens_used INTEGER NOT NULL,
        accepted INTEGER DEFAULT 0,
        FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE CASCADE
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        project_path TEXT,
        injections_count INTEGER DEFAULT 0,
        injections_tokens INTEGER DEFAULT 0
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON research_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON research_tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON research_tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_injections_session ON injection_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_sources_task ON research_sources(task_id);

      -- =====================================================================
      -- NEW: Research Learning Tables (v1.0)
      -- =====================================================================

      -- Thorough research storage (full content with progressive disclosure levels)
      CREATE TABLE IF NOT EXISTS research_findings (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_points TEXT,
        full_content TEXT,
        sources TEXT,
        domain TEXT,
        depth TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        project_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_findings_domain ON research_findings(domain);
      CREATE INDEX IF NOT EXISTS idx_findings_created ON research_findings(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_project ON research_findings(project_path);

      -- FTS5 for research findings
      CREATE VIRTUAL TABLE IF NOT EXISTS research_findings_fts USING fts5(
        query,
        summary,
        key_points,
        full_content,
        content='research_findings',
        content_rowid='rowid'
      );

      -- Triggers to keep findings FTS in sync
      CREATE TRIGGER IF NOT EXISTS research_findings_ai AFTER INSERT ON research_findings BEGIN
        INSERT INTO research_findings_fts(rowid, query, summary, key_points, full_content)
        VALUES (NEW.rowid, NEW.query, NEW.summary, NEW.key_points, NEW.full_content);
      END;

      CREATE TRIGGER IF NOT EXISTS research_findings_ad AFTER DELETE ON research_findings BEGIN
        INSERT INTO research_findings_fts(research_findings_fts, rowid, query, summary, key_points, full_content)
        VALUES('delete', OLD.rowid, OLD.query, OLD.summary, OLD.key_points, OLD.full_content);
      END;

      CREATE TRIGGER IF NOT EXISTS research_findings_au AFTER UPDATE ON research_findings BEGIN
        INSERT INTO research_findings_fts(research_findings_fts, rowid, query, summary, key_points, full_content)
        VALUES('delete', OLD.rowid, OLD.query, OLD.summary, OLD.key_points, OLD.full_content);
        INSERT INTO research_findings_fts(rowid, query, summary, key_points, full_content)
        VALUES (NEW.rowid, NEW.query, NEW.summary, NEW.key_points, NEW.full_content);
      END;

      -- Track what was injected and effectiveness (progressive disclosure)
      CREATE TABLE IF NOT EXISTS injection_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        injected_at INTEGER NOT NULL,
        injection_level INTEGER DEFAULT 1,
        trigger_reason TEXT,
        followup_injected INTEGER DEFAULT 0,
        effectiveness_score REAL,
        resolved_issue INTEGER DEFAULT 0,
        project_path TEXT,
        FOREIGN KEY(finding_id) REFERENCES research_findings(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_injection_log_session ON injection_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_injection_log_finding ON injection_log(finding_id);
      CREATE INDEX IF NOT EXISTS idx_injection_log_project ON injection_log(project_path);

      -- Domain-level source quality tracking
      CREATE TABLE IF NOT EXISTS source_quality (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        topic_category TEXT,
        reliability_score REAL DEFAULT 0.5,
        citation_count INTEGER DEFAULT 1,
        helpful_count INTEGER DEFAULT 0,
        last_cited_at INTEGER,
        UNIQUE(domain, topic_category)
      );
      CREATE INDEX IF NOT EXISTS idx_source_quality_domain ON source_quality(domain);

      -- =====================================================================
      -- URL Cache (v1.1) - Prevents re-scraping same URLs
      -- =====================================================================
      CREATE TABLE IF NOT EXISTS url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL UNIQUE,
        title TEXT,
        content TEXT NOT NULL,
        content_length INTEGER NOT NULL,
        scraped_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        source TEXT DEFAULT 'jina',
        hit_count INTEGER DEFAULT 1,
        last_accessed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_url_cache_expires ON url_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_url_cache_scraped ON url_cache(scraped_at DESC);
    `);
  }

  // ============================================================================
  // Research Tasks
  // ============================================================================

  createTask(task: Omit<ResearchTask, 'createdAt'>): ResearchTask {
    const fullTask: ResearchTask = {
      ...task,
      createdAt: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO research_tasks (
        id, query, context, depth, status, trigger, session_id, priority, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fullTask.id,
      fullTask.query,
      fullTask.context || null,
      fullTask.depth,
      fullTask.status,
      fullTask.trigger,
      fullTask.sessionId || null,
      fullTask.priority,
      fullTask.createdAt
    );

    return fullTask;
  }

  getTask(id: string): ResearchTask | null {
    const row = this.db.prepare(`
      SELECT * FROM research_tasks WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToTask(row);
  }

  updateTaskStatus(
    id: string,
    status: ResearchTask['status'],
    updates: Partial<{
      startedAt: number;
      completedAt: number;
      error: string;
    }> = {}
  ): void {
    const setClauses = ['status = ?'];
    const params: unknown[] = [status];

    if (updates.startedAt !== undefined) {
      setClauses.push('started_at = ?');
      params.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?');
      params.push(updates.completedAt);
    }
    if (updates.error !== undefined) {
      setClauses.push('error = ?');
      params.push(updates.error);
    }

    params.push(id);
    this.db.prepare(`
      UPDATE research_tasks SET ${setClauses.join(', ')} WHERE id = ?
    `).run(...params);
  }

  /**
   * Mark any orphaned "running" tasks as failed.
   * Called on server startup to clean up tasks from crashed previous instances.
   * Returns the number of tasks cleaned up.
   */
  cleanupOrphanedTasks(): number {
    const result = this.db.prepare(`
      UPDATE research_tasks
      SET status = 'failed',
          error = 'Server restart - task was orphaned',
          completed_at = ?
      WHERE status = 'running'
    `).run(Date.now());

    return result.changes;
  }

  saveTaskResult(id: string, result: ResearchResult): void {
    // Debug: Log what we're trying to save
    console.log('[DB] saveTaskResult called with:', {
      id,
      summaryLen: result.summary?.length,
      fullContentLen: result.fullContent?.length,
      tokensUsed: result.tokensUsed,
      confidence: result.confidence,
      relevance: result.relevance,
      findingId: result.findingId,
      sourcesCount: result.sources?.length,
    });

    try {
      this.db.prepare(`
        UPDATE research_tasks SET
          result_summary = ?,
          result_full = ?,
          result_tokens = ?,
          result_confidence = ?,
          result_relevance = ?,
          result_finding_id = ?,
          status = 'completed',
          completed_at = ?
        WHERE id = ?
      `).run(
        result.summary,
        result.fullContent,
        result.tokensUsed,
        result.confidence,
        result.relevance ?? 0.5,
        result.findingId || null,
        Date.now(),
        id
      );
      console.log('[DB] Task result saved successfully');
    } catch (e) {
      console.error('[DB] Failed to save task result:', e);
      throw e;
    }

    // Save sources
    try {
      const insertSource = this.db.prepare(`
        INSERT INTO research_sources (task_id, title, url, snippet, relevance)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const source of result.sources || []) {
        insertSource.run(id, source.title, source.url, source.snippet || null, source.relevance);
      }
      console.log('[DB] Sources saved successfully:', result.sources?.length || 0);
    } catch (e) {
      console.error('[DB] Failed to save sources:', e);
      throw e;
    }
  }

  getTaskSources(taskId: string): ResearchSource[] {
    const rows = this.db.prepare(`
      SELECT title, url, snippet, relevance FROM research_sources WHERE task_id = ?
    `).all(taskId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      title: row.title as string,
      url: row.url as string,
      snippet: row.snippet as string | undefined,
      relevance: row.relevance as number,
    }));
  }

  getQueuedTasks(limit: number = 10): ResearchTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_tasks
      WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToTask(row));
  }

  getRunningTasks(): ResearchTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_tasks
      WHERE status = 'running'
      ORDER BY started_at ASC
    `).all() as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToTask(row));
  }

  getRecentTasks(limit: number = 50): ResearchTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_tasks
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToTask(row));
  }

  searchTasks(query: string, limit: number = 20): ResearchTask[] {
    // Escape FTS5 special characters by wrapping in double quotes
    const escapedQuery = '"' + query.replace(/"/g, '""') + '"';
    const rows = this.db.prepare(`
      SELECT rt.* FROM research_tasks rt
      JOIN research_tasks_fts fts ON rt.rowid = fts.rowid
      WHERE research_tasks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(escapedQuery, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToTask(row));
  }

  getQueueStats(): QueueStats {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COUNT(*) as total
      FROM research_tasks
    `).get() as Record<string, number>;

    return {
      queued: row.queued || 0,
      running: row.running || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
      totalProcessed: (row.completed || 0) + (row.failed || 0),
    };
  }

  private rowToTask(row: Record<string, unknown>): ResearchTask {
    const task: ResearchTask = {
      id: row.id as string,
      query: row.query as string,
      context: row.context as string | undefined,
      depth: row.depth as ResearchTask['depth'],
      status: row.status as ResearchTask['status'],
      trigger: row.trigger as ResearchTask['trigger'],
      sessionId: row.session_id as string | undefined,
      priority: row.priority as number,
      createdAt: row.created_at as number,
      startedAt: row.started_at as number | undefined,
      completedAt: row.completed_at as number | undefined,
      error: row.error as string | undefined,
    };

    // Include result if available
    if (row.result_summary) {
      task.result = {
        summary: row.result_summary as string,
        fullContent: row.result_full as string,
        tokensUsed: row.result_tokens as number,
        confidence: row.result_confidence as number,
        relevance: (row.result_relevance as number) ?? 0.5,  // Default if not stored
        sources: this.getTaskSources(task.id),
        findingId: row.result_finding_id as string | undefined,
      };
    }

    return task;
  }

  // ============================================================================
  // Injection Records
  // ============================================================================

  recordInjection(record: InjectionRecord): void {
    this.db.prepare(`
      INSERT INTO injection_records (id, task_id, session_id, injected_at, content, tokens_used, accepted, injection_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskId,
      record.sessionId,
      record.injectedAt,
      record.content,
      record.tokensUsed,
      record.accepted ? 1 : 0,
      record.injectionType || 'task'
    );

    // Update session stats
    this.db.prepare(`
      UPDATE sessions SET
        injections_count = injections_count + 1,
        injections_tokens = injections_tokens + ?,
        last_activity_at = ?
      WHERE id = ?
    `).run(record.tokensUsed, Date.now(), record.sessionId);
  }

  getSessionInjections(sessionId: string): InjectionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM injection_records WHERE session_id = ? ORDER BY injected_at DESC
    `).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      taskId: row.task_id as string,
      sessionId: row.session_id as string,
      injectedAt: row.injected_at as number,
      content: row.content as string,
      tokensUsed: row.tokens_used as number,
      accepted: (row.accepted as number) === 1,
      injectionType: (row.injection_type as string || 'task') as InjectionRecordType,
    }));
  }

  // ============================================================================
  // Sessions
  // ============================================================================

  upsertSession(session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions (id, started_at, last_activity_at, project_path, injections_count, injections_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_activity_at = excluded.last_activity_at,
        project_path = excluded.project_path
    `).run(
      session.id,
      session.startedAt,
      session.lastActivityAt,
      session.projectPath || null,
      session.injectionsCount,
      session.injectionsTokens
    );
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      startedAt: row.started_at as number,
      lastActivityAt: row.last_activity_at as number,
      projectPath: row.project_path as string | undefined,
      injectionsCount: row.injections_count as number,
      injectionsTokens: row.injections_tokens as number,
    };
  }

  getActiveSessions(sinceMs: number = 3600000): Session[] {
    const cutoff = Date.now() - sinceMs;
    const rows = this.db.prepare(`
      SELECT * FROM sessions WHERE last_activity_at > ? ORDER BY last_activity_at DESC
    `).all(cutoff) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      startedAt: row.started_at as number,
      lastActivityAt: row.last_activity_at as number,
      projectPath: row.project_path as string | undefined,
      injectionsCount: row.injections_count as number,
      injectionsTokens: row.injections_tokens as number,
    }));
  }

  // ============================================================================
  // Research Findings (Progressive Disclosure)
  // ============================================================================

  /**
   * Save a research finding to the local database and optionally to claude-mem
   * @param finding The research finding to save
   * @param options Optional parameters for dual-write
   * @returns SaveResearchResult if saved to claude-mem, undefined otherwise
   */
  saveFinding(
    finding: ResearchFinding,
    options?: {
      projectPath?: string;
      sessionId?: string;
      skipClaudeMem?: boolean;
    }
  ): SaveResearchResult | undefined {
    const { projectPath, sessionId, skipClaudeMem = false } = options || {};
    const resolvedProjectPath = projectPath || finding.projectPath || null;

    // 1. Save to local research.db (primary storage)
    this.db.prepare(`
      INSERT INTO research_findings (
        id, query, summary, key_points, full_content, sources, domain, depth, confidence, created_at, last_accessed_at, project_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        summary = excluded.summary,
        key_points = excluded.key_points,
        full_content = excluded.full_content,
        sources = excluded.sources,
        confidence = excluded.confidence,
        last_accessed_at = excluded.last_accessed_at,
        project_path = COALESCE(excluded.project_path, project_path)
    `).run(
      finding.id,
      finding.query,
      finding.summary,
      finding.keyPoints ? JSON.stringify(finding.keyPoints) : null,
      finding.fullContent || null,
      finding.sources ? JSON.stringify(finding.sources) : null,
      finding.domain || null,
      finding.depth,
      finding.confidence,
      finding.createdAt,
      Date.now(),
      resolvedProjectPath
    );

    // 2. Dual-write to claude-mem if enabled and ready
    let claudeMemResult: SaveResearchResult | undefined;

    if (!skipClaudeMem && this.claudeMemAdapter.isReady() && sessionId) {
      try {
        const result = this.claudeMemAdapter.saveResearchAsObservation(
          finding,
          sessionId,
          resolvedProjectPath || 'unknown'
        );
        if (result) {
          claudeMemResult = result;
          console.log(`[DB] Dual-write to claude-mem: observation #${result.observationId}`);
        }
      } catch (error) {
        // Log but don't fail - local save succeeded
        console.warn('[DB] Failed to dual-write to claude-mem:', error);
      }
    }

    return claudeMemResult;
  }

  getFinding(id: string): ResearchFinding | null {
    const row = this.db.prepare(`
      SELECT * FROM research_findings WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    // Update last accessed time
    this.db.prepare(`UPDATE research_findings SET last_accessed_at = ? WHERE id = ?`)
      .run(Date.now(), id);

    return this.rowToFinding(row);
  }

  searchFindings(query: string, limit: number = 20): ResearchFinding[] {
    const escapedQuery = '"' + query.replace(/"/g, '""') + '"';
    const rows = this.db.prepare(`
      SELECT rf.* FROM research_findings rf
      JOIN research_findings_fts fts ON rf.rowid = fts.rowid
      WHERE research_findings_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(escapedQuery, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFinding(row));
  }

  getRecentFindings(limit: number = 20): ResearchFinding[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_findings ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFinding(row));
  }

  getFindingsByDomain(domain: string, limit: number = 20): ResearchFinding[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_findings WHERE domain = ? ORDER BY created_at DESC LIMIT ?
    `).all(domain, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFinding(row));
  }

  private rowToFinding(row: Record<string, unknown>): ResearchFinding {
    return {
      id: row.id as string,
      query: row.query as string,
      summary: row.summary as string,
      keyPoints: row.key_points ? JSON.parse(row.key_points as string) : undefined,
      fullContent: row.full_content as string | undefined,
      sources: row.sources ? JSON.parse(row.sources as string) : undefined,
      domain: row.domain as string | undefined,
      depth: row.depth as 'quick' | 'medium' | 'deep',
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
      lastAccessedAt: row.last_accessed_at as number | undefined,
      projectPath: row.project_path as string | undefined,
    };
  }

  // ============================================================================
  // Project-Specific Research Queries
  // ============================================================================

  /**
   * Get research findings for a specific project
   */
  getProjectFindings(projectPath: string, limit: number = 50): ResearchFinding[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_findings
      WHERE project_path = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(projectPath, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFinding(row));
  }

  /**
   * Check if a similar query was recently researched (for deduplication)
   * Uses semantic similarity when available, falls back to word overlap
   */
  async hasRecentSimilarQueryAsync(
    query: string,
    maxAgeMs: number = 3600000,
    threshold: number = 0.8
  ): Promise<{ found: boolean; existingQuery?: string; similarity?: number; findingId?: string }> {
    // Try semantic search first if vector service is ready
    if (this.vectorReady) {
      const result = await this.vectorService.hasSemanticallySimilarQuery(query, maxAgeMs, threshold);
      if (result.exists) {
        console.log(`[DB] Found semantically similar query (${(result.similarity! * 100).toFixed(1)}%): "${result.existingQuery}"`);
        return {
          found: true,
          existingQuery: result.existingQuery,
          similarity: result.similarity,
          findingId: result.findingId,
        };
      }
    }

    // Fall back to Jaccard similarity
    return this.hasRecentSimilarQueryJaccard(query, maxAgeMs);
  }

  /**
   * Synchronous version using Jaccard similarity only (for backward compatibility)
   */
  hasRecentSimilarQuery(query: string, maxAgeMs: number = 3600000): { found: boolean; existingQuery?: string } {
    return this.hasRecentSimilarQueryJaccard(query, maxAgeMs);
  }

  /**
   * Jaccard similarity fallback for deduplication
   */
  private hasRecentSimilarQueryJaccard(query: string, maxAgeMs: number = 3600000): { found: boolean; existingQuery?: string } {
    const cutoffTime = Date.now() - maxAgeMs;

    // Get recent findings
    const recentFindings = this.db.prepare(`
      SELECT query FROM research_findings
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(cutoffTime) as Array<{ query: string }>;

    // Also check recent tasks (queued or running)
    const recentTasks = this.db.prepare(`
      SELECT query FROM research_tasks
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(cutoffTime) as Array<{ query: string }>;

    const allQueries = [...recentFindings, ...recentTasks].map(r => r.query);

    // Normalize query for comparison
    const queryWords = new Set(
      query.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
    );

    for (const existingQuery of allQueries) {
      const existingWords = new Set(
        existingQuery.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3)
      );

      // Calculate Jaccard similarity
      const intersection = new Set([...queryWords].filter(w => existingWords.has(w)));
      const union = new Set([...queryWords, ...existingWords]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      // If >50% word overlap, consider it similar
      if (similarity > 0.5) {
        return { found: true, existingQuery };
      }
    }

    return { found: false };
  }

  /**
   * Semantic search across findings using vector similarity
   * Falls back to FTS5 if vectors not available
   */
  async semanticSearchFindings(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<ResearchFinding[]> {
    if (this.vectorReady) {
      const vectorResults = await this.vectorService.semanticSearch(query, options);

      // Get unique finding IDs
      const findingIds = [...new Set(vectorResults.map((r: VectorSearchResult) => r.findingId))];

      // Fetch full findings from SQLite
      if (findingIds.length > 0) {
        const placeholders = findingIds.map(() => '?').join(',');
        const rows = this.db.prepare(`
          SELECT * FROM research_findings WHERE id IN (${placeholders})
        `).all(...findingIds) as Array<Record<string, unknown>>;

        // Sort by vector similarity order
        const findingsMap = new Map(rows.map(row => [row.id as string, this.rowToFinding(row)]));
        return findingIds
          .map((id: string) => findingsMap.get(id))
          .filter((f): f is ResearchFinding => f !== undefined);
      }
    }

    // Fall back to FTS5 search
    return this.searchFindings(query, options.limit || 10);
  }

  /**
   * Find related findings for a given query (for context enrichment)
   */
  async findRelatedFindings(
    query: string,
    limit: number = 3,
    excludeFindingId?: string
  ): Promise<ResearchFinding[]> {
    if (this.vectorReady) {
      const vectorResults = await this.vectorService.findRelatedFindings(query, limit, excludeFindingId);

      const findingIds = [...new Set(vectorResults.map((r: VectorSearchResult) => r.findingId))];
      if (findingIds.length > 0) {
        const placeholders = findingIds.map(() => '?').join(',');
        const rows = this.db.prepare(`
          SELECT * FROM research_findings WHERE id IN (${placeholders})
        `).all(...findingIds) as Array<Record<string, unknown>>;

        const findingsMap = new Map(rows.map(row => [row.id as string, this.rowToFinding(row)]));
        return findingIds
          .map((id: string) => findingsMap.get(id))
          .filter((f): f is ResearchFinding => f !== undefined);
      }
    }

    // Fall back to FTS5 and filter
    const results = this.searchFindings(query, limit + 1);
    return results
      .filter(f => f.id !== excludeFindingId)
      .slice(0, limit);
  }

  /**
   * Add finding to vector database (call after saveFinding)
   */
  async embedFinding(finding: ResearchFinding): Promise<void> {
    if (this.vectorReady) {
      await this.vectorService.addFinding(finding);
    }
  }

  /**
   * Get vector database stats
   */
  async getVectorStats(): Promise<{ count: number; collectionName: string } | null> {
    if (this.vectorReady) {
      return this.vectorService.getStats();
    }
    return null;
  }

  /**
   * Get research statistics for a specific project
   */
  getProjectResearchStats(projectPath: string): {
    totalFindings: number;
    topDomains: string[];
    recentQueries: string[];
    avgConfidence: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        AVG(confidence) as avg_confidence
      FROM research_findings
      WHERE project_path = ?
    `).get(projectPath) as { total: number; avg_confidence: number };

    const domains = this.db.prepare(`
      SELECT domain, COUNT(*) as count
      FROM research_findings
      WHERE project_path = ? AND domain IS NOT NULL
      GROUP BY domain
      ORDER BY count DESC
      LIMIT 5
    `).all(projectPath) as Array<{ domain: string; count: number }>;

    const queries = this.db.prepare(`
      SELECT query FROM research_findings
      WHERE project_path = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(projectPath) as Array<{ query: string }>;

    return {
      totalFindings: stats.total || 0,
      topDomains: domains.map(d => d.domain),
      recentQueries: queries.map(q => q.query),
      avgConfidence: stats.avg_confidence || 0,
    };
  }

  /**
   * Get all projects with research findings
   */
  getProjectsWithResearch(): Array<{ projectPath: string; findingCount: number; lastResearchAt: number }> {
    const rows = this.db.prepare(`
      SELECT
        project_path,
        COUNT(*) as finding_count,
        MAX(created_at) as last_research_at
      FROM research_findings
      WHERE project_path IS NOT NULL
      GROUP BY project_path
      ORDER BY last_research_at DESC
    `).all() as Array<{ project_path: string; finding_count: number; last_research_at: number }>;

    return rows.map(row => ({
      projectPath: row.project_path,
      findingCount: row.finding_count,
      lastResearchAt: row.last_research_at,
    }));
  }

  /**
   * Get recent findings with optional project filter
   */
  getRecentFindingsFiltered(options: {
    limit?: number;
    projectPath?: string;
    domain?: string;
  } = {}): ResearchFinding[] {
    const { limit = 20, projectPath, domain } = options;

    let query = 'SELECT * FROM research_findings WHERE 1=1';
    const params: unknown[] = [];

    if (projectPath) {
      query += ' AND project_path = ?';
      params.push(projectPath);
    }

    if (domain) {
      query += ' AND domain = ?';
      params.push(domain);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToFinding(row));
  }

  // ============================================================================
  // Injection Log (Progressive Disclosure Tracking)
  // ============================================================================

  logInjection(log: InjectionLogEntry): number {
    const result = this.db.prepare(`
      INSERT INTO injection_log (
        finding_id, session_id, injected_at, injection_level, trigger_reason, followup_injected, effectiveness_score, resolved_issue, project_path, injection_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.findingId,
      log.sessionId,
      log.injectedAt,
      log.injectionLevel,
      log.triggerReason || null,
      log.followupInjected ? 1 : 0,
      log.effectivenessScore ?? null,
      log.resolvedIssue ? 1 : 0,
      log.projectPath || null,
      log.injectionType || 'research-only'
    );

    return result.lastInsertRowid as number;
  }

  getInjectionHistory(sessionId: string): InjectionLogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM injection_log WHERE session_id = ? ORDER BY injected_at DESC
    `).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as number,
      findingId: row.finding_id as string,
      sessionId: row.session_id as string,
      injectedAt: row.injected_at as number,
      injectionLevel: row.injection_level as 1 | 2 | 3,
      triggerReason: row.trigger_reason as InjectionTriggerReason | undefined,
      followupInjected: (row.followup_injected as number) === 1,
      effectivenessScore: row.effectiveness_score as number | undefined,
      resolvedIssue: (row.resolved_issue as number) === 1,
      projectPath: row.project_path as string | undefined,
      injectionType: row.injection_type as InjectionRecordType | undefined,
    }));
  }

  /**
   * Get recent injections with finding details for dashboard visibility
   */
  getRecentInjections(limit: number = 20, options?: { sessionId?: string; projectPath?: string }): Array<{
    id: number;
    sessionId: string;
    injectedAt: number;
    query: string;
    summary: string;
    confidence: number;
    depth: string;
    triggerReason?: string;
    projectPath?: string;
    injectionType?: string;
  }> {
    let query = `SELECT il.id, il.session_id, il.injected_at, il.trigger_reason, il.project_path, il.injection_type,
                        rf.query, rf.summary, rf.confidence, rf.depth
                 FROM injection_log il
                 JOIN research_findings rf ON il.finding_id = rf.id
                 WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.sessionId) {
      query += ' AND il.session_id = ?';
      params.push(options.sessionId);
    }

    if (options?.projectPath) {
      query += ' AND il.project_path = ?';
      params.push(options.projectPath);
    }

    query += ' ORDER BY il.injected_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as number,
      sessionId: row.session_id as string,
      injectedAt: row.injected_at as number,
      query: row.query as string,
      summary: row.summary as string,
      confidence: row.confidence as number,
      depth: (row.depth as string) || 'medium',
      triggerReason: row.trigger_reason as string | undefined,
      projectPath: row.project_path as string | undefined,
      injectionType: row.injection_type as string | undefined,
    }));
  }

  markInjectionEffective(id: number, score: number, resolved: boolean = false): void {
    this.db.prepare(`
      UPDATE injection_log SET effectiveness_score = ?, resolved_issue = ? WHERE id = ?
    `).run(score, resolved ? 1 : 0, id);
  }

  markFollowupInjected(findingId: string, sessionId: string): void {
    this.db.prepare(`
      UPDATE injection_log SET followup_injected = 1
      WHERE finding_id = ? AND session_id = ?
      ORDER BY injected_at DESC LIMIT 1
    `).run(findingId, sessionId);
  }

  getLastInjectionForFinding(findingId: string, sessionId: string): InjectionLogEntry | null {
    const row = this.db.prepare(`
      SELECT * FROM injection_log WHERE finding_id = ? AND session_id = ?
      ORDER BY injected_at DESC LIMIT 1
    `).get(findingId, sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as number,
      findingId: row.finding_id as string,
      sessionId: row.session_id as string,
      injectedAt: row.injected_at as number,
      injectionLevel: row.injection_level as 1 | 2 | 3,
      triggerReason: row.trigger_reason as InjectionTriggerReason | undefined,
      followupInjected: (row.followup_injected as number) === 1,
      effectivenessScore: row.effectiveness_score as number | undefined,
      resolvedIssue: (row.resolved_issue as number) === 1,
      projectPath: row.project_path as string | undefined,
    };
  }

  // ============================================================================
  // Source Quality Tracking
  // ============================================================================

  updateSourceQuality(domain: string, topicCategory: string | null, helpful: boolean): void {
    this.db.prepare(`
      INSERT INTO source_quality (domain, topic_category, citation_count, helpful_count, last_cited_at, reliability_score)
      VALUES (?, ?, 1, ?, ?, 0.5)
      ON CONFLICT(domain, topic_category) DO UPDATE SET
        citation_count = citation_count + 1,
        helpful_count = helpful_count + ?,
        last_cited_at = ?,
        reliability_score = CAST(helpful_count + ? AS REAL) / (citation_count + 1)
    `).run(
      domain,
      topicCategory,
      helpful ? 1 : 0,
      Date.now(),
      helpful ? 1 : 0,
      Date.now(),
      helpful ? 1 : 0
    );
  }

  getReliableSources(topicCategory?: string, limit: number = 10): SourceQualityEntry[] {
    let query = `
      SELECT * FROM source_quality
      WHERE reliability_score > 0.5
    `;
    const params: unknown[] = [];

    if (topicCategory) {
      query += ` AND topic_category = ?`;
      params.push(topicCategory);
    }

    query += ` ORDER BY reliability_score DESC, citation_count DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as number,
      domain: row.domain as string,
      topicCategory: row.topic_category as string | undefined,
      reliabilityScore: row.reliability_score as number,
      citationCount: row.citation_count as number,
      helpfulCount: row.helpful_count as number,
      lastCitedAt: row.last_cited_at as number | undefined,
    }));
  }

  getBestSourcesForTopic(topic: string, limit: number = 5): string[] {
    const rows = this.db.prepare(`
      SELECT domain FROM source_quality
      WHERE topic_category = ? AND reliability_score > 0.5
      ORDER BY reliability_score DESC, citation_count DESC
      LIMIT ?
    `).all(topic, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => row.domain as string);
  }

  getSourceQualityStats(): { totalDomains: number; reliableDomains: number; avgReliability: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN reliability_score > 0.5 THEN 1 ELSE 0 END) as reliable,
        AVG(reliability_score) as avg_reliability
      FROM source_quality
    `).get() as Record<string, number>;

    return {
      totalDomains: row.total || 0,
      reliableDomains: row.reliable || 0,
      avgReliability: row.avg_reliability || 0,
    };
  }

  // ============================================================================
  // URL Cache - Prevents re-scraping same URLs
  // ============================================================================

  /**
   * Default TTL values by domain pattern (in milliseconds)
   */
  private getDefaultTtl(url: string): number {
    const MS_HOUR = 3600000;
    const MS_DAY = MS_HOUR * 24;

    try {
      const hostname = new URL(url).hostname.toLowerCase();

      // Documentation sites - stable, cache longer
      if (hostname.includes('docs.') ||
          hostname.includes('documentation') ||
          hostname.includes('developer.mozilla.org') ||
          hostname.includes('devdocs.io')) {
        return MS_DAY * 7; // 7 days
      }

      // Package registries - relatively stable
      if (hostname.includes('npmjs.com') ||
          hostname.includes('pypi.org') ||
          hostname.includes('crates.io') ||
          hostname.includes('pkg.go.dev')) {
        return MS_DAY * 3; // 3 days
      }

      // Q&A sites - answers evolve
      if (hostname.includes('stackoverflow.com') ||
          hostname.includes('stackexchange.com')) {
        return MS_DAY * 2; // 2 days
      }

      // Code hosting - changes frequently
      if (hostname.includes('github.com') ||
          hostname.includes('gitlab.com') ||
          hostname.includes('bitbucket.org')) {
        return MS_DAY; // 1 day
      }

      // News/blogs - time-sensitive
      if (hostname.includes('news.') ||
          hostname.includes('blog.') ||
          hostname.includes('medium.com') ||
          hostname.includes('dev.to')) {
        return MS_DAY; // 1 day
      }

      // Default
      return MS_DAY; // 1 day
    } catch {
      return MS_DAY;
    }
  }

  /**
   * Normalize URL for cache lookup (removes query params, fragments, trailing slashes)
   */
  normalizeUrlForCache(url: string): string {
    try {
      const parsed = new URL(url);
      // Keep protocol, host, and pathname; remove query and hash
      let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      // Remove trailing slash unless it's the root
      if (normalized.endsWith('/') && parsed.pathname !== '/') {
        normalized = normalized.slice(0, -1);
      }
      return normalized.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Get cached URL content if available and not expired
   */
  getCachedUrl(url: string): { content: string; title?: string; cachedAt: number } | null {
    const normalizedUrl = this.normalizeUrlForCache(url);
    const now = Date.now();

    const row = this.db.prepare(`
      SELECT content, title, scraped_at, expires_at
      FROM url_cache
      WHERE normalized_url = ? AND expires_at > ?
    `).get(normalizedUrl, now) as Record<string, unknown> | undefined;

    if (!row) return null;

    // Update hit count and last accessed
    this.db.prepare(`
      UPDATE url_cache
      SET hit_count = hit_count + 1, last_accessed_at = ?
      WHERE normalized_url = ?
    `).run(now, normalizedUrl);

    return {
      content: row.content as string,
      title: row.title as string | undefined,
      cachedAt: row.scraped_at as number,
    };
  }

  /**
   * Cache URL content with automatic TTL based on domain
   */
  cacheUrl(
    url: string,
    content: string,
    options?: { title?: string; ttlMs?: number; source?: string }
  ): void {
    const normalizedUrl = this.normalizeUrlForCache(url);
    const now = Date.now();
    const ttlMs = options?.ttlMs ?? this.getDefaultTtl(url);
    const expiresAt = now + ttlMs;

    this.db.prepare(`
      INSERT INTO url_cache (url, normalized_url, title, content, content_length, scraped_at, expires_at, source, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_url) DO UPDATE SET
        content = excluded.content,
        content_length = excluded.content_length,
        title = COALESCE(excluded.title, title),
        scraped_at = excluded.scraped_at,
        expires_at = excluded.expires_at,
        source = excluded.source,
        hit_count = hit_count + 1,
        last_accessed_at = excluded.last_accessed_at
    `).run(
      url,
      normalizedUrl,
      options?.title || null,
      content,
      content.length,
      now,
      expiresAt,
      options?.source || 'jina',
      now
    );
  }

  /**
   * Clean expired cache entries
   * @returns Number of entries deleted
   */
  cleanExpiredCache(): number {
    const result = this.db.prepare(`
      DELETE FROM url_cache WHERE expires_at < ?
    `).run(Date.now());

    return result.changes;
  }

  /**
   * Get URL cache statistics
   */
  getUrlCacheStats(): {
    totalCached: number;
    totalHits: number;
    avgHitsPerUrl: number;
    totalContentSize: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(hit_count) as total_hits,
        AVG(hit_count) as avg_hits,
        SUM(content_length) as total_size,
        MIN(scraped_at) as oldest,
        MAX(scraped_at) as newest
      FROM url_cache
      WHERE expires_at > ?
    `).get(Date.now()) as Record<string, number | null>;

    return {
      totalCached: row.total || 0,
      totalHits: row.total_hits || 0,
      avgHitsPerUrl: row.avg_hits || 0,
      totalContentSize: row.total_size || 0,
      oldestEntry: row.oldest,
      newestEntry: row.newest,
    };
  }

  /**
   * Get most frequently accessed cached URLs
   */
  getTopCachedUrls(limit: number = 10): Array<{
    url: string;
    hitCount: number;
    contentLength: number;
    scrapedAt: number;
    expiresAt: number;
  }> {
    const rows = this.db.prepare(`
      SELECT url, hit_count, content_length, scraped_at, expires_at
      FROM url_cache
      WHERE expires_at > ?
      ORDER BY hit_count DESC
      LIMIT ?
    `).all(Date.now(), limit) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      url: row.url as string,
      hitCount: row.hit_count as number,
      contentLength: row.content_length as number,
      scrapedAt: row.scraped_at as number,
      expiresAt: row.expires_at as number,
    }));
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  close(): void {
    this.db.close();
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Clean up old data
   * @param daysToKeep Number of days to keep data
   */
  cleanup(daysToKeep: number = 30): { deletedTasks: number; deletedSessions: number } {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const taskResult = this.db.prepare(`
      DELETE FROM research_tasks WHERE created_at < ?
    `).run(cutoff);

    const sessionResult = this.db.prepare(`
      DELETE FROM sessions WHERE last_activity_at < ?
    `).run(cutoff);

    return {
      deletedTasks: taskResult.changes,
      deletedSessions: sessionResult.changes,
    };
  }
}

// Singleton instance
let instance: ResearchDatabase | null = null;

export function getDatabase(dataDir?: string): ResearchDatabase {
  if (!instance) {
    instance = new ResearchDatabase(dataDir);
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
