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

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ResearchTask, ResearchResult, ResearchDepth, ResearchFinding } from '../types.js';
import { Logger } from '../utils/logger.js';
import { getMemoryIntegration } from '../memory/memory-integration.js';
import { getDatabase } from '../database/index.js';
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
  private memoryInitialized: boolean = false;

  constructor() {
    this.logger = new Logger('ResearchExecutor');
  }

  /**
   * Initialize memory integration
   */
  private async ensureMemory(): Promise<void> {
    if (this.memoryInitialized) return;
    try {
      const memory = getMemoryIntegration();
      await memory.initialize();
      this.memoryInitialized = true;
      this.logger.debug('Memory integration ready');
    } catch (error) {
      this.logger.warn('Memory integration unavailable, continuing without persistence', error);
    }
  }

  /**
   * Execute a research task
   */
  async execute(task: ResearchTask): Promise<ResearchResult> {
    this.logger.info(`Executing research: ${task.id}`, { query: task.query, depth: task.depth });
    const startTime = Date.now();
    const config = DEPTH_CONFIGS[task.depth];

    // Initialize integrations
    await this.ensureMemory();
    const memory = getMemoryIntegration();
    const db = getDatabase();

    try {
      // Step 0: Check for existing/related research in local database
      let relatedContext = '';
      try {
        const existingFindings = db.searchFindings(task.query, 5);
        if (existingFindings.length > 0) {
          this.logger.info(`Found ${existingFindings.length} related findings in local database`);
          relatedContext = this.buildRelatedContext(
            existingFindings.map(f => ({
              query: f.query,
              summary: f.summary,
              confidence: f.confidence,
            }))
          );
        }
      } catch (e) {
        this.logger.debug('Local database lookup skipped', e);
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
      const synthesis = await this.synthesize(task.query, searchResults, scrapedContent, enrichedContext || undefined);

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
        confidence: synthesis.confidence,
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

        db.saveFinding(finding);
        this.logger.info(`Research stored in local database: ${findingId}`);

        // Step 5: Optionally inject to claude-mem if high quality
        const injectionResult = await memory.injectFindingIfQualified(finding, task.sessionId);
        if (injectionResult.injected) {
          this.logger.info(`Injected to claude-mem: observation #${injectionResult.observationId}`);
        } else {
          this.logger.debug(`Not injected to claude-mem: ${injectionResult.reason}`);
        }
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
   * Scrape content from URLs using Jina Reader
   */
  private async scrapeTopResults(
    results: SearchResult[],
    timeoutMs: number
  ): Promise<Array<{ url: string; content: string }>> {
    const scraped: Array<{ url: string; content: string }> = [];
    const perPageTimeout = Math.floor(timeoutMs / results.length);

    await Promise.all(
      results.map(async (result) => {
        try {
          const content = await this.scrapeWithJina(result.url, perPageTimeout);
          if (content) {
            scraped.push({ url: result.url, content });
          }
        } catch (e) {
          this.logger.debug(`Failed to scrape ${result.url}`, e);
        }
      })
    );

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
   * Synthesize research using Claude Agent SDK
   */
  private async synthesize(
    searchQuery: string,
    searchResults: SearchResult[],
    scrapedContent: Array<{ url: string; content: string }>,
    context?: string
  ): Promise<{ summary: string; fullContent: string; confidence: number }> {
    // Build the prompt for Claude
    const prompt = this.buildSynthesisPrompt(searchQuery, searchResults, scrapedContent, context);

    try {
      // Use Claude Agent SDK query function
      const queryGenerator = query({
        prompt,
        options: {
          maxTurns: 1,
          tools: [], // No tools needed for synthesis
        },
      });

      // Collect the result
      let resultText = '';
      for await (const message of queryGenerator) {
        if (message.type === 'result' && message.subtype === 'success') {
          resultText = message.result;
          break;
        }
      }

      // Parse the response
      return this.parseSynthesisResponse(resultText);
    } catch (error) {
      this.logger.error('Claude synthesis failed', error);
      // Fall back to simple summary
      return this.createFallbackSynthesis(searchQuery, searchResults);
    }
  }

  /**
   * Build the synthesis prompt
   */
  private buildSynthesisPrompt(
    searchQuery: string,
    searchResults: SearchResult[],
    scrapedContent: Array<{ url: string; content: string }>,
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
    parts.push('Based on the above research, provide:');
    parts.push('1. A comprehensive summary (4-6 sentences) answering the query with key details');
    parts.push('2. Key findings as bullet points (5-8 points covering important details, code examples, best practices)');
    parts.push('3. A confidence score (0-1) based on source quality and consistency');
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
    };
  }

  /**
   * Estimate token count (~4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
