/**
 * Source Assessor Agent
 *
 * Evaluates and tracks the quality of information sources.
 * Maintains domain-level and topic-specific reliability scores.
 *
 * Responsibilities:
 * - Assess individual source quality
 * - Track source reliability over time
 * - Detect outdated or deprecated information
 * - Compare source reliability for same topics
 * - Recommend best sources per domain/topic
 */

import { Logger } from '../../utils/logger.js';
import { getDatabase } from '../../database/index.js';
import type { SourceQualityEntry, ResearchSourceWithQuality } from '../../types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Assessment result for a single source
 */
export interface SourceAssessment {
  domain: string;
  url: string;
  reliabilityScore: number;       // 0-1 overall reliability
  factors: {
    domainReputation: number;     // Known reputation of the domain
    contentQuality: number;       // Estimated content quality
    freshness: number;            // How recent the content appears
    relevance: number;            // How relevant to the query
  };
  warnings: SourceWarning[];
  recommendation: 'use' | 'caution' | 'avoid';
}

/**
 * Warning about a source
 */
export interface SourceWarning {
  type: 'outdated' | 'deprecated' | 'low-quality' | 'unreliable' | 'unofficial';
  message: string;
  severity: 'info' | 'warning' | 'error';
}

/**
 * Source comparison result
 */
export interface SourceComparison {
  better: string | null;          // URL of the better source, or null if equal
  scores: Array<{
    url: string;
    domain: string;
    score: number;
  }>;
  explanation: string;
}

/**
 * Domain reliability info
 */
export interface DomainInfo {
  domain: string;
  category: 'official' | 'community' | 'tutorial' | 'blog' | 'forum' | 'unknown';
  baseReliability: number;
  topicStrengths: string[];
}

// ============================================================================
// Known Domains Registry
// ============================================================================

/**
 * Curated list of known domains with baseline reliability
 * This is the "static" foundation that gets enhanced by learning
 */
const KNOWN_DOMAINS: Record<string, DomainInfo> = {
  // Official documentation
  'docs.python.org': { domain: 'docs.python.org', category: 'official', baseReliability: 0.95, topicStrengths: ['python'] },
  'typescriptlang.org': { domain: 'typescriptlang.org', category: 'official', baseReliability: 0.95, topicStrengths: ['typescript'] },
  'react.dev': { domain: 'react.dev', category: 'official', baseReliability: 0.95, topicStrengths: ['react'] },
  'nodejs.org': { domain: 'nodejs.org', category: 'official', baseReliability: 0.95, topicStrengths: ['node', 'javascript'] },
  'developer.mozilla.org': { domain: 'developer.mozilla.org', category: 'official', baseReliability: 0.95, topicStrengths: ['javascript', 'css', 'html', 'web'] },
  'docs.rust-lang.org': { domain: 'docs.rust-lang.org', category: 'official', baseReliability: 0.95, topicStrengths: ['rust'] },
  'go.dev': { domain: 'go.dev', category: 'official', baseReliability: 0.95, topicStrengths: ['go', 'golang'] },

  // Community/Reference
  'stackoverflow.com': { domain: 'stackoverflow.com', category: 'community', baseReliability: 0.75, topicStrengths: [] },
  'github.com': { domain: 'github.com', category: 'community', baseReliability: 0.80, topicStrengths: [] },
  'dev.to': { domain: 'dev.to', category: 'blog', baseReliability: 0.65, topicStrengths: [] },
  'medium.com': { domain: 'medium.com', category: 'blog', baseReliability: 0.55, topicStrengths: [] },
  'reddit.com': { domain: 'reddit.com', category: 'forum', baseReliability: 0.50, topicStrengths: [] },
  'hackernews.com': { domain: 'hackernews.com', category: 'forum', baseReliability: 0.60, topicStrengths: ['startup', 'tech'] },

  // Tutorial sites
  'freecodecamp.org': { domain: 'freecodecamp.org', category: 'tutorial', baseReliability: 0.70, topicStrengths: ['javascript', 'python', 'web'] },
  'realpython.com': { domain: 'realpython.com', category: 'tutorial', baseReliability: 0.80, topicStrengths: ['python'] },
  'digitalocean.com': { domain: 'digitalocean.com', category: 'tutorial', baseReliability: 0.75, topicStrengths: ['devops', 'linux', 'docker'] },
};

// ============================================================================
// Source Assessor Agent
// ============================================================================

export class SourceAssessorAgent {
  private logger: Logger;
  private knownDomains: Map<string, DomainInfo>;

