/**
 * Research Executor
 * Executes research tasks using Claude Agent SDK for synthesis
 *
 * Architecture:
 * 1. Memory Check: Search past research to avoid redundant work
 * 2. Search: Use configured search APIs (Serper, Brave, Tavily)
 * 3. Scrape: Use Jina Reader (free, unlimited) for content extraction
 * 4. Synthesize: Use Claude Agent SDK for intelligent summarization
 * 5. Store: Persist results to memory for future learning
 */

import type { ResearchTask, ResearchResult, ResearchDepth, ResearchFinding } from '../types.js';
import { Logger } from '../utils/logger.js';
import { queryAI } from '../ai/provider.js';
import { getDatabase } from '../database/index.js';
// NOTE: claude-mem integration removed - using own database only
import { v4 as uuidv4 } from 'uuid';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface DepthConfig {
  maxResults: number;
  maxScrape: number;
  timeoutMs: number;
}

const DEPTH_CONFIGS: Record<ResearchDepth, DepthConfig> = {
  quick: { maxResults: 5, maxScrape: 2, timeoutMs: 15000 },
  medium: { maxResults: 10, maxScrape: 4, timeoutMs: 30000 },
  deep: { maxResults: 20, maxScrape: 8, timeoutMs: 60000 },
};

// Jina Reader - Free web scraping service
const JINA_READER_URL = 'https://r.jina.ai/';

