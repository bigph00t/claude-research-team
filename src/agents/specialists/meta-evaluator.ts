/**
 * Meta-Evaluator Agent
 *
 * Evaluates research quality post-completion and provides feedback for improvement.
 * This is not a search specialist but an evaluation agent that works on existing findings.
 *
 * Responsibilities:
 * - Evaluate research completeness and quality
 * - Detect knowledge gaps that need more research
 * - Suggest improvements for future research
 * - Score confidence levels based on source quality and coverage
 */

import { Logger } from '../../utils/logger.js';
import { getDatabase } from '../../database/index.js';
import { getMetaLearner } from '../../learning/meta-learner.js';
import type { ResearchFinding, ResearchDepth } from '../../types.js';
import type { Finding } from './base.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Quality evaluation result
 */
export interface QualityEvaluation {
  overallScore: number;           // 0-1 overall quality
  completeness: number;           // 0-1 how complete the research is
  sourceQuality: number;          // 0-1 quality of sources
  relevance: number;              // 0-1 relevance to query
  freshness: number;              // 0-1 how recent sources are
  gaps: KnowledgeGap[];           // Identified gaps
  suggestions: Improvement[];     // Suggested improvements
  confidence: 'low' | 'medium' | 'high';
}

/**
 * A knowledge gap that needs more research
 */
export interface KnowledgeGap {
  topic: string;
  severity: 'minor' | 'moderate' | 'critical';
  reason: string;
  suggestedQuery?: string;
}

/**
 * Suggested improvement for future research
 */
export interface Improvement {
  area: 'sources' | 'depth' | 'scope' | 'freshness' | 'diversity';
  suggestion: string;
  priority: 'low' | 'medium' | 'high';
}

/**
 * Source analysis result
 */
interface SourceAnalysis {
  totalSources: number;
  uniqueDomains: number;
  avgRelevance: number;
  reliableSourceCount: number;
  domainDiversity: number;
}

// ============================================================================
// Meta-Evaluator Agent
// ============================================================================

