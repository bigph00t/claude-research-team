/**
 * Fetch Skill
 *
 * Targeted URL fetching for Claude to get specific content from links.
 * Unlike /research which does broad searches, this fetches a specific URL
 * and extracts its content directly.
 *
 * Uses Jina Reader for content extraction (free, no API key required).
 *
 * Usage:
 *   fetch({ url: "https://docs.example.com/api" })
 *   fetch({ url: "https://github.com/user/repo", query: "installation instructions" })
 */

import { getDatabase } from '../database/index.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('FetchSkill');

// Jina Reader URL for content extraction
const JINA_READER_URL = 'https://r.jina.ai/';

// ============================================================================
// Types
// ============================================================================

export interface FetchSkillInput {
  url: string;
  query?: string;            // Optional: focus extraction on specific content
  maxLength?: number;        // Max content length (default: 12000)
  store?: boolean;           // Store in research DB for future reference (default: true)
  sessionId?: string;
}

export interface FetchSkillOutput {
  success: boolean;
  url?: string;
  title?: string;
  content?: string;
  excerpt?: string;          // Short excerpt if content is long
  truncated?: boolean;
  storedId?: string;         // ID if stored in database
  message: string;
}

// ============================================================================
// Main Skill Handler
// ============================================================================

/**
 * Fetch content from a specific URL
 */