export class ResearchExecutor {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('ResearchExecutor');
  }

  /**
   * Execute a research task
   */
  async execute(task: ResearchTask): Promise<ResearchResult> {
    this.logger.info(`Executing research: ${task.id}`, { query: task.query, depth: task.depth });
    const startTime = Date.now();
    const config = DEPTH_CONFIGS[task.depth];

    // Using own database only (claude-mem disabled)
    const db = getDatabase();

    try {
      // Step 0a: Check for semantically similar queries (deduplication)
      if (db.isVectorReady()) {
        const dupCheck = await db.hasRecentSimilarQueryAsync(task.query, 3600000, 0.80);
        if (dupCheck.found && dupCheck.findingId) {
          const existing = db.getFinding(dupCheck.findingId);
          if (existing) {
            this.logger.info(`Skipping - semantically similar query exists (${((dupCheck.similarity || 0) * 100).toFixed(0)}%): "${existing.query}"`);
            return {
              summary: `[Deduplicated] Similar research already exists: "${existing.query}"\n\n${existing.summary}`,
              fullContent: existing.fullContent || '',
              sources: (existing.sources || []).map(s => ({
                title: s.title,
                url: s.url,
                snippet: s.snippet,
                relevance: s.relevance,
                qualityScore: s.qualityScore,
              })),
              tokensUsed: 0,
              confidence: existing.confidence,
              relevance: 1.0,
              findingId: existing.id,
            };
          }
        }
      }

      // Step 0b: Check for existing/related research in local database
      // Uses semantic search when vector DB is available
      let relatedContext = '';
      try {
        const existingFindings = await db.findRelatedFindings(task.query, 5);
        if (existingFindings.length > 0) {
          this.logger.info(`Found ${existingFindings.length} related findings via ${db.isVectorReady() ? 'semantic' : 'keyword'} search`);
          relatedContext = this.buildRelatedContext(
            existingFindings.map(f => ({
              query: f.query,
              summary: f.summary,
              confidence: f.confidence,
            }))
          );
        }
      } catch (e) {
        this.logger.debug('Related research lookup skipped', e);
      }

      // Step 1: Search the web
      const searchResults = await this.search(task.query, config.maxResults);
      this.logger.debug(`Found ${searchResults.length} search results`);

      if (searchResults.length === 0) {
        return this.createEmptyResult(task.query);
      }

      // Step 2: Scrape top results
      const scrapedContent = await this.scrapeTopResults(
        searchResults.slice(0, config.maxScrape),
        config.timeoutMs
      );
      this.logger.debug(`Scraped ${scrapedContent.length} pages`);

      // Step 3: Synthesize with Claude (include related research context)
      const enrichedContext = [task.context, relatedContext].filter(Boolean).join('\n\n');
      const synthesis = await this.synthesize(task.query, searchResults, scrapedContent, task.depth, enrichedContext || undefined);

      const duration = Date.now() - startTime;
      this.logger.info(`Research completed in ${duration}ms`);

      const result: ResearchResult = {
        summary: synthesis.summary,
        fullContent: synthesis.fullContent,
        sources: searchResults.map((r, i) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          relevance: 1 - (i * 0.05), // Decreasing relevance by position
        })),
        tokensUsed: this.estimateTokens(synthesis.summary),
        confidence: synthesis.confidence,  // Source quality score
        relevance: 0.5,  // Default - actual relevance computed post-research
      };

      // Step 4: Store research in local database
      const findingId = uuidv4();
      try {
        const finding: ResearchFinding = {
          id: findingId,
          query: task.query,
          summary: result.summary,
          keyPoints: this.extractKeyPoints(result.summary),
          fullContent: result.fullContent,
          sources: result.sources.map(s => ({
            ...s,
            qualityScore: s.relevance,
          })),
          domain: this.inferDomain(task.query),
          depth: task.depth,
          confidence: result.confidence,
          createdAt: Date.now(),
        };

        const claudeMemResult = db.saveFinding(finding, {
          projectPath: task.projectPath,
          sessionId: task.sessionId,
        });
        this.logger.info(`Research stored in local database: ${findingId}`, {
          projectPath: task.projectPath,
          claudeMemObservationId: claudeMemResult?.observationId,
        });

        // Embed finding in vector database for semantic search
        try {
          await db.embedFinding(finding);
          this.logger.debug(`Finding embedded in vector DB: ${findingId}`);
        } catch (embedError) {
          this.logger.warn('Failed to embed finding in vector DB (non-fatal)', embedError);
        }

        // Add findingId to result for progressive disclosure
        result.findingId = findingId;
      } catch (e) {
        this.logger.warn('Failed to store research', e);
      }

      return result;
    } catch (error) {
      this.logger.error(`Research failed: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * Build context from related past research
   */
  private buildRelatedContext(related: Array<{ query: string; summary: string; confidence: number }>): string {
    if (related.length === 0) return '';

    const parts = ['## Previous Related Research'];
    for (const r of related.slice(0, 3)) {
      parts.push(`**Query**: ${r.query}`);
      parts.push(`**Summary**: ${r.summary.slice(0, 300)}...`);
      parts.push('');
    }
    parts.push('Use this prior knowledge to provide more comprehensive insights. Focus on NEW information not covered above.');
    return parts.join('\n');
  }

  /**
   * Extract key points from a summary
   */
  private extractKeyPoints(summary: string): string[] {
    // Split by sentences and filter for substantive ones
    const sentences = summary
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 30 && s.length < 200);

    // Take up to 5 key sentences
    return sentences.slice(0, 5);
  }

  /**
   * Infer domain/topic from query
   */
  private inferDomain(queryText: string): string | undefined {
    const lowerQuery = queryText.toLowerCase();

    // Common tech domains
    const domainPatterns: Record<string, RegExp> = {
      typescript: /\b(typescript|ts|tsx)\b/,
      javascript: /\b(javascript|js|node|npm|deno|bun)\b/,
      react: /\b(react|jsx|next\.?js|gatsby)\b/,
      python: /\b(python|pip|django|flask|fastapi)\b/,
      rust: /\b(rust|cargo|rustc)\b/,
      go: /\b(golang|go\s+lang)\b/,
      docker: /\b(docker|container|kubernetes|k8s)\b/,
      database: /\b(sql|database|postgres|mysql|mongodb|redis)\b/,
      api: /\b(api|rest|graphql|grpc|http)\b/,
      git: /\b(git|github|gitlab|version control)\b/,
      ai: /\b(ai|machine learning|llm|gpt|claude|anthropic)\b/,
      devops: /\b(devops|ci\/cd|jenkins|github actions)\b/,
    };

    for (const [domain, pattern] of Object.entries(domainPatterns)) {
      if (pattern.test(lowerQuery)) {
        return domain;
      }
    }

    return undefined;
  }

  /**
   * Search using available search APIs
   */
  private async search(searchQuery: string, maxResults: number): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Try Serper first (most reliable)
    if (process.env.SERPER_API_KEY) {
      try {
        const serperResults = await this.searchSerper(searchQuery, maxResults);
        results.push(...serperResults);
      } catch (e) {
        this.logger.warn('Serper search failed', e);
      }
    }

    // Fall back to Brave
    if (results.length < maxResults && process.env.BRAVE_API_KEY) {
      try {
        const braveResults = await this.searchBrave(searchQuery, maxResults - results.length);
        results.push(...braveResults);
      } catch (e) {
        this.logger.warn('Brave search failed', e);
      }
    }

    // Fall back to Tavily
    if (results.length < maxResults && process.env.TAVILY_API_KEY) {
      try {
        const tavilyResults = await this.searchTavily(searchQuery, maxResults - results.length);
        results.push(...tavilyResults);
      } catch (e) {
        this.logger.warn('Tavily search failed', e);
      }
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    return results.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
  }

  /**
   * Search using Serper API
   */
  private async searchSerper(searchQuery: string, num: number): Promise<SearchResult[]> {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: searchQuery, num }),
    });

    if (!response.ok) throw new Error(`Serper API error: ${response.status}`);

    const data = await response.json() as {
      organic?: Array<{ title: string; link: string; snippet: string }>;
    };

    return (data.organic || []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));
  }

  /**
   * Search using Brave Search API
   */
  private async searchBrave(searchQuery: string, count: number): Promise<SearchResult[]> {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQuery)}&count=${count}`,
      {
        headers: {
          'X-Subscription-Token': process.env.BRAVE_API_KEY!,
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) throw new Error(`Brave API error: ${response.status}`);

    const data = await response.json() as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    return (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }

  /**
   * Search using Tavily API
   */
  private async searchTavily(searchQuery: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: searchQuery,
        max_results: maxResults,
      }),
    });

    if (!response.ok) throw new Error(`Tavily API error: ${response.status}`);

    const data = await response.json() as {
      results?: Array<{ title: string; url: string; content: string }>;
    };

    return (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }

  /**
   * Scrape content from URLs using Jina Reader (with caching)
   */
  private async scrapeTopResults(
    results: SearchResult[],
    timeoutMs: number
  ): Promise<Array<{ url: string; content: string; cached?: boolean }>> {
    const scraped: Array<{ url: string; content: string; cached?: boolean }> = [];
    const perPageTimeout = Math.floor(timeoutMs / results.length);
    const db = getDatabase();

    let cacheHits = 0;
    let cacheMisses = 0;

    await Promise.all(
      results.map(async (result) => {
        try {
          // Check cache first
          const cached = db.getCachedUrl(result.url);
          if (cached) {
            cacheHits++;
            scraped.push({ url: result.url, content: cached.content, cached: true });
            return;
          }

          // Cache miss - scrape with Jina
          cacheMisses++;
          const content = await this.scrapeWithJina(result.url, perPageTimeout);
          if (content) {
            // Cache the content
            db.cacheUrl(result.url, content, { title: result.title });
            scraped.push({ url: result.url, content, cached: false });
          }
        } catch (e) {
          this.logger.debug(`Failed to scrape ${result.url}`, e);
        }
      })
    );

    if (cacheHits > 0 || cacheMisses > 0) {
      this.logger.info(`URL cache: ${cacheHits} hits, ${cacheMisses} misses`);
    }

    return scraped;
  }

  /**
   * Scrape a URL using Jina Reader (free)
   */
  private async scrapeWithJina(url: string, timeoutMs: number): Promise<string | null> {
    try {
      const response = await fetch(`${JINA_READER_URL}${url}`, {
        headers: { 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) return null;

      const text = await response.text();
      // Limit content length to avoid token bloat
      return text.slice(0, 8000);
    } catch {
      return null;
    }
  }

  /**
   * Synthesize research using configured AI provider
   */
  private async synthesize(
    searchQuery: string,
    searchResults: SearchResult[],
    scrapedContent: Array<{ url: string; content: string }>,
    depth: ResearchDepth,
    context?: string
  ): Promise<{ summary: string; fullContent: string; confidence: number }> {
    // Build the prompt
    const prompt = this.buildSynthesisPrompt(searchQuery, searchResults, scrapedContent, depth, context);

    try {
      // Use the AI provider abstraction
      const result = await queryAI(prompt, {
        maxTokens: 2048,
        temperature: 0.5,
      });

      this.logger.debug(`Synthesis by ${result.provider} (${result.model})`, {
        tokensUsed: result.tokensUsed,
      });

      // Parse the response
      return this.parseSynthesisResponse(result.content);
    } catch (error) {
      this.logger.error('AI synthesis failed', error);
      // Fall back to simple summary
      return this.createFallbackSynthesis(searchQuery, searchResults);
    }
  }

  /**
   * Build the synthesis prompt - depth-aware and action-oriented
   */
  private buildSynthesisPrompt(
    searchQuery: string,
    searchResults: SearchResult[],
    scrapedContent: Array<{ url: string; content: string }>,
    depth: ResearchDepth,
    context?: string
  ): string {
    const parts: string[] = [];

    parts.push(`Research Query: "${searchQuery}"`);
    if (context) {
      parts.push(`Context: ${context}`);
    }
    parts.push('');

    parts.push('## Search Results');
    for (const result of searchResults.slice(0, 10)) {
      parts.push(`- **${result.title}**: ${result.snippet}`);
      parts.push(`  URL: ${result.url}`);
    }
    parts.push('');

    if (scrapedContent.length > 0) {
      parts.push('## Detailed Content');
      for (const { url, content } of scrapedContent) {
        parts.push(`### From: ${url}`);
        parts.push(content.slice(0, 2000));
        parts.push('');
      }
    }

    parts.push('---');
    parts.push('');

    // Depth-aware instructions for actionable output
    if (depth === 'quick') {
      parts.push('Provide a CONCISE, ACTIONABLE response:');
      parts.push('1. A brief summary (2-3 sentences max) with the direct answer and key recommendation');
      parts.push('2. 2-3 key points that are immediately actionable (focus on "how to" not "what is")');
      parts.push('3. A confidence score (0-1) based on source quality');
      parts.push('');
      parts.push('Be direct and practical. Skip background info - focus on what the developer needs to do.');
    } else if (depth === 'medium') {
      parts.push('Provide a PRACTICAL response:');
      parts.push('1. A summary (3-4 sentences) with the answer and main recommendations');
      parts.push('2. 4-5 key findings with actionable details (code patterns, best practices, common pitfalls)');
      parts.push('3. A confidence score (0-1) based on source quality and consistency');
      parts.push('');
      parts.push('Balance explanation with actionable guidance. Include specific techniques or code patterns.');
    } else {
      parts.push('Provide a COMPREHENSIVE response:');
      parts.push('1. A thorough summary (4-6 sentences) covering the topic completely');
      parts.push('2. 6-8 key findings with detailed explanations, trade-offs, and alternatives');
      parts.push('3. A confidence score (0-1) based on source quality and consistency');
      parts.push('');
      parts.push('Include trade-offs, edge cases, and alternative approaches. Be thorough but organized.');
    }

    parts.push('');
    parts.push('Format your response as:');
    parts.push('SUMMARY: <your summary>');
    parts.push('KEY_FINDINGS:');
    parts.push('- <finding 1>');
    parts.push('- <finding 2>');
    parts.push('CONFIDENCE: <0.0-1.0>');

    return parts.join('\n');
  }

  /**
   * Parse Claude's synthesis response
   */
  private parseSynthesisResponse(
    response: string
  ): { summary: string; fullContent: string; confidence: number } {
    let summary = '';
    let confidence = 0.5;
    const findings: string[] = [];

    // Extract summary
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?=KEY_FINDINGS:|CONFIDENCE:|$)/s);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    }

    // Extract key findings
    const findingsMatch = response.match(/KEY_FINDINGS:\s*(.+?)(?=CONFIDENCE:|$)/s);
    if (findingsMatch) {
      const findingsText = findingsMatch[1];
      const bulletPoints = findingsText.match(/^-\s*.+$/gm);
      if (bulletPoints) {
        findings.push(...bulletPoints.map(b => b.replace(/^-\s*/, '')));
      }
    }

    // Extract confidence
    const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confidenceMatch) {
      confidence = parseFloat(confidenceMatch[1]);
      confidence = Math.max(0, Math.min(1, confidence));
    }

    // Build full content
    const fullContent = [
      summary,
      '',
      '## Key Findings',
      ...findings.map(f => `- ${f}`),
    ].join('\n');

    return { summary, fullContent, confidence };
  }

  /**
   * Create fallback synthesis when Claude fails
   */
  private createFallbackSynthesis(
    searchQuery: string,
    searchResults: SearchResult[]
  ): { summary: string; fullContent: string; confidence: number } {
    const topResults = searchResults.slice(0, 3);
    const summary = topResults.map(r => r.snippet).join(' ').slice(0, 500);

    return {
      summary: summary || `Research results for: ${searchQuery}`,
      fullContent: [
        `## Research: ${searchQuery}`,
        '',
        '### Top Results',
        ...topResults.map(r => `- **${r.title}**: ${r.snippet}`),
      ].join('\n'),
      confidence: 0.4,
    };
  }

  /**
   * Create empty result when no search results found
   */
  private createEmptyResult(searchQuery: string): ResearchResult {
    return {
      summary: `No results found for: ${searchQuery}`,
      fullContent: `Unable to find relevant information for: ${searchQuery}`,
      sources: [],
      tokensUsed: 20,
      confidence: 0,
      relevance: 0,
    };
  }

  /**
   * Estimate token count (~4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
