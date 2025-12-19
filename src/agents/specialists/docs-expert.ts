/**
 * Documentation Expert Specialist Agent
 *
 * Expert at finding documentation, academic papers, and discussions.
 * Tools: ArXiv, Wikipedia, HackerNews, Official Documentation
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';

export class DocsExpertAgent extends BaseSpecialistAgent {
  readonly name = 'DocsExpert';
  readonly domain = 'docs';
  readonly description = 'Documentation search using Wikipedia, ArXiv, HackerNews, and official docs';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // Wikipedia
    this.registerTool({
      name: 'wikipedia',
      description: 'Wikipedia - encyclopedic knowledge',
      search: this.searchWikipedia.bind(this),
    });

    // ArXiv
    this.registerTool({
      name: 'arxiv',
      description: 'ArXiv - academic papers in CS, Math, Physics',
      search: this.searchArxiv.bind(this),
    });

    // HackerNews (Algolia API - free)
    this.registerTool({
      name: 'hackernews',
      description: 'HackerNews - tech community discussions',
      search: this.searchHackerNews.bind(this),
    });

    // MDN Web Docs (via Serper)
    this.registerTool({
      name: 'mdn',
      description: 'MDN Web Docs - web development documentation',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchMDN.bind(this),
    });

    // Official Docs via Serper (targeted sites)
    this.registerTool({
      name: 'official_docs',
      description: 'Official documentation sites',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchOfficialDocs.bind(this),
    });

    // Dev.to
    this.registerTool({
      name: 'devto',
      description: 'Dev.to - developer community articles',
      search: this.searchDevTo.bind(this),
    });
  }

  /**
   * Search Wikipedia
   */
  private async searchWikipedia(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(maxResults));
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');

    const response = await fetchWithTimeout(url.toString(), {}, 10000);

    if (!response.ok) return [];

    interface WikipediaResponse {
      query?: {
        search?: Array<{
          title: string;
          pageid: number;
          snippet: string;
          wordcount: number;
        }>;
      };
    }

    const data = await safeParseJson<WikipediaResponse>(response);
    if (!data?.query?.search) return [];

    return data.query.search.map((item, i) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: item.snippet.replace(/<[^>]*>/g, ''), // Strip HTML
      source: 'wikipedia',
      relevance: 1 - (i * 0.05),
      metadata: {
        pageId: item.pageid,
        wordCount: item.wordcount,
      },
    }));
  }

  /**
   * Search ArXiv
   */
  private async searchArxiv(query: string, maxResults: number): Promise<SearchResult[]> {
    // ArXiv API returns Atom XML - we'll parse the essentials
    const url = new URL('http://export.arxiv.org/api/query');
    url.searchParams.set('search_query', `all:${query}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(maxResults));
    url.searchParams.set('sortBy', 'relevance');

    const response = await fetchWithTimeout(url.toString(), {}, 15000);

    if (!response.ok) return [];

    const text = await response.text();
    return this.parseArxivXml(text);
  }

  /**
   * Parse ArXiv Atom XML response
   */
  private parseArxivXml(xml: string): SearchResult[] {
    const results: SearchResult[] = [];

    // Simple regex-based parsing for ArXiv entries
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    const titleRegex = /<title>([\s\S]*?)<\/title>/;
    const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
    const idRegex = /<id>([\s\S]*?)<\/id>/;
    const authorRegex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g;

    let match;
    let position = 0;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];

      const titleMatch = entry.match(titleRegex);
      const summaryMatch = entry.match(summaryRegex);
      const idMatch = entry.match(idRegex);

      if (titleMatch && idMatch) {
        // Extract authors
        const authors: string[] = [];
        let authorMatch;
        while ((authorMatch = authorRegex.exec(entry)) !== null) {
          authors.push(authorMatch[1].trim());
          if (authors.length >= 3) break;
        }

        const title = titleMatch[1].replace(/\s+/g, ' ').trim();
        const summary = summaryMatch
          ? summaryMatch[1].replace(/\s+/g, ' ').trim().slice(0, 300)
          : '';
        const arxivId = idMatch[1].trim();
        const url = arxivId.startsWith('http') ? arxivId : `https://arxiv.org/abs/${arxivId.split('/').pop()}`;

        results.push({
          title,
          url,
          snippet: summary || `By ${authors.slice(0, 3).join(', ')}`,
          source: 'arxiv',
          relevance: 1 - (position * 0.05),
          metadata: {
            arxivId,
            authors,
          },
        });

        position++;
      }
    }

    return results;
  }

  /**
   * Search HackerNews (via Algolia API)
   */
  private async searchHackerNews(query: string, maxResults: number): Promise<SearchResult[]> {
    // Search stories
    const url = new URL('https://hn.algolia.com/api/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('hitsPerPage', String(maxResults));

    const response = await fetchWithTimeout(url.toString(), {}, 10000);

    if (!response.ok) return [];

    interface HNResponse {
      hits?: Array<{
        title: string;
        url?: string;
        objectID: string;
        author: string;
        points: number;
        num_comments: number;
        created_at: string;
        story_text?: string;
      }>;
    }

    const data = await safeParseJson<HNResponse>(response);
    if (!data?.hits) return [];

    return data.hits.map((item, i) => ({
      title: item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
      snippet: item.story_text?.slice(0, 200) ||
               `${item.points} points, ${item.num_comments} comments by ${item.author}`,
      source: 'hackernews',
      relevance: 1 - (i * 0.05),
      metadata: {
        hnId: item.objectID,
        points: item.points,
        comments: item.num_comments,
        author: item.author,
      },
    }));
  }

  /**
   * Search MDN Web Docs
   */
  private async searchMDN(query: string, maxResults: number): Promise<SearchResult[]> {
    // Use MDN's own search API
    const url = new URL('https://developer.mozilla.org/api/v1/search');
    url.searchParams.set('q', query);
    url.searchParams.set('size', String(maxResults));
    url.searchParams.set('locale', 'en-US');

    const response = await fetchWithTimeout(url.toString(), {}, 10000);

    if (!response.ok) {
      // Fall back to Serper
      return this.searchSerperSite('developer.mozilla.org', query, maxResults, 'mdn');
    }

    interface MDNResponse {
      documents?: Array<{
        title: string;
        slug: string;
        locale: string;
        summary: string;
        mdn_url: string;
      }>;
    }

    const data = await safeParseJson<MDNResponse>(response);
    if (!data?.documents) return [];

    return data.documents.map((item, i) => ({
      title: item.title,
      url: `https://developer.mozilla.org${item.mdn_url}`,
      snippet: item.summary,
      source: 'mdn',
      relevance: 1 - (i * 0.05),
    }));
  }

  /**
   * Search Official Docs (multiple authoritative sites)
   */
  private async searchOfficialDocs(query: string, maxResults: number): Promise<SearchResult[]> {
    // Target authoritative documentation sites
    const sites = [
      'docs.python.org',
      'nodejs.org/docs',
      'reactjs.org',
      'vuejs.org',
      'docs.rust-lang.org',
      'go.dev/doc',
      'typescriptlang.org',
      'kubernetes.io/docs',
      'docs.docker.com',
      'docs.aws.amazon.com',
    ];

    const siteQuery = sites.map(s => `site:${s}`).join(' OR ');
    const fullQuery = `(${siteQuery}) ${query}`;

    return this.searchSerperSite('', fullQuery, maxResults, 'official_docs');
  }

  /**
   * Search Dev.to articles
   */
  private async searchDevTo(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://dev.to/api/articles');
    url.searchParams.set('per_page', String(maxResults));
    url.searchParams.set('tag', query.toLowerCase().replace(/\s+/g, ''));

    // First try tag search
    let response = await fetchWithTimeout(url.toString(), {}, 10000);

    // If no tag results, use search
    if (!response.ok || (await response.clone().json() as unknown[]).length === 0) {
      const searchUrl = new URL('https://dev.to/search/feed_content');
      searchUrl.searchParams.set('per_page', String(maxResults));
      searchUrl.searchParams.set('search_fields', query);
      searchUrl.searchParams.set('class_name', 'Article');

      response = await fetchWithTimeout(searchUrl.toString(), {}, 10000);
    }

    if (!response.ok) return [];

    interface DevToResponse {
      result?: Array<{
        title: string;
        path: string;
        user?: {
          username: string;
        };
        class_name: string;
      }>;
    }

    interface DevToArticle {
      title: string;
      url: string;
      description: string;
      user: {
        username: string;
      };
      positive_reactions_count: number;
      comments_count: number;
    }

    const data = await response.json();

    // Handle both response formats
    if (Array.isArray(data)) {
      return (data as DevToArticle[]).map((item, i) => ({
        title: item.title,
        url: item.url || `https://dev.to${item.url}`,
        snippet: item.description || `By ${item.user?.username}`,
        source: 'devto',
        relevance: 1 - (i * 0.05),
        metadata: {
          author: item.user?.username,
          reactions: item.positive_reactions_count,
          comments: item.comments_count,
        },
      }));
    } else if ((data as DevToResponse).result) {
      return ((data as DevToResponse).result || []).map((item, i) => ({
        title: item.title,
        url: `https://dev.to${item.path}`,
        snippet: `By ${item.user?.username || 'unknown'}`,
        source: 'devto',
        relevance: 1 - (i * 0.05),
      }));
    }

    return [];
  }

  /**
   * Helper: Search via Serper with site restriction
   */
  private async searchSerperSite(
    site: string,
    query: string,
    maxResults: number,
    source: string
  ): Promise<SearchResult[]> {
    const fullQuery = site ? `site:${site} ${query}` : query;

    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: fullQuery,
          num: maxResults,
        }),
      },
      10000
    );

    if (!response.ok) return [];

    interface SerperResponse {
      organic?: Array<{
        title: string;
        link: string;
        snippet: string;
      }>;
    }

    const data = await safeParseJson<SerperResponse>(response);
    if (!data?.organic) return [];

    return data.organic.map((item, i) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: `serper:${source}`,
      relevance: 1 - (i * 0.05),
    }));
  }
}