export class MetaEvaluatorAgent {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('MetaEvaluator');
  }

  /**
   * Evaluate a completed research finding
   */
  async evaluate(finding: ResearchFinding): Promise<QualityEvaluation> {
    this.logger.info(`Evaluating research: "${finding.query}"`);

    // Analyze sources
    const sourceAnalysis = this.analyzeSources(finding);

    // Analyze content
    const contentAnalysis = this.analyzeContent(finding);

    // Detect gaps
    const gaps = this.detectGaps(finding, sourceAnalysis, contentAnalysis);

    // Generate suggestions
    const suggestions = this.generateSuggestions(finding, sourceAnalysis, gaps);

    // Calculate scores
    const completeness = this.calculateCompleteness(finding, contentAnalysis);
    const sourceQuality = this.calculateSourceQuality(sourceAnalysis);
    const relevance = this.estimateRelevance(finding);
    const freshness = this.estimateFreshness(finding);

    // Overall score (weighted average)
    const overallScore = (
      completeness * 0.25 +
      sourceQuality * 0.30 +
      relevance * 0.30 +
      freshness * 0.15
    );

    const evaluation: QualityEvaluation = {
      overallScore,
      completeness,
      sourceQuality,
      relevance,
      freshness,
      gaps,
      suggestions,
      confidence: overallScore >= 0.75 ? 'high' : overallScore >= 0.5 ? 'medium' : 'low',
    };

    this.logger.info(`Evaluation complete: score=${overallScore.toFixed(2)}, gaps=${gaps.length}`);

    // Record to meta-learner
    this.recordEvaluation(finding, evaluation);

    return evaluation;
  }

  /**
   * Evaluate a raw Finding (from specialists) before it becomes a ResearchFinding
   */
  async evaluateFinding(finding: Finding, query: string): Promise<QualityEvaluation> {
    // Convert to minimal ResearchFinding for analysis
    const researchFinding: ResearchFinding = {
      id: 'temp',
      query,
      summary: finding.scraped.map(s => s.content.slice(0, 200)).join(' '),
      keyPoints: finding.results.slice(0, 5).map(r => r.title),
      sources: finding.results.map((r, i) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        relevance: r.relevance ?? (1 - i * 0.1),
      })),
      depth: 'medium' as ResearchDepth,
      confidence: finding.results.length > 5 ? 0.6 : 0.4,
      createdAt: finding.timestamp,
    };

    return this.evaluate(researchFinding);
  }

  /**
   * Compare two findings for the same query
   */
  compareFindings(a: ResearchFinding, b: ResearchFinding): {
    better: 'a' | 'b' | 'equal';
    reason: string;
    aScore: number;
    bScore: number;
  } {
    const analyzeScore = (f: ResearchFinding): number => {
      const sourceCount = f.sources?.length ?? 0;
      const keyPointCount = f.keyPoints?.length ?? 0;
      const hasFullContent = f.fullContent && f.fullContent.length > 100;

      return (
        f.confidence * 0.4 +
        Math.min(sourceCount / 5, 1) * 0.3 +
        Math.min(keyPointCount / 5, 1) * 0.2 +
        (hasFullContent ? 0.1 : 0)
      );
    };

    const aScore = analyzeScore(a);
    const bScore = analyzeScore(b);
    const diff = aScore - bScore;

    if (Math.abs(diff) < 0.05) {
      return { better: 'equal', reason: 'Scores are similar', aScore, bScore };
    }

    if (diff > 0) {
      return {
        better: 'a',
        reason: `Higher confidence and source quality`,
        aScore,
        bScore,
      };
    }

    return {
      better: 'b',
      reason: `Higher confidence and source quality`,
      aScore,
      bScore,
    };
  }

  // ============================================================================
  // Private: Analysis Methods
  // ============================================================================

  private analyzeSources(finding: ResearchFinding): SourceAnalysis {
    const sources = finding.sources || [];
    const domains = new Set<string>();

    for (const source of sources) {
      try {
        const url = new URL(source.url);
        domains.add(url.hostname);
      } catch {
        // Invalid URL
      }
    }

    const avgRelevance = sources.length > 0
      ? sources.reduce((sum, s) => sum + (s.relevance ?? 0.5), 0) / sources.length
      : 0;

    // Check which sources are known to be reliable
    const db = getDatabase();
    let reliableCount = 0;
    for (const source of sources) {
      try {
        const url = new URL(source.url);
        const reliable = db.getReliableSources(url.hostname, 1);
        if (reliable.length > 0 && reliable[0].reliabilityScore >= 0.7) {
          reliableCount++;
        }
      } catch {
        // Skip invalid URLs
      }
    }

    return {
      totalSources: sources.length,
      uniqueDomains: domains.size,
      avgRelevance,
      reliableSourceCount: reliableCount,
      domainDiversity: sources.length > 0 ? domains.size / sources.length : 0,
    };
  }

  private analyzeContent(finding: ResearchFinding): {
    hasSummary: boolean;
    summaryLength: number;
    keyPointCount: number;
    hasFullContent: boolean;
    fullContentLength: number;
  } {
    return {
      hasSummary: !!finding.summary && finding.summary.length > 20,
      summaryLength: finding.summary?.length ?? 0,
      keyPointCount: finding.keyPoints?.length ?? 0,
      hasFullContent: !!finding.fullContent && finding.fullContent.length > 100,
      fullContentLength: finding.fullContent?.length ?? 0,
    };
  }

  private detectGaps(
    finding: ResearchFinding,
    sources: SourceAnalysis,
    content: ReturnType<typeof this.analyzeContent>
  ): KnowledgeGap[] {
    const gaps: KnowledgeGap[] = [];

    // Low source count
    if (sources.totalSources < 2) {
      gaps.push({
        topic: 'sources',
        severity: 'critical',
        reason: 'Too few sources for reliable research',
        suggestedQuery: `${finding.query} alternative sources`,
      });
    }

    // Low domain diversity
    if (sources.totalSources >= 3 && sources.domainDiversity < 0.5) {
      gaps.push({
        topic: 'source diversity',
        severity: 'moderate',
        reason: 'Sources come from too few domains',
      });
    }

    // Missing key points
    if (content.keyPointCount < 2) {
      gaps.push({
        topic: 'key insights',
        severity: 'moderate',
        reason: 'Few key insights extracted',
        suggestedQuery: `${finding.query} key points summary`,
      });
    }

    // Short summary
    if (content.summaryLength < 100) {
      gaps.push({
        topic: 'summary depth',
        severity: 'minor',
        reason: 'Summary is brief',
      });
    }

    // Low confidence
    if (finding.confidence < 0.5) {
      gaps.push({
        topic: 'confidence',
        severity: 'critical',
        reason: 'Low confidence in research results',
        suggestedQuery: `${finding.query} comprehensive guide`,
      });
    }

    return gaps;
  }

  private generateSuggestions(
    finding: ResearchFinding,
    _sources: SourceAnalysis,
    gaps: KnowledgeGap[]
  ): Improvement[] {
    const suggestions: Improvement[] = [];

    // Suggest based on gaps
    if (gaps.some(g => g.topic === 'sources')) {
      suggestions.push({
        area: 'sources',
        suggestion: 'Search additional platforms or databases',
        priority: 'high',
      });
    }

    if (gaps.some(g => g.topic === 'source diversity')) {
      suggestions.push({
        area: 'diversity',
        suggestion: 'Broaden search to different types of sources',
        priority: 'medium',
      });
    }

    // Suggest depth increase if confidence is low
    if (finding.confidence < 0.6) {
      suggestions.push({
        area: 'depth',
        suggestion: 'Consider deeper research with more iterations',
        priority: 'high',
      });
    }

    // Suggest freshness check if domain is tech
    if (finding.domain && ['typescript', 'javascript', 'react', 'python'].includes(finding.domain)) {
      suggestions.push({
        area: 'freshness',
        suggestion: 'Verify information is current - tech changes rapidly',
        priority: 'medium',
      });
    }

    return suggestions;
  }

  // ============================================================================
  // Private: Score Calculations
  // ============================================================================

  private calculateCompleteness(
    finding: ResearchFinding,
    content: ReturnType<typeof this.analyzeContent>
  ): number {
    let score = 0;

    // Has summary (required)
    if (content.hasSummary) score += 0.3;
    if (content.summaryLength > 200) score += 0.1;

    // Has key points
    if (content.keyPointCount >= 3) score += 0.3;
    else if (content.keyPointCount >= 1) score += 0.15;

    // Has full content
    if (content.hasFullContent) score += 0.2;

    // Has sources
    if ((finding.sources?.length ?? 0) >= 3) score += 0.1;

    return Math.min(score, 1);
  }

  private calculateSourceQuality(sources: SourceAnalysis): number {
    if (sources.totalSources === 0) return 0;

    const countScore = Math.min(sources.totalSources / 5, 1) * 0.3;
    const diversityScore = sources.domainDiversity * 0.3;
    const relevanceScore = sources.avgRelevance * 0.2;
    const reliabilityScore = Math.min(sources.reliableSourceCount / 3, 1) * 0.2;

    return countScore + diversityScore + relevanceScore + reliabilityScore;
  }

  private estimateRelevance(finding: ResearchFinding): number {
    // Use the finding's own confidence as a proxy for relevance
    // In a more sophisticated system, we'd use the coordinator to evaluate
    return finding.confidence;
  }

  private estimateFreshness(finding: ResearchFinding): number {
    // Assume sources are fresh unless we have explicit timestamps
    // In production, we'd check source publish dates
    const age = Date.now() - (finding.createdAt || Date.now());
    const daysSinceCreation = age / (1000 * 60 * 60 * 24);

    if (daysSinceCreation < 1) return 1;
    if (daysSinceCreation < 7) return 0.9;
    if (daysSinceCreation < 30) return 0.7;
    if (daysSinceCreation < 90) return 0.5;
    return 0.3;
  }

  // ============================================================================
  // Private: Recording
  // ============================================================================

  private recordEvaluation(finding: ResearchFinding, evaluation: QualityEvaluation): void {
    try {
      const db = getDatabase();
      const metaLearner = getMetaLearner(db);

      // Record query performance
      metaLearner.recordQueryPerformance({
        query: finding.query,
        depth: finding.depth,
        domain: finding.domain,
        elapsedMs: 0, // Not tracked here
        wasSuccessful: evaluation.overallScore >= 0.5,
        confidence: evaluation.overallScore,
        sourcesUsed: finding.sources?.length ?? 0,
      });

      // Update source scores
      if (finding.sources && finding.sources.length > 0) {
        metaLearner.updateSourceScores(
          finding.sources.map(s => ({
            url: s.url,
            relevance: s.relevance ?? 0.5,
          })),
          finding.domain,
          evaluation.overallScore >= 0.5
        );
      }
    } catch (error) {
      this.logger.debug('Failed to record evaluation to meta-learner', error);
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let evaluatorInstance: MetaEvaluatorAgent | null = null;

export function getMetaEvaluator(): MetaEvaluatorAgent {
  if (!evaluatorInstance) {
    evaluatorInstance = new MetaEvaluatorAgent();
  }
  return evaluatorInstance;
}
