/**
 * Research Detail Skill
 *
 * Allows Claude to request more detail from a previous research finding.
 * Part of the progressive disclosure system:
 * - Level 1: Summary only (initial injection)
 * - Level 2: Key points (this skill, default)
 * - Level 3: Full content (this skill, explicit request)
 *
 * Usage:
 *   research-detail({ findingId: "abc123" })                    // Get key_points
 *   research-detail({ findingId: "abc123", level: "full" })     // Get full content
 */

import { getDatabase } from '../database/index.js';
import { Logger } from '../utils/logger.js';
import type { ResearchFinding, InjectionLevel } from '../types.js';

const logger = new Logger('ResearchDetailSkill');

// ============================================================================
// Types
// ============================================================================

export interface ResearchDetailInput {
  findingId: string;
  level?: 'key_points' | 'full';
  sessionId?: string;
}

export interface ResearchDetailOutput {
  success: boolean;
  findingId?: string;
  level?: InjectionLevel;
  // Content at requested level
  query?: string;
  summary?: string;
  keyPoints?: string[];
  fullContent?: string;
  sources?: Array<{
    title: string;
    url: string;
    snippet?: string;
    relevance?: number;
  }>;
  domain?: string;
  confidence?: number;
  message: string;
}

// ============================================================================
// Main Skill Handler
// ============================================================================

/**
 * Get more detail from a previous research finding
 */
export async function researchDetail(input: ResearchDetailInput): Promise<ResearchDetailOutput> {
  const { findingId, level = 'key_points', sessionId } = input;

  // Validate input
  if (!findingId || findingId.trim().length === 0) {
    return {
      success: false,
      message: 'findingId is required',
    };
  }

  const trimmedId = findingId.trim();

  try {
    const db = getDatabase();

    // Get the finding
    const finding = db.getFinding(trimmedId);

    if (!finding) {
      // Try searching by query if ID not found (fuzzy lookup)
      const similar = db.searchFindings(trimmedId, 1);
      if (similar.length > 0) {
        return buildResponse(similar[0], level, sessionId, db, true);
      }

      return {
        success: false,
        message: `Finding not found: ${trimmedId}. Use research-status skill to see recent findings.`,
      };
    }

    return buildResponse(finding, level, sessionId, db, false);
  } catch (error) {
    logger.error('Failed to get research detail', error);
    return {
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Build the response at the requested detail level
 */
function buildResponse(
  finding: ResearchFinding,
  level: 'key_points' | 'full',
  sessionId: string | undefined,
  db: ReturnType<typeof getDatabase>,
  wasFuzzyMatch: boolean
): ResearchDetailOutput {
  const injectionLevel: InjectionLevel = level === 'full' ? 3 : 2;

  // Log this injection at higher level
  if (sessionId) {
    try {
      db.logInjection({
        findingId: finding.id,
        sessionId,
        injectedAt: Date.now(),
        injectionLevel,
        triggerReason: 'manual',
        followupInjected: false,
        resolvedIssue: false,
      });
    } catch (e) {
      logger.debug('Failed to log injection', e);
    }
  }

  logger.info(`Providing level ${injectionLevel} detail for finding ${finding.id}`);

  // Build response based on level
  const response: ResearchDetailOutput = {
    success: true,
    findingId: finding.id,
    level: injectionLevel,
    query: finding.query,
    summary: finding.summary,
    domain: finding.domain,
    confidence: finding.confidence,
    message: wasFuzzyMatch
      ? `Found similar research (fuzzy match): "${finding.query}"`
      : `Research detail for: "${finding.query}"`,
  };

  // Always include sources
  if (finding.sources && finding.sources.length > 0) {
    response.sources = finding.sources.map(s => ({
      title: s.title,
      url: s.url,
      snippet: s.snippet,
      relevance: s.relevance,
    }));
  }

  // Level 2: Include key points
  if (injectionLevel >= 2) {
    response.keyPoints = finding.keyPoints || [];
  }

  // Level 3: Include full content
  if (injectionLevel >= 3 && finding.fullContent) {
    response.fullContent = finding.fullContent;
  }

  return response;
}

// ============================================================================
// Exports
// ============================================================================

export default researchDetail;

// Skill metadata for registration
export const metadata = {
  name: 'research-detail',
  description: 'Get more detail from a previous research finding. Use when you need deeper information than the initial summary injection provided.',
  parameters: {
    findingId: {
      type: 'string',
      required: true,
      description: 'The ID of the research finding (shown in summary injection)',
    },
    level: {
      type: 'string',
      enum: ['key_points', 'full'],
      default: 'key_points',
      description: 'key_points: bullet point insights, full: complete scraped content',
    },
    sessionId: {
      type: 'string',
      required: false,
      description: 'Session ID for tracking (optional)',
    },
  },
  examples: [
    {
      input: { findingId: 'abc123' },
      description: 'Get key points from a finding',
    },
    {
      input: { findingId: 'abc123', level: 'full' },
      description: 'Get full content from a finding',
    },
    {
      input: { findingId: 'how to implement rate limiting' },
      description: 'Fuzzy search by query text if ID not known',
    },
  ],
};