  constructor() {
    this.logger = new Logger('SourceAssessor');
    this.knownDomains = new Map(Object.entries(KNOWN_DOMAINS));
  }

  /**
   * Assess a single source
   */
  assess(source: ResearchSourceWithQuality, query: string, topic?: string): SourceAssessment {
    let domain: string;
    try {
      domain = new URL(source.url).hostname.replace(/^www\./, '');
    } catch {
      domain = 'unknown';
    }

    // Get domain info (from known list or learned)
    const domainInfo = this.getDomainInfo(domain, topic);

    // Calculate factors
    const factors = {
      domainReputation: domainInfo.baseReliability,
      contentQuality: this.estimateContentQuality(source, domainInfo),
      freshness: this.estimateFreshness(source),
      relevance: source.relevance ?? this.estimateRelevance(source, query),
    };

    // Detect warnings
    const warnings = this.detectWarnings(source, domainInfo, factors);

    // Calculate overall score (weighted)
    const reliabilityScore = (
      factors.domainReputation * 0.35 +
      factors.contentQuality * 0.25 +
      factors.freshness * 0.15 +
      factors.relevance * 0.25
    );

    // Determine recommendation
    let recommendation: 'use' | 'caution' | 'avoid';
    if (reliabilityScore >= 0.7 && warnings.filter(w => w.severity === 'error').length === 0) {
      recommendation = 'use';
    } else if (reliabilityScore >= 0.4 || warnings.filter(w => w.severity === 'error').length === 0) {
      recommendation = 'caution';
    } else {
      recommendation = 'avoid';
    }

    return {
      domain,
      url: source.url,
      reliabilityScore,
      factors,
      warnings,
      recommendation,
    };
  }

  /**
   * Assess multiple sources and rank them
   */
  assessMultiple(
    sources: ResearchSourceWithQuality[],
    query: string,
    topic?: string
  ): SourceAssessment[] {
    const assessments = sources.map(s => this.assess(s, query, topic));
    return assessments.sort((a, b) => b.reliabilityScore - a.reliabilityScore);
  }

  /**
   * Compare sources for the same topic
   */
  compare(
    sources: ResearchSourceWithQuality[],
    query: string,
    topic?: string
  ): SourceComparison {
    if (sources.length === 0) {
      return { better: null, scores: [], explanation: 'No sources to compare' };
    }

    const assessments = this.assessMultiple(sources, query, topic);
    const scores = assessments.map(a => ({
      url: a.url,
      domain: a.domain,
      score: a.reliabilityScore,
    }));

    const top = assessments[0];
    const second = assessments[1];

    if (!second || top.reliabilityScore - second.reliabilityScore > 0.1) {
      return {
        better: top.url,
        scores,
        explanation: `${top.domain} has the highest reliability score (${top.reliabilityScore.toFixed(2)})`,
      };
    }

    return {
      better: null,
      scores,
      explanation: `Top sources have similar reliability: ${top.domain} (${top.reliabilityScore.toFixed(2)}) vs ${second.domain} (${second.reliabilityScore.toFixed(2)})`,
    };
  }

  /**
   * Get best sources for a topic from learned database
   */
  getBestSources(topic: string, limit: number = 5): SourceQualityEntry[] {
    try {
      const db = getDatabase();
      return db.getReliableSources(topic, limit);
    } catch (error) {
      this.logger.debug('Failed to get best sources from DB', error);
      return [];
    }
  }

  /**
   * Record source usage feedback
   */
  recordFeedback(source: ResearchSourceWithQuality, wasHelpful: boolean, topic?: string): void {
    let domain: string;
    try {
      domain = new URL(source.url).hostname.replace(/^www\./, '');
    } catch {
      return;
    }

    try {
      const db = getDatabase();
      db.updateSourceQuality(domain, topic ?? null, wasHelpful);
      this.logger.debug(`Recorded ${wasHelpful ? 'positive' : 'negative'} feedback for ${domain}`);
    } catch (error) {
      this.logger.debug('Failed to record source feedback', error);
    }
  }

  /**
   * Add a new known domain (runtime learning)
   */
  learnDomain(domain: string, info: Partial<DomainInfo>): void {
    const existing = this.knownDomains.get(domain);
    this.knownDomains.set(domain, {
      domain,
      category: info.category ?? existing?.category ?? 'unknown',
      baseReliability: info.baseReliability ?? existing?.baseReliability ?? 0.5,
      topicStrengths: info.topicStrengths ?? existing?.topicStrengths ?? [],
    });
  }

