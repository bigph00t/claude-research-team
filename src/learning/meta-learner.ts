/**
 * Meta-Learning System for claude-research-team
 *
 * Tracks research effectiveness, evaluates triggers, updates source quality,
 * and provides recommendations based on learned patterns.
 */

import type {
  ResearchDepth,
  InjectionLogEntry,
  SourceQualityEntry,
  ApproachInsights,
} from '../types.js';
import { ResearchDatabase } from '../database/index.js';
import { Logger } from '../utils/logger.js';

/**
 * Recorded performance of a research query
 */
interface QueryPerformance {
  query: string;
  depth: ResearchDepth;
  domain?: string;
  elapsedMs: number;
  wasSuccessful: boolean;
  confidence: number;
  sourcesUsed: number;
  resultWasHelpful?: boolean;
  timestamp: number;
}

/**
 * Trigger evaluation result
 */
interface TriggerEvaluation {
  triggerId: number;
  wasHelpful: boolean;
  score: number;  // -1 to 1
  reason: string;
}

/**
 * Depth recommendation based on learned patterns
 */
interface DepthRecommendation {
  recommended: ResearchDepth;
  confidence: number;
  reason: string;
}

/**
 * Meta-Learner tracks research effectiveness and learns from outcomes
 */
export class MetaLearner {
  private db: ResearchDatabase;
  private logger: Logger;
  private queryPerformanceHistory: QueryPerformance[] = [];
  private maxHistorySize = 1000;

  constructor(db: ResearchDatabase) {
    this.db = db;
    this.logger = new Logger('MetaLearner');
  }

  // ============================================================================
  // Trigger Evaluation
  // ============================================================================

  /**
   * Evaluate if a research trigger was helpful
   * Called after research has been injected and we can observe the outcome
   */
  evaluateTrigger(
    _sessionId: string,
    injectionId: number,
    signals: {
      errorResolved?: boolean;
      taskCompleted?: boolean;
      sameErrorRepeated?: boolean;
      userIgnored?: boolean;
      followupNeeded?: boolean;
    }
  ): TriggerEvaluation {
    let score = 0;
    let reasons: string[] = [];

    // Positive signals
    if (signals.errorResolved) {
      score += 0.5;
      reasons.push('error resolved');
    }
    if (signals.taskCompleted) {
      score += 0.3;
      reasons.push('task completed');
    }

    // Negative signals
    if (signals.sameErrorRepeated) {
      score -= 0.4;
      reasons.push('same error repeated');
    }
    if (signals.userIgnored) {
      score -= 0.2;
      reasons.push('user ignored injection');
    }
    if (signals.followupNeeded) {
      score -= 0.1;
      reasons.push('followup needed');
    }

    // Clamp score to [-1, 1]
    score = Math.max(-1, Math.min(1, score));

    const wasHelpful = score > 0;

    // Update the injection log with effectiveness
    this.db.markInjectionEffective(injectionId, score, signals.errorResolved ?? false);

    this.logger.debug(`Trigger evaluation: ${wasHelpful ? 'helpful' : 'not helpful'} (score: ${score.toFixed(2)})`, {
      reasons,
    });

    return {
      triggerId: injectionId,
      wasHelpful,
      score,
      reason: reasons.join(', ') || 'no clear signals',
    };
  }

  /**
   * Schedule a delayed evaluation of a trigger
   * Called after injection to check outcome after a delay
   */
  scheduleEvaluation(sessionId: string, injectionId: number, delayMs: number = 60000): void {
    setTimeout(() => {
      // In a real implementation, this would check session state
      // For now, we just log that evaluation was scheduled
      this.logger.debug(`Scheduled evaluation for injection ${injectionId} in session ${sessionId}`);
    }, delayMs);
  }

  // ============================================================================
  // Query Performance Tracking
  // ============================================================================

