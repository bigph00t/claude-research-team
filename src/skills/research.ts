/**
 * Research Skill
 *
 * Manual research interface for Claude to explicitly request research.
 * Uses the AutonomousResearchCrew with depth-based iteration limits.
 *
 * Depths:
 * - quick: 1 iteration (~10s) - simple facts, definitions
 * - medium: 2 iterations (~30s) - how-to, documentation (default)
 * - deep: 4 iterations (~60s) - comprehensive comparisons, complex topics
 *
 * Usage:
 *   research({ query: "how to implement rate limiting in FastAPI" })
 *   research({ query: "Rust vs Go for CLI tools", depth: "deep" })
 */

import type { ResearchDepth } from '../types.js';
import { getAutonomousCrew, type CrewResult } from '../crew/autonomous-crew.js';
import { Logger } from '../utils/logger.js';

const SERVICE_URL = process.env.CLAUDE_RESEARCH_URL || 'http://localhost:3200';
const logger = new Logger('ResearchSkill');

// ============================================================================
// Types
// ============================================================================

export interface ResearchSkillInput {
  query: string;
  depth?: ResearchDepth;
  context?: string;
  sessionId?: string;
  mode?: 'execute' | 'queue';  // Default: execute (immediate)
}

export interface ResearchSkillOutput {
  success: boolean;
  // Direct execution results
  summary?: string;
  keyFindings?: string[];
  sources?: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
  confidence?: number;
  duration?: number;
  pivot?: {
    alternative: string;
    reason: string;
    urgency: 'low' | 'medium' | 'high';
  };
  // Queue mode results
  taskId?: string;
  // Common
  message: string;
}

// ============================================================================
// Main Skill Handler
// ============================================================================

/**
 * Execute research immediately or queue for background processing
 */
export async function research(input: ResearchSkillInput): Promise<ResearchSkillOutput> {
  const {
    query,
    depth = 'medium',
    context,
    sessionId,
    mode = 'execute'  // Default to immediate execution
  } = input;

  // Validate query
  if (!query || query.trim().length === 0) {
    return {
      success: false,
      message: 'Query is required',
    };
  }

  const trimmedQuery = query.trim();

  // Route based on mode
  if (mode === 'queue') {
    return queueResearch(trimmedQuery, depth, context);
  }

  return executeResearch(trimmedQuery, depth, context, sessionId);
}

// ============================================================================
// Direct Execution (Default)
// ============================================================================

/**
 * Execute research immediately using AutonomousResearchCrew
 * Returns results directly without queuing
 */
async function executeResearch(
  query: string,
  depth: ResearchDepth,
  context?: string,
  sessionId?: string
): Promise<ResearchSkillOutput> {
  logger.info(`Executing research: "${query}" (${depth})`);
  const startTime = Date.now();

  try {
    const crew = getAutonomousCrew();

    // Check if crew is operational
    if (!crew.isOperational()) {
      logger.warn('Crew not operational, falling back to queue mode');
      return queueResearch(query, depth, context);
    }

    // Execute with depth-based iteration limits
    const result: CrewResult = await crew.explore({
      query,
      depth,
      context,
      sessionId,
    });

    const elapsed = Date.now() - startTime;
    logger.info(`Research complete in ${elapsed}ms: confidence=${result.confidence}`);

    return {
      success: true,
      summary: result.summary,
      keyFindings: result.keyFindings,
      sources: result.sources.slice(0, 5).map(s => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
      })),
      confidence: result.confidence,
      duration: result.duration,
      pivot: result.pivot ? {
        alternative: result.pivot.alternative,
        reason: result.pivot.reason,
        urgency: result.pivot.urgency,
      } : undefined,
      message: formatResultMessage(result, depth),
    };
  } catch (error) {
    logger.error('Research execution failed', error);

    // Try falling back to queue mode
    try {
      logger.info('Falling back to queue mode');
      return queueResearch(query, depth, context);
    } catch {
      return {
        success: false,
        message: `Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

// ============================================================================
// Queue Mode (Background)
// ============================================================================

/**
 * Queue research for background processing via the service
 * Results will be injected later when relevant
 */
async function queueResearch(
  query: string,
  depth: ResearchDepth,
  context?: string
): Promise<ResearchSkillOutput> {
  try {
    // Check if service is running
    const healthCheck = await fetch(`${SERVICE_URL}/api/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);

    if (!healthCheck?.ok) {
      return {
        success: false,
        message: 'Research service is not running. Start it with: claude-research-team start',
      };
    }

    // Queue the research
    const response = await fetch(`${SERVICE_URL}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        depth,
        context,
        priority: depthToPriority(depth),
        trigger: 'manual',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        success: false,
        message: `Failed to queue research: HTTP ${response.status}`,
      };
    }

    const data = await response.json() as { success: boolean; data: { id: string } };

    if (data.success) {
      return {
        success: true,
        taskId: data.data.id,
        message: `Research queued: "${query}" (${depth} depth). Results will be passively injected when relevant.`,
      };
    } else {
      return {
        success: false,
        message: 'Failed to queue research',
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Queue error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a human-readable result message
 */
function formatResultMessage(result: CrewResult, depth: ResearchDepth): string {
  const parts: string[] = [];

  parts.push(`Research complete (${depth}, ${result.iterations} iterations, ${Math.round(result.duration / 1000)}s)`);

  if (result.confidence < 0.5) {
    parts.push('⚠️ Low confidence - consider deeper research');
  } else if (result.confidence >= 0.85) {
    parts.push('✓ High confidence');
  }

  if (result.pivot) {
    parts.push(`💡 Alternative approach detected: ${result.pivot.alternative}`);
  }

  return parts.join('. ');
}

/**
 * Map depth to priority for queue mode
 */
function depthToPriority(depth: ResearchDepth): number {
  switch (depth) {
    case 'quick': return 4;
    case 'medium': return 6;
    case 'deep': return 8;
    default: return 6;
  }
}

// ============================================================================
// Exports
// ============================================================================

export default research;

// Skill metadata for registration
export const metadata = {
  name: 'research',
  description: 'Research a topic using web search and specialist agents. Returns findings directly or queues for background processing.',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'The research query or topic',
    },
    depth: {
      type: 'string',
      enum: ['quick', 'medium', 'deep'],
      default: 'medium',
      description: 'Research depth: quick (~10s, 1 iteration), medium (~30s, 2 iterations), deep (~60s, 4 iterations)',
    },
    context: {
      type: 'string',
      required: false,
      description: 'Additional context to focus the research',
    },
    sessionId: {
      type: 'string',
      required: false,
      description: 'Session ID for context tracking',
    },
    mode: {
      type: 'string',
      enum: ['execute', 'queue'],
      default: 'execute',
      description: 'execute: immediate results, queue: background processing with later injection',
    },
  },
  examples: [
    {
      input: { query: 'What is HTMX?', depth: 'quick' },
      description: 'Quick fact lookup',
    },
    {
      input: { query: 'How to implement rate limiting in FastAPI' },
      description: 'How-to with medium depth (default)',
    },
    {
      input: { query: 'Rust vs Go for CLI tools', depth: 'deep' },
      description: 'Deep comparison research',
    },
    {
      input: { query: 'best TTS API', context: 'comparing quality and cost for YouTube automation', depth: 'deep' },
      description: 'Deep research with context',
    },
  ],
};