export async function fetchUrl(input: FetchSkillInput): Promise<FetchSkillOutput> {
  const {
    url,
    query,
    maxLength = 12000,
    store = true,
    sessionId,
  } = input;

  // Validate URL
  if (!url || url.trim().length === 0) {
    return {
      success: false,
      message: 'URL is required',
    };
  }

  const trimmedUrl = url.trim();

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl.startsWith('http') ? trimmedUrl : `https://${trimmedUrl}`);
  } catch {
    return {
      success: false,
      message: `Invalid URL: ${trimmedUrl}`,
    };
  }

  const normalizedUrl = parsedUrl.toString();
  logger.info(`Fetching: ${normalizedUrl}${query ? ` (query: "${query}")` : ''}`);

  try {
    // Fetch content using Jina Reader
    const response = await fetch(`${JINA_READER_URL}${normalizedUrl}`, {
      headers: { 'Accept': 'text/plain' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return {
        success: false,
        url: normalizedUrl,
        message: `Failed to fetch: HTTP ${response.status}`,
      };
    }

    const fullContent = await response.text();

    if (!fullContent || fullContent.trim().length === 0) {
      return {
        success: false,
        url: normalizedUrl,
        message: 'Page returned empty content',
      };
    }

    // Extract title from content (Jina typically includes it at the start)
    const titleMatch = fullContent.match(/^Title:\s*(.+?)(?:\n|$)/i) ||
                       fullContent.match(/^#\s*(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].trim() : new URL(normalizedUrl).hostname;

    // Process content
    let content = fullContent;
    let truncated = false;

    // If query provided, try to extract relevant sections
    if (query) {
      content = extractRelevantSections(fullContent, query, maxLength);
    }

    // Truncate if needed
    if (content.length > maxLength) {
      content = content.slice(0, maxLength);
      truncated = true;
    }

    // Create excerpt for long content
    const excerpt = content.length > 500
      ? content.slice(0, 500).trim() + '...'
      : undefined;

    // Store in database if requested
    let storedId: string | undefined;
    if (store) {
      try {
        const db = getDatabase();
        storedId = storeAsFinding(db, {
          url: normalizedUrl,
          title,
          content,
          query,
          sessionId,
        });
        logger.info(`Stored as finding: ${storedId}`);
      } catch (e) {
        logger.debug('Failed to store finding', e);
      }
    }

    logger.info(`Fetch complete: ${content.length} chars${truncated ? ' (truncated)' : ''}`);

    return {
      success: true,
      url: normalizedUrl,
      title,
      content,
      excerpt,
      truncated,
      storedId,
      message: `Fetched ${normalizedUrl}${truncated ? ' (truncated)' : ''}`,
    };

  } catch (error) {
    logger.error('Fetch failed', error);

    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        url: normalizedUrl,
        message: 'Request timed out (30s)',
      };
    }

    return {
      success: false,
      url: normalizedUrl,
      message: `Fetch error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract sections of content most relevant to the query
 */
function extractRelevantSections(content: string, query: string, maxLength: number): string {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const lines = content.split('\n');
  const scoredLines: Array<{ line: string; score: number; index: number }> = [];

  // Score each line by query word matches
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    let score = 0;

    for (const word of queryWords) {
      if (lower.includes(word)) {
        score += 1;
        // Bonus for exact word matches
        if (new RegExp(`\\b${word}\\b`, 'i').test(line)) {
          score += 0.5;
        }
      }
    }

    // Bonus for headers
    if (line.startsWith('#') || line.startsWith('##')) {
      score += 0.5;
    }

    scoredLines.push({ line, score, index: i });
  }

  // If no matches, return original content
  const matchingLines = scoredLines.filter(l => l.score > 0);
  if (matchingLines.length === 0) {
    return content;
  }

  // Sort by score, then by position
  matchingLines.sort((a, b) => b.score - a.score || a.index - b.index);

  // Build result with context around matching lines
  const resultLines: string[] = [];
  const includedIndices = new Set<number>();

  for (const match of matchingLines) {
    if (resultLines.join('\n').length >= maxLength) break;

    // Include 2 lines before and 5 lines after for context
    const start = Math.max(0, match.index - 2);
    const end = Math.min(lines.length - 1, match.index + 5);

    for (let i = start; i <= end; i++) {
      if (!includedIndices.has(i)) {
        includedIndices.add(i);
        resultLines.push(lines[i]);
      }
    }

    // Add separator between sections
    if (resultLines.length > 0 && !resultLines[resultLines.length - 1].includes('---')) {
      resultLines.push('---');
    }
  }

  return resultLines.join('\n');
}

/**
 * Store fetched content as a research finding
 */
function storeAsFinding(
  db: ReturnType<typeof getDatabase>,
  data: {
    url: string;
    title: string;
    content: string;
    query?: string;
    sessionId?: string;
  }
): string {
  const id = crypto.randomUUID();

  db.saveFinding({
    id,
    query: data.query || `Fetched: ${data.url}`,
    summary: `Content from ${data.title}: ${data.content.slice(0, 200)}...`,
    keyPoints: extractKeyPoints(data.content),
    fullContent: data.content,
    sources: [{
      title: data.title,
      url: data.url,
      snippet: data.content.slice(0, 300),
      relevance: 1.0,
    }],
    domain: extractDomain(data.url),
    depth: 'quick',
    confidence: 0.95,  // High confidence for direct fetch
    createdAt: Date.now(),
    projectPath: data.sessionId ? undefined : undefined,
  });

  return id;
}

/**
 * Extract key points from content
 */
function extractKeyPoints(content: string): string[] {
  const points: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Look for bullet points and headers
    if (line.match(/^[-*•]\s+.{10,}/) || line.match(/^#{1,3}\s+.+/)) {
      const cleaned = line.replace(/^[-*•#]+\s*/, '').trim();
      if (cleaned.length > 10 && cleaned.length < 200 && points.length < 10) {
        points.push(cleaned);
      }
    }
  }

  return points.slice(0, 5);
}

/**
 * Extract domain category from URL
 */
function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('github')) return 'github';
    if (hostname.includes('stackoverflow')) return 'stackoverflow';
    if (hostname.includes('docs.')) return 'documentation';
    if (hostname.includes('api.')) return 'api';
    if (hostname.includes('npm')) return 'npm';
    if (hostname.includes('pypi')) return 'python';
    return 'web';
  } catch {
    return 'web';
  }
}

// ============================================================================
// Exports
// ============================================================================

export default fetchUrl;

// Skill metadata for registration
export const metadata = {
  name: 'fetch',
  description: 'Fetch content from a specific URL. Use when you have a direct link and need its content, rather than doing a broad search.',
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: 'The URL to fetch content from',
    },
    query: {
      type: 'string',
      required: false,
      description: 'Optional query to focus extraction on relevant sections',
    },
    maxLength: {
      type: 'number',
      default: 12000,
      description: 'Maximum content length to return (default: 12000 chars)',
    },
    store: {
      type: 'boolean',
      default: true,
      description: 'Store in research database for future reference',
    },
    sessionId: {
      type: 'string',
      required: false,
      description: 'Session ID for tracking',
    },
  },
  examples: [
    {
      input: { url: 'https://docs.example.com/api/auth' },
      description: 'Fetch API documentation',
    },
    {
      input: { url: 'https://github.com/user/repo', query: 'installation' },
      description: 'Fetch GitHub repo focusing on installation instructions',
    },
    {
      input: { url: 'https://stackoverflow.com/questions/12345', query: 'solution' },
      description: 'Fetch StackOverflow answer focusing on the solution',
    },
    {
      input: { url: 'https://npmjs.com/package/express', maxLength: 5000 },
      description: 'Fetch npm package info with limited length',
    },
  ],
};
