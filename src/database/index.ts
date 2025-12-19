/**
 * Database module for claude-research-team
 * Uses SQLite with FTS5 for full-text search
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  ResearchTask,
  ResearchResult,
  ResearchSource,
  InjectionRecord,
  Session,
  QueueStats,
  ResearchFinding,
  InjectionLogEntry,
  SourceQualityEntry,
  InjectionTriggerReason,
} from '../types.js';

export class ResearchDatabase {
  private db: Database.Database;
  private dataDir: string;

  constructor(dataDir: string = '~/.claude-research-team') {
    this.dataDir = dataDir.replace('~', homedir());
    this.ensureDataDir();
    this.db = new Database(join(this.dataDir, 'research.db'));
    this.initialize();
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

  private initialize(): void {
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

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
        last_accessed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_findings_domain ON research_findings(domain);
      CREATE INDEX IF NOT EXISTS idx_findings_created ON research_findings(created_at DESC);

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
        FOREIGN KEY(finding_id) REFERENCES research_findings(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_injection_log_session ON injection_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_injection_log_finding ON injection_log(finding_id);

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

  saveTaskResult(id: string, result: ResearchResult): void {
    this.db.prepare(`
      UPDATE research_tasks SET
        result_summary = ?,
        result_full = ?,
        result_tokens = ?,
        result_confidence = ?,
        status = 'completed',
        completed_at = ?
      WHERE id = ?
    `).run(
      result.summary,
      result.fullContent,
      result.tokensUsed,
      result.confidence,
      Date.now(),
      id
    );

    // Save sources
    const insertSource = this.db.prepare(`
      INSERT INTO research_sources (task_id, title, url, snippet, relevance)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const source of result.sources) {
      insertSource.run(id, source.title, source.url, source.snippet || null, source.relevance);
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
        sources: this.getTaskSources(task.id),
      };
    }

    return task;
  }

  // ============================================================================
  // Injection Records
  // ============================================================================

  recordInjection(record: InjectionRecord): void {
    this.db.prepare(`
      INSERT INTO injection_records (id, task_id, session_id, injected_at, content, tokens_used, accepted)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.taskId,
      record.sessionId,
      record.injectedAt,
      record.content,
      record.tokensUsed,
      record.accepted ? 1 : 0
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

  saveFinding(finding: ResearchFinding): void {
    this.db.prepare(`
      INSERT INTO research_findings (
        id, query, summary, key_points, full_content, sources, domain, depth, confidence, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        summary = excluded.summary,
        key_points = excluded.key_points,
        full_content = excluded.full_content,
        sources = excluded.sources,
        confidence = excluded.confidence,
        last_accessed_at = excluded.last_accessed_at
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
      Date.now()
    );
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
    };
  }

  // ============================================================================
  // Injection Log (Progressive Disclosure Tracking)
  // ============================================================================

  logInjection(log: InjectionLogEntry): number {
    const result = this.db.prepare(`
      INSERT INTO injection_log (
        finding_id, session_id, injected_at, injection_level, trigger_reason, followup_injected, effectiveness_score, resolved_issue
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.findingId,
      log.sessionId,
      log.injectedAt,
      log.injectionLevel,
      log.triggerReason || null,
      log.followupInjected ? 1 : 0,
      log.effectivenessScore ?? null,
      log.resolvedIssue ? 1 : 0
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