  // ============================================================================
  // Private: Analysis Methods
  // ============================================================================

  private getDomainInfo(domain: string, topic?: string): DomainInfo {
    // First check known domains
    const known = this.knownDomains.get(domain);
    if (known) {
      // Boost reliability if topic matches strengths
      if (topic && known.topicStrengths.some(t => topic.toLowerCase().includes(t))) {
        return {
          ...known,
          baseReliability: Math.min(known.baseReliability + 0.1, 1),
        };
      }
      return known;
    }

    // Check learned database
    try {
      const db = getDatabase();
      const learned = db.getReliableSources(domain, 1);
      if (learned.length > 0) {
        return {
          domain,
          category: 'unknown',
          baseReliability: learned[0].reliabilityScore,
          topicStrengths: learned[0].topicCategory ? [learned[0].topicCategory] : [],
        };
      }
    } catch {
      // DB not available
    }

    // Default for unknown domains
    return {
      domain,
      category: 'unknown',
      baseReliability: 0.5,
      topicStrengths: [],
    };
  }

  private estimateContentQuality(source: ResearchSourceWithQuality, domainInfo: DomainInfo): number {
    let score = domainInfo.baseReliability;

    // Boost for snippet presence
    if (source.snippet && source.snippet.length > 50) {
      score += 0.05;
    }

    // Penalty for very short titles
    if (source.title.length < 10) {
      score -= 0.1;
    }

    // Boost for official documentation category
    if (domainInfo.category === 'official') {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, score));
  }

  private estimateFreshness(source: ResearchSourceWithQuality): number {
    // Look for date indicators in title or snippet
    const text = `${source.title} ${source.snippet || ''}`.toLowerCase();

    // Check for year references
    const currentYear = new Date().getFullYear();
    if (text.includes(String(currentYear))) return 1;
    if (text.includes(String(currentYear - 1))) return 0.85;
    if (text.includes(String(currentYear - 2))) return 0.7;
    if (text.includes(String(currentYear - 3))) return 0.5;

    // Look for "deprecated" or "outdated" keywords
    if (text.includes('deprecated') || text.includes('outdated') || text.includes('legacy')) {
      return 0.3;
    }

    // Default assumption: moderately fresh
    return 0.7;
  }

  private estimateRelevance(source: ResearchSourceWithQuality, query: string): number {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const titleWords = source.title.toLowerCase().split(/\s+/);
    const snippetWords = (source.snippet || '').toLowerCase().split(/\s+/);

    const allWords = [...titleWords, ...snippetWords];
    const matchingWords = queryWords.filter(qw =>
      allWords.some(w => w.includes(qw) || qw.includes(w))
    );

    return queryWords.length > 0 ? matchingWords.length / queryWords.length : 0.5;
  }

  private detectWarnings(
    source: ResearchSourceWithQuality,
    domainInfo: DomainInfo,
    factors: SourceAssessment['factors']
  ): SourceWarning[] {
    const warnings: SourceWarning[] = [];
    const text = `${source.title} ${source.snippet || ''}`.toLowerCase();

    // Deprecated content
    if (text.includes('deprecated')) {
      warnings.push({
        type: 'deprecated',
        message: 'Content mentions deprecated features',
        severity: 'warning',
      });
    }

    // Outdated content
    if (text.includes('outdated') || factors.freshness < 0.4) {
      warnings.push({
        type: 'outdated',
        message: 'Content may be outdated',
        severity: 'warning',
      });
    }

    // Low quality domain
    if (domainInfo.baseReliability < 0.5) {
      warnings.push({
        type: 'low-quality',
        message: `${domainInfo.domain} has low historical reliability`,
        severity: 'info',
      });
    }

    // Unofficial source for official topic
    if (domainInfo.category === 'blog' || domainInfo.category === 'forum') {
      warnings.push({
        type: 'unofficial',
        message: 'User-generated content - verify with official docs',
        severity: 'info',
      });
    }

    // Low relevance
    if (factors.relevance < 0.3) {
      warnings.push({
        type: 'unreliable',
        message: 'Low relevance to query',
        severity: 'warning',
      });
    }

    return warnings;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let assessorInstance: SourceAssessorAgent | null = null;

export function getSourceAssessor(): SourceAssessorAgent {
  if (!assessorInstance) {
    assessorInstance = new SourceAssessorAgent();
  }
  return assessorInstance;
}
