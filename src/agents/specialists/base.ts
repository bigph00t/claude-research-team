/**
 * Base Specialist Agent
 *
 * Abstract base class for domain-specialized research agents.
 * Each specialist has specific tools they're expert with and
 * can execute focused searches in their domain.
 */

import { Logger } from '../../utils/logger.js';
import { getDatabase } from '../../database/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single search result from any source
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;         // Which tool/API produced this
  relevance?: number;     // 0-1 relevance score
  metadata?: Record<string, unknown>;
}

/**
 * Scraped content from a URL
 */
export interface ScrapedContent {
  url: string;
  content: string;
  title?: string;
  truncated?: boolean;
}

/**
 * A research finding from a specialist
 */
export interface Finding {
  query: string;
  specialist: string;
  results: SearchResult[];
  scraped: ScrapedContent[];
  timestamp: number;
  duration: number;
}

/**
 * Directive for a specialist agent
 */
export interface SpecialistDirective {
  query: string;
  context?: string;
  maxResults?: number;
  scrapeTop?: number;
  timeoutMs?: number;
}

/**
 * Tool definition for a specialist
 */
export interface SpecialistTool {
  name: string;
  description: string;
  requiresApiKey?: string;
  search: (query: string, maxResults: number) => Promise<SearchResult[]>;
}

// ============================================================================
// Base Specialist Agent
// ============================================================================

export abstract class BaseSpecialistAgent {
  protected logger: Logger;
  protected tools: Map<string, SpecialistTool> = new Map();

  abstract readonly name: string;
  abstract readonly domain: string;
  abstract readonly description: string;

  constructor() {
    this.logger = new Logger(`Specialist:${this.constructor.name}`);
  }

  /**
   * Register a tool this specialist can use
   */
  protected registerTool(tool: SpecialistTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get available tools (those with API keys configured)
   */
  getAvailableTools(): SpecialistTool[] {
    return Array.from(this.tools.values()).filter(tool => {
      if (!tool.requiresApiKey) return true;
      return !!process.env[tool.requiresApiKey];
    });
  }

  /**
   * Check if this specialist is operational (has at least one tool available)
   */
  isOperational(): boolean {
    return this.getAvailableTools().length > 0;
  }

  /**
   * Execute a research directive
   */
  async execute(directive: SpecialistDirective): Promise<Finding> {
    const startTime = Date.now();
    const maxResults = directive.maxResults ?? 10;
    const scrapeTop = directive.scrapeTop ?? 3;
    const timeoutMs = directive.timeoutMs ?? 30000;

    this.logger.info(`Executing: "${directive.query}"`, {
      maxResults,
      scrapeTop,
      availableTools: this.getAvailableTools().map(t => t.name),
    });

    // Search using available tools
    const allResults: SearchResult[] = [];
    const availableTools = this.getAvailableTools();

    if (availableTools.length === 0) {
      this.logger.warn('No tools available for this specialist');
      return this.createEmptyFinding(directive.query, startTime);
    }

    // Execute searches in parallel across tools
    const searchPromises = availableTools.map(async tool => {
      try {
        const results = await Promise.race([
          tool.search(directive.query, Math.ceil(maxResults / availableTools.length)),
          this.timeout(timeoutMs, `${tool.name} search timeout`),
        ]) as SearchResult[];
        return results;
      } catch (error) {
        this.logger.warn(`Tool ${tool.name} failed`, error);
        return [];
      }
    });

    const toolResults = await Promise.all(searchPromises);
    for (const results of toolResults) {
      allResults.push(...results);
    }

    // Deduplicate by URL
    const deduped = this.deduplicateResults(allResults);
    this.logger.debug(`Found ${deduped.length} unique results`);

    // Scrape top results
    const scraped = await this.scrapeTopResults(
      deduped.slice(0, scrapeTop),
      Math.floor(timeoutMs / scrapeTop)
    );

    const duration = Date.now() - startTime;
    this.logger.info(`Completed in ${duration}ms`, {
      results: deduped.length,
      scraped: scraped.length,
    });

    return {
      query: directive.query,
      specialist: this.name,
      results: deduped.slice(0, maxResults),
      scraped,
      timestamp: Date.now(),
      duration,
    };
  }

  /**
   * Scrape content from URLs using Jina Reader (with caching)
   */
  protected async scrapeTopResults(
    results: SearchResult[],
    perPageTimeoutMs: number
  ): Promise<ScrapedContent[]> {
    const scraped: ScrapedContent[] = [];
    const JINA_READER_URL = 'https://r.jina.ai/';
    const db = getDatabase();

    let cacheHits = 0;
    let cacheMisses = 0;

    await Promise.all(
      results.map(async result => {
        try {
          // Check cache first
          const cached = db.getCachedUrl(result.url);
          if (cached) {
            cacheHits++;
            scraped.push({
              url: result.url,
              content: cached.content,
              title: cached.title || result.title,
              truncated: false,
            });
            return;
          }

          // Cache miss - scrape with Jina
          cacheMisses++;
          const response = await fetch(`${JINA_READER_URL}${result.url}`, {
            headers: { 'Accept': 'text/plain' },
            signal: AbortSignal.timeout(perPageTimeoutMs),
          });

          if (response.ok) {
            const text = await response.text();
            const content = text.slice(0, 8000);

            // Cache the content
            db.cacheUrl(result.url, content, { title: result.title });

            scraped.push({
              url: result.url,
              content,
              title: result.title,
              truncated: text.length > 8000,
            });
          }
        } catch (error) {
          this.logger.debug(`Failed to scrape ${result.url}`, error);
        }
      })
    );

    if (cacheHits > 0 || cacheMisses > 0) {
      this.logger.debug(`URL cache: ${cacheHits} hits, ${cacheMisses} misses`);
    }

    return scraped;
  }

  /**
   * Deduplicate results by URL
   */
  protected deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    return results.filter(r => {
      const normalized = this.normalizeUrl(r.url);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  /**
   * Normalize URL for deduplication
   */
  protected normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Remove trailing slashes and query params for basic normalization
      return `${parsed.host}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Create timeout promise
   */
  protected timeout<T>(ms: number, message: string): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Create empty finding when no results
   */
  private createEmptyFinding(query: string, startTime: number): Finding {
    return {
      query,
      specialist: this.name,
      results: [],
      scraped: [],
      timestamp: Date.now(),
      duration: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Helper to make HTTP requests with timeout
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse JSON response safely
 */
export async function safeParseJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}