  /**
   * Record the performance of a research query
   */
  recordQueryPerformance(performance: Omit<QueryPerformance, 'timestamp'>): void {
    const record: QueryPerformance = {
      ...performance,
      timestamp: Date.now(),
    };

    this.queryPerformanceHistory.push(record);

    // Keep history size bounded
    if (this.queryPerformanceHistory.length > this.maxHistorySize) {
      this.queryPerformanceHistory = this.queryPerformanceHistory.slice(-this.maxHistorySize / 2);
    }

    this.logger.debug(`Recorded query performance`, {
      query: performance.query.substring(0, 50),
      depth: performance.depth,
      elapsedMs: performance.elapsedMs,
      wasSuccessful: performance.wasSuccessful,
    });
  }

  /**
   * Get average performance metrics by depth
   */
  getPerformanceByDepth(): Record<ResearchDepth, { avgTime: number; successRate: number; avgConfidence: number }> {
    const metrics: Record<ResearchDepth, { times: number[]; successes: number; total: number; confidences: number[] }> = {
      quick: { times: [], successes: 0, total: 0, confidences: [] },
      medium: { times: [], successes: 0, total: 0, confidences: [] },
      deep: { times: [], successes: 0, total: 0, confidences: [] },
    };

    for (const perf of this.queryPerformanceHistory) {
      const m = metrics[perf.depth];
      m.times.push(perf.elapsedMs);
      m.total++;
      if (perf.wasSuccessful) m.successes++;
      m.confidences.push(perf.confidence);
    }

    const result: Record<ResearchDepth, { avgTime: number; successRate: number; avgConfidence: number }> = {
      quick: { avgTime: 0, successRate: 0, avgConfidence: 0 },
      medium: { avgTime: 0, successRate: 0, avgConfidence: 0 },
      deep: { avgTime: 0, successRate: 0, avgConfidence: 0 },
    };

    for (const depth of ['quick', 'medium', 'deep'] as ResearchDepth[]) {
      const m = metrics[depth];
      if (m.total > 0) {
        result[depth] = {
          avgTime: m.times.reduce((a, b) => a + b, 0) / m.times.length,
          successRate: m.successes / m.total,
          avgConfidence: m.confidences.reduce((a, b) => a + b, 0) / m.confidences.length,
        };
      }
    }

    return result;
  }

  // ============================================================================
  // Source Quality Updates
  // ============================================================================

  /**
   * Update source reliability scores based on research outcome
   */
  updateSourceScores(
    sources: Array<{ url: string; relevance: number }>,
    domain: string | undefined,
    wasUseful: boolean
  ): void {
    for (const source of sources) {
      try {
        const urlObj = new URL(source.url);
        const sourceDomain = urlObj.hostname.replace(/^www\./, '');

        this.db.updateSourceQuality(sourceDomain, domain || null, wasUseful);

        this.logger.debug(`Updated source quality: ${sourceDomain}`, {
          topic: domain,
          helpful: wasUseful,
        });
      } catch (e) {
        // Invalid URL, skip
        this.logger.debug(`Skipping invalid URL: ${source.url}`);
      }
    }
  }

  // ============================================================================
  // Recommendations
  // ============================================================================

