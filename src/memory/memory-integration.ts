/**
 * Memory Integration Layer (Refactored for v1.0)
 *
 * Design Principles:
 * 1. ISOLATED LEARNING: All research data stays in local research.db
 * 2. SINGLE INJECTION CATEGORY: Only high-quality synthesized findings go to claude-mem
 * 3. MINIMAL FOOTPRINT: Only use claude-mem's observations table, no custom tables
 *
 * Flow:
 * - Research findings are stored in local research.db (see database/index.ts)
 * - Only when a finding meets quality thresholds, we create a claude-mem observation
 * - Observations use type='research-injection' for easy filtering
 */

import Database from 'better-sqlite3';
import { Logger } from '../utils/logger.js';
import type { ResearchFinding } from '../types.js';
import path from 'path';
import os from 'os';

const CLAUDE_MEM_DB = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');

/**
 * Quality thresholds for claude-mem injection
 */
const INJECTION_THRESHOLDS = {
  minConfidence: 0.7,           // Minimum confidence to inject
  minSources: 2,                // Minimum source count
  highQualityConfidence: 0.85,  // High quality threshold
};

/**
 * Synthesized learning ready for claude-mem injection
 */
export interface SynthesizedLearning {
  findingId: string;
  title: string;
  summary: string;
  keyInsights: string[];
  domain?: string;
  confidence: number;
  sourceUrls: string[];
}

export class MemoryIntegration {
  private db: Database.Database | null = null;
  private logger: Logger;
  private initialized: boolean = false;
  private available: boolean = false;

  constructor() {
    this.logger = new Logger('MemoryIntegration');
  }

