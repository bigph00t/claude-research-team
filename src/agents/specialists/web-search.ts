/**
 * Web Search Specialist Agent
 *
 * Expert at general web search using multiple search engines.
 * Tools: Serper, Brave, Tavily
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';

export class WebSearchAgent extends BaseSpecialistAgent {
  readonly name = 'WebSearch';
  readonly domain = 'web';
  readonly description = 'General web search using Serper, Brave, and Tavily search engines';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // Serper (Google Search)
    this.registerTool({
      name: 'serper',
      description: 'Google Search via Serper API - most comprehensive web results',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchSerper.bind(this),
    });

    // Brave Search
    this.registerTool({
      name: 'brave',
      description: 'Brave Search - privacy-focused web search',
      requiresApiKey: 'BRAVE_API_KEY',
      search: this.searchBrave.bind(this),
    });

    // Tavily
    this.registerTool({
      name: 'tavily',
      description: 'Tavily - AI-optimized search engine',
      requiresApiKey: 'TAVILY_API_KEY',
      search: this.searchTavily.bind(this),
    });
  }

  /**
   * Search using Serper (Google)
   */
  private async searchSerper(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: maxResults }),
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Serper API error: ${response.status}`);
    }

    interface SerperResponse {
      organic?: Array<{
        title: string;
        link: string;
        snippet: string;
        position?: number;
      }>;
      answerBox?: {
        title?: string;
        answer?: string;
        snippet?: string;
      };
      knowledgeGraph?: {
        title?: string;
        description?: string;
      };
    }

    const data = await safeParseJson<SerperResponse>(response);
    if (!data) return [];

    const results: SearchResult[] = [];

    // Add answer box if present
    if (data.answerBox?.answer || data.answerBox?.snippet) {
      results.push({
        title: data.answerBox.title || 'Direct Answer',
        url: 'https://google.com',
        snippet: data.answerBox.answer || data.answerBox.snippet || '',
        source: 'serper:answer_box',
        relevance: 1.0,
      });
    }

    // Add organic results
    if (data.organic) {
      for (const item of data.organic) {
        results.push({
          title: item.title,
          url: item.link,
          snippet: item.snippet,
          source: 'serper',
          relevance: item.position ? 1 - (item.position * 0.05) : 0.8,
        });
      }
    }

    return results.slice(0, maxResults);
  }

  /**
   * Search using Brave
   */
  private async searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'X-Subscription-Token': process.env.BRAVE_API_KEY!,
          'Accept': 'application/json',
        },
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Brave API error: ${response.status}`);
    }

    interface BraveResponse {
      web?: {
        results?: Array<{
          title: string;
          url: string;
          description: string;
          age?: string;
        }>;
      };
      query?: {
        spellcheck_off?: boolean;
        altered_query?: string;
      };
    }

    const data = await safeParseJson<BraveResponse>(response);
    if (!data?.web?.results) return [];

    return data.web.results.map((item, i) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      source: 'brave',
      relevance: 1 - (i * 0.05),
      metadata: item.age ? { age: item.age } : undefined,
    }));
  }

  /**
   * Search using Tavily
   */
  private async searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: true,
        }),
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    interface TavilyResponse {
      answer?: string;
      results?: Array<{
        title: string;
        url: string;
        content: string;
        score: number;
      }>;
    }

    const data = await safeParseJson<TavilyResponse>(response);
    if (!data) return [];

    const results: SearchResult[] = [];

    // Add direct answer if available
    if (data.answer) {
      results.push({
        title: 'AI-Generated Answer',
        url: 'https://tavily.com',
        snippet: data.answer,
        source: 'tavily:answer',
        relevance: 1.0,
      });
    }

    // Add search results
    if (data.results) {
      for (const item of data.results) {
        results.push({
          title: item.title,
          url: item.url,
          snippet: item.content,
          source: 'tavily',
          relevance: item.score || 0.8,
        });
      }
    }

    return results.slice(0, maxResults);
  }
}