  /**
   * Get recommended research depth based on query characteristics and learned patterns
   */
  getRecommendedDepth(query: string, domain?: string): DepthRecommendation {
    // Start with medium as default
    let recommended: ResearchDepth = 'medium';
    let confidence = 0.5;
    let reason = 'default recommendation';

    // Analyze query complexity
    const wordCount = query.split(/\s+/).length;
    const hasComparison = /\b(vs|versus|compare|comparison|difference|between)\b/i.test(query);
    const hasHowTo = /\b(how to|how do|implement|create|build|setup|configure)\b/i.test(query);
    const isSimpleLookup = /\b(what is|definition|meaning|explain)\b/i.test(query);

    // Simple lookups can use quick
    if (isSimpleLookup && wordCount < 8) {
      recommended = 'quick';
      confidence = 0.7;
      reason = 'simple lookup detected';
    }
    // Comparisons and complex implementations need deep
    else if (hasComparison || (hasHowTo && wordCount > 15)) {
      recommended = 'deep';
      confidence = 0.7;
      reason = hasComparison ? 'comparison detected' : 'complex implementation detected';
    }
    // How-to questions are medium by default
    else if (hasHowTo) {
      recommended = 'medium';
      confidence = 0.6;
      reason = 'how-to question detected';
    }

    // Check historical performance for this domain
    if (domain) {
      const domainPerformance = this.queryPerformanceHistory.filter(
        p => p.domain === domain && p.resultWasHelpful !== undefined
      );

      if (domainPerformance.length >= 5) {
        // Find the depth with best success rate for this domain
        const depthSuccessRates: Record<ResearchDepth, { success: number; total: number }> = {
          quick: { success: 0, total: 0 },
          medium: { success: 0, total: 0 },
          deep: { success: 0, total: 0 },
        };

        for (const perf of domainPerformance) {
          const dsr = depthSuccessRates[perf.depth];
          dsr.total++;
          if (perf.resultWasHelpful) dsr.success++;
        }

        let bestDepth: ResearchDepth = 'medium';
        let bestRate = 0;

        for (const depth of ['quick', 'medium', 'deep'] as ResearchDepth[]) {
          const dsr = depthSuccessRates[depth];
          if (dsr.total >= 2) {
            const rate = dsr.success / dsr.total;
            if (rate > bestRate) {
              bestRate = rate;
              bestDepth = depth;
            }
          }
        }

        if (bestRate > 0.6) {
          recommended = bestDepth;
          confidence = Math.min(0.9, 0.5 + bestRate / 2);
          reason = `learned from ${domainPerformance.length} past queries in ${domain} domain`;
        }
      }
    }

    this.logger.debug(`Depth recommendation: ${recommended}`, {
      query: query.substring(0, 50),
      domain,
      confidence,
      reason,
    });

    return { recommended, confidence, reason };
  }

  /**
   * Get best sources for a specific topic based on learned quality
   */
  getBestSourcesForDomain(domain: string, limit: number = 5): string[] {
    return this.db.getBestSourcesForTopic(domain, limit);
  }

  /**
   * Get reliable sources across all topics
   */
  getReliableSources(limit: number = 10): SourceQualityEntry[] {
    return this.db.getReliableSources(undefined, limit);
  }

  // ============================================================================
  // Pattern Analysis
  // ============================================================================

  /**
   * Analyze patterns in research approaches and their outcomes
   */
  analyzeApproachPatterns(): ApproachInsights {
    const insights: ApproachInsights = {
      successfulPatterns: [],
      failedPatterns: [],
      recommendedSources: [],
      avgConfidenceByDepth: {
        quick: 0,
        medium: 0,
        deep: 0,
      },
    };

    // Get performance metrics
    const perfByDepth = this.getPerformanceByDepth();
    insights.avgConfidenceByDepth = {
      quick: perfByDepth.quick.avgConfidence,
      medium: perfByDepth.medium.avgConfidence,
      deep: perfByDepth.deep.avgConfidence,
    };

    // Analyze successful patterns
    const successfulQueries = this.queryPerformanceHistory.filter(p => p.resultWasHelpful === true);
    const failedQueries = this.queryPerformanceHistory.filter(p => p.resultWasHelpful === false);

    // Find common patterns in successful queries
    if (successfulQueries.length >= 3) {
      const depthCounts = { quick: 0, medium: 0, deep: 0 };
      for (const q of successfulQueries) {
        depthCounts[q.depth]++;
      }
      const bestDepth = Object.entries(depthCounts).sort((a, b) => b[1] - a[1])[0];
      if (bestDepth[1] > successfulQueries.length * 0.4) {
        insights.successfulPatterns.push(`${bestDepth[0]} depth works well (${bestDepth[1]}/${successfulQueries.length} successes)`);
      }
    }

    // Find common patterns in failed queries
    if (failedQueries.length >= 3) {
      const avgSourcesInFailed = failedQueries.reduce((sum, q) => sum + q.sourcesUsed, 0) / failedQueries.length;
      if (avgSourcesInFailed < 2) {
        insights.failedPatterns.push('failed queries often had fewer than 2 sources');
      }
    }

    // Get recommended sources
    const reliableSources = this.db.getReliableSources(undefined, 5);
    insights.recommendedSources = reliableSources.map(s => s.domain);

    this.logger.debug('Analyzed approach patterns', {
      successfulPatterns: insights.successfulPatterns.length,
      failedPatterns: insights.failedPatterns.length,
      recommendedSources: insights.recommendedSources.length,
    });

    return insights;
  }