  /**
   * Initialize connection to claude-mem database
   * This is optional - research team works without claude-mem
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.available;

    try {
      // Check if claude-mem database exists
      const fs = await import('fs');
      if (!fs.existsSync(CLAUDE_MEM_DB)) {
        this.logger.info('Claude-mem database not found - operating in standalone mode');
        this.initialized = true;
        this.available = false;
        return false;
      }

      this.db = new Database(CLAUDE_MEM_DB);
      this.db.pragma('journal_mode = WAL');

      // Verify we can access the observations table
      const check = this.db.prepare('SELECT 1 FROM observations LIMIT 1').get();
      if (check === undefined) {
        // Table exists but is empty, which is fine
      }

      // Ensure research service session exists
      await this.ensureResearchSession();

      this.initialized = true;
      this.available = true;
      this.logger.info('Connected to claude-mem database');
      return true;
    } catch (error) {
      this.logger.warn('Claude-mem integration unavailable', error);
      this.initialized = true;
      this.available = false;
      return false;
    }
  }

  /**
   * Check if claude-mem is available
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Ensure a session exists for the research service
   */
  private async ensureResearchSession(): Promise<void> {
    if (!this.db) return;

    try {
      const existing = this.db.prepare(
        'SELECT id FROM sdk_sessions WHERE sdk_session_id = ?'
      ).get('research-service');

      if (!existing) {
        const now = new Date();
        this.db.prepare(`
          INSERT INTO sdk_sessions (
            claude_session_id, sdk_session_id, project, user_prompt,
            started_at, started_at_epoch, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          'research-service-claude',
          'research-service',
          'claude-research-team',
          'Research service memory integration',
          now.toISOString(),
          now.getTime(),
          'active'
        );
        this.logger.debug('Created research service session');
      }
    } catch (error) {
      this.logger.warn('Failed to ensure research session', error);
    }
  }

  /**
   * Check if a finding meets quality thresholds for claude-mem injection
   */
  meetsQualityThreshold(finding: ResearchFinding): boolean {
    const sourceCount = finding.sources?.length ?? 0;

    return (
      finding.confidence >= INJECTION_THRESHOLDS.minConfidence &&
      sourceCount >= INJECTION_THRESHOLDS.minSources
    );
  }

  /**
   * Check if a finding is high quality (above normal threshold)
   */
  isHighQuality(finding: ResearchFinding): boolean {
    return finding.confidence >= INJECTION_THRESHOLDS.highQualityConfidence;
  }

  /**
   * Synthesize a finding into a format suitable for claude-mem
   */
  synthesizeLearning(finding: ResearchFinding): SynthesizedLearning {
    const keyInsights: string[] = finding.keyPoints || [];

    // Extract additional insights from summary if keyPoints is sparse
    if (keyInsights.length < 2 && finding.summary) {
      const sentences = finding.summary.split(/[.!?]+/).filter(s => s.trim().length > 20);
      for (const sentence of sentences.slice(0, 3)) {
        if (!keyInsights.includes(sentence.trim())) {
          keyInsights.push(sentence.trim());
        }
      }
    }

    return {
      findingId: finding.id,
      title: `Research: ${finding.query.slice(0, 60)}${finding.query.length > 60 ? '...' : ''}`,
      summary: finding.summary,
      keyInsights: keyInsights.slice(0, 5),
      domain: finding.domain,
      confidence: finding.confidence,
      sourceUrls: (finding.sources || []).map(s => s.url).slice(0, 5),
    };
  }

  /**
   * Inject a synthesized learning into claude-mem as an observation
   * This is the ONLY way research team writes to claude-mem
   */
  async injectToClaudeMem(
    learning: SynthesizedLearning,
    sessionId?: string
  ): Promise<number | null> {
    if (!this.available) {
      await this.initialize();
      if (!this.available) return null;
    }

    if (!this.db) return null;

    const now = new Date();
    const createdAt = now.toISOString();
    const createdAtEpoch = now.getTime();

    // Build structured facts
    const facts = [
      ...learning.keyInsights.map(insight => `Insight: ${insight}`),
      ...learning.sourceUrls.map(url => `Source: ${url}`),
    ];

    // Use 'research-injection' as the type for easy filtering
    // This is a custom type specific to claude-research-team
    const observationType = 'discovery';  // Using existing type for compatibility

    // Build narrative from summary and insights
    const narrative = [
      learning.summary,
      '',
      '**Key Insights:**',
      ...learning.keyInsights.map(i => `- ${i}`),
      '',
      `**Confidence:** ${(learning.confidence * 100).toFixed(0)}%`,
      learning.domain ? `**Domain:** ${learning.domain}` : '',
    ].filter(Boolean).join('\n');

    try {
      const insertObs = this.db.prepare(`
        INSERT INTO observations (
          sdk_session_id, project, type, title, subtitle,
          text, facts, narrative, concepts,
          prompt_number, created_at, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const info = insertObs.run(
        sessionId || 'research-service',
        'claude-research-team',
        observationType,
        learning.title,
        `${learning.sourceUrls.length} sources, ${(learning.confidence * 100).toFixed(0)}% confidence`,
        learning.summary,
        JSON.stringify(facts),
        narrative,
        JSON.stringify(['research-injection', learning.domain || 'general']),
        0,
        createdAt,
        createdAtEpoch
      );

      const observationId = info.lastInsertRowid as number;
      this.logger.info(`Injected learning to claude-mem: ${learning.title}`, {
        observationId,
        confidence: learning.confidence,
        sources: learning.sourceUrls.length,
      });

      return observationId;
    } catch (error) {
      this.logger.warn('Failed to inject to claude-mem', error);
      return null;
    }
  }

  /**
   * Inject a high-quality finding to claude-mem
   * Convenience method that handles synthesis and threshold checks
   */
  async injectFindingIfQualified(
    finding: ResearchFinding,
    sessionId?: string
  ): Promise<{ injected: boolean; observationId?: number; reason?: string }> {
    // Check quality threshold
    if (!this.meetsQualityThreshold(finding)) {
      return {
        injected: false,
        reason: `Below quality threshold (confidence: ${finding.confidence}, sources: ${finding.sources?.length ?? 0})`,
      };
    }

    // Only inject high-quality findings by default
    if (!this.isHighQuality(finding)) {
      return {
        injected: false,
        reason: 'Not high enough quality for automatic injection',
      };
    }

    // Synthesize and inject
    const learning = this.synthesizeLearning(finding);
    const observationId = await this.injectToClaudeMem(learning, sessionId);

    if (observationId !== null) {
      return { injected: true, observationId };
    } else {
      return { injected: false, reason: 'Failed to inject to claude-mem' };
    }
  }

  /**
   * Force inject a finding regardless of quality threshold
   * Used for manual skill invocations
   */
  async forceInjectFinding(
    finding: ResearchFinding,
    sessionId?: string
  ): Promise<number | null> {
    const learning = this.synthesizeLearning(finding);
    return this.injectToClaudeMem(learning, sessionId);
  }

  /**
   * Search past research injections in claude-mem
   */
  async searchInjections(query: string, limit: number = 10): Promise<Array<{
    id: number;
    title: string;
    summary: string;
    createdAt: string;
    confidence?: number;
  }>> {
    if (!this.available) {
      await this.initialize();
      if (!this.available) return [];
    }

    if (!this.db) return [];

    try {
      // Search observations that contain research-injection in concepts
      const results = this.db.prepare(`
        SELECT id, title, text as summary, created_at as createdAt, subtitle
        FROM observations
        WHERE concepts LIKE '%research-injection%'
          AND (title LIKE ? OR text LIKE ?)
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit) as Array<{
        id: number;
        title: string;
        summary: string;
        createdAt: string;
        subtitle: string;
      }>;

      // Extract confidence from subtitle (format: "N sources, X% confidence")
      return results.map(r => {
        const match = r.subtitle?.match(/(\d+)% confidence/);
        const confidence = match ? parseInt(match[1]) / 100 : undefined;
        return {
          id: r.id,
          title: r.title,
          summary: r.summary,
          createdAt: r.createdAt,
          confidence,
        };
      });
    } catch (error) {
      this.logger.warn('Failed to search injections', error);
      return [];
    }
  }

  /**
   * Get injection statistics
   */
  async getInjectionStats(): Promise<{
    total: number;
    last7Days: number;
    avgConfidence: number;
  }> {
    if (!this.available) {
      await this.initialize();
      if (!this.available) {
        return { total: 0, last7Days: 0, avgConfidence: 0 };
      }
    }

    if (!this.db) {
      return { total: 0, last7Days: 0, avgConfidence: 0 };
    }

    try {
      const total = this.db.prepare(`
        SELECT COUNT(*) as count FROM observations
        WHERE concepts LIKE '%research-injection%'
      `).get() as { count: number };

      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const last7Days = this.db.prepare(`
        SELECT COUNT(*) as count FROM observations
        WHERE concepts LIKE '%research-injection%'
          AND created_at_epoch > ?
      `).get(weekAgo) as { count: number };

      // Average confidence from subtitles (approximation)
      const withConfidence = this.db.prepare(`
        SELECT subtitle FROM observations
        WHERE concepts LIKE '%research-injection%'
          AND subtitle LIKE '%confidence%'
        LIMIT 100
      `).all() as Array<{ subtitle: string }>;

      let totalConfidence = 0;
      let confidenceCount = 0;
      for (const row of withConfidence) {
        const match = row.subtitle?.match(/(\d+)% confidence/);
        if (match) {
          totalConfidence += parseInt(match[1]) / 100;
          confidenceCount++;
        }
      }

      return {
        total: total.count,
        last7Days: last7Days.count,
        avgConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
      };
    } catch (error) {
      this.logger.warn('Failed to get injection stats', error);
      return { total: 0, last7Days: 0, avgConfidence: 0 };
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      this.available = false;
    }
  }
}

// Singleton instance
let memoryInstance: MemoryIntegration | null = null;

export function getMemoryIntegration(): MemoryIntegration {
  if (!memoryInstance) {
    memoryInstance = new MemoryIntegration();
  }
  return memoryInstance;
}