  // ============================================================================
  // Implicit Feedback Detection
  // ============================================================================

  /**
   * Detect implicit feedback from session activity
   * This is called periodically to assess if injected research was helpful
   */
  detectImplicitFeedback(
    sessionId: string,
    currentState: {
      recentErrors: string[];
      recentToolUses: Array<{ tool: string; success: boolean }>;
      stuckOnSameFile: boolean;
      retryCount: number;
    },
    previousInjections: InjectionLogEntry[]
  ): Array<{ injectionId: number; feedback: 'positive' | 'negative' | 'neutral' }> {
    const results: Array<{ injectionId: number; feedback: 'positive' | 'negative' | 'neutral' }> = [];

    for (const injection of previousInjections) {
      if (injection.effectivenessScore !== undefined) {
        // Already evaluated
        continue;
      }

      // Check if this injection's finding is still relevant
      const finding = this.db.getFinding(injection.findingId);
      if (!finding) continue;

      let feedback: 'positive' | 'negative' | 'neutral' = 'neutral';

      // Check for positive signals
      const errorRelatedToQuery = currentState.recentErrors.some(
        err => finding.query.toLowerCase().includes(err.toLowerCase().substring(0, 30))
      );

      if (!errorRelatedToQuery && currentState.recentErrors.length === 0) {
        // No related errors and no current errors - might have helped
        feedback = 'positive';
      } else if (errorRelatedToQuery && currentState.retryCount > 2) {
        // Same error and multiple retries - didn't help
        feedback = 'negative';
      } else if (currentState.stuckOnSameFile && injection.injectionLevel === 1) {
        // Stuck and only got summary - might need more detail
        feedback = 'negative';
        // Mark for followup
        this.db.markFollowupInjected(injection.findingId, sessionId);
      }

      if (injection.id !== undefined) {
        results.push({ injectionId: injection.id, feedback });

        // Update the database
        const score = feedback === 'positive' ? 0.5 : feedback === 'negative' ? -0.5 : 0;
        this.db.markInjectionEffective(injection.id, score, feedback === 'positive');
      }
    }

    this.logger.debug(`Detected implicit feedback for ${results.length} injections`, {
      positive: results.filter(r => r.feedback === 'positive').length,
      negative: results.filter(r => r.feedback === 'negative').length,
      neutral: results.filter(r => r.feedback === 'neutral').length,
    });

    return results;
  }

  /**
   * Check if we should auto-inject more detail for a finding
   */
  shouldInjectMoreDetail(
    findingId: string,
    sessionId: string,
    signals: {
      sameErrorRepeated: boolean;
      stuckOnSameFile: boolean;
      retryCount: number;
    }
  ): { shouldInject: boolean; nextLevel: 2 | 3 } {
    const lastInjection = this.db.getLastInjectionForFinding(findingId, sessionId);

    if (!lastInjection) {
      return { shouldInject: false, nextLevel: 2 };
    }

    // Already at full content level
    if (lastInjection.injectionLevel === 3) {
      return { shouldInject: false, nextLevel: 3 };
    }

    // Check if signals indicate we should inject more
    const shouldInject =
      signals.sameErrorRepeated ||
      (signals.stuckOnSameFile && signals.retryCount >= 2) ||
      (lastInjection.followupInjected && lastInjection.injectionLevel < 3);

    const nextLevel = lastInjection.injectionLevel === 1 ? 2 : 3;

    this.logger.debug(`Should inject more detail: ${shouldInject}`, {
      findingId,
      currentLevel: lastInjection.injectionLevel,
      nextLevel,
      signals,
    });

    return { shouldInject, nextLevel: nextLevel as 2 | 3 };
  }
}

// Export singleton factory
let instance: MetaLearner | null = null;

export function getMetaLearner(db: ResearchDatabase): MetaLearner {
  if (!instance) {
    instance = new MetaLearner(db);
  }
  return instance;
}
