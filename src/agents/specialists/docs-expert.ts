/**
 * Documentation Expert Specialist Agent
 *
 * Expert at finding library documentation, package info, and API references.
 * Tools: Context7, npm, PyPI, crates.io, MDN, Dev.to
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';
import { getContext7Adapter } from '../../adapters/context7-adapter.js';

export class DocsExpertAgent extends BaseSpecialistAgent {
  readonly name = 'DocsExpert';
  readonly domain = 'docs';
  readonly description = 'Library documentation using Context7, npm, PyPI, crates.io, MDN, and Dev.to';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // Context7 - Deep library documentation (highest priority)
    this.registerTool({
      name: 'context7',
      description: 'Context7 - Curated library documentation with code examples',
      search: this.searchContext7.bind(this),
    });

    // npm Registry (no API key required)
    this.registerTool({
      name: 'npm',
      description: 'npm Registry - Node.js/JavaScript package documentation',
      search: this.searchNpm.bind(this),
    });

    // PyPI (no API key required)
    this.registerTool({
      name: 'pypi',
      description: 'PyPI - Python package documentation',
      search: this.searchPyPi.bind(this),
    });

    // crates.io (Rust packages - no API key required)
    this.registerTool({
      name: 'crates',
      description: 'crates.io - Rust crate documentation',
      search: this.searchCrates.bind(this),
    });

    // MDN Web Docs
    this.registerTool({
      name: 'mdn',
      description: 'MDN Web Docs - Web platform documentation',
      search: this.searchMDN.bind(this),
    });

    // Dev.to tutorials
    this.registerTool({
      name: 'devto',
      description: 'Dev.to - Developer tutorials and guides',
      search: this.searchDevTo.bind(this),
    });

    // Official docs via Serper
    this.registerTool({
      name: 'official_docs',
      description: 'Official documentation sites via web search',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchOfficialDocs.bind(this),
    });
  }

  /**
   * Search Context7 for library documentation
   */
  private async searchContext7(query: string, maxResults: number): Promise<SearchResult[]> {
    const adapter = getContext7Adapter();

    try {
      const result = await adapter.searchDocs(query);
      if (!result) return [];

      const { library, docs } = result;

      // Context7 returns comprehensive docs - split into logical sections
      const content = docs.content;
      const results: SearchResult[] = [];

      // Main documentation result
      results.push({
        title: `${library.name} Documentation`,
        url: `https://context7.com/${library.id.replace(/^\//, '')}`,
        snippet: content.slice(0, 500),
        source: 'context7',
        relevance: 1.0, // Highest relevance - authoritative source
        metadata: {
          libraryId: library.id,
          libraryName: library.name,
          tokenCount: docs.tokenCount,
          fullContent: content,
        },
      });

      // If content is long, extract code examples as separate results
      const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
      for (let i = 0; i < Math.min(codeBlocks.length, maxResults - 1); i++) {
        const block = codeBlocks[i];
        const firstLine = block.split('\n')[0].replace('```', '').trim();
        results.push({
          title: `${library.name} Code Example${firstLine ? `: ${firstLine}` : ''}`,
          url: `https://context7.com/${library.id.replace(/^\//, '')}#example-${i + 1}`,
          snippet: block.slice(0, 300),
          source: 'context7:example',
          relevance: 0.95 - (i * 0.05),
          metadata: {
            libraryId: library.id,
            exampleIndex: i,
            language: firstLine || 'code',
          },
        });
      }

      return results.slice(0, maxResults);
    } catch (error) {
      this.logger.debug('Context7 search failed', { error });
      return [];
    }
  }

  /**
   * Search npm Registry
   */
  private async searchNpm(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${maxResults}`,
      {},
      10000
    );

    if (!response.ok) return [];

    interface NpmResponse {
      objects?: Array<{
        package: {
          name: string;
          version: string;
          description?: string;
          keywords?: string[];
          links?: {
            npm?: string;
            homepage?: string;
            repository?: string;
          };
        };
        score?: {
          final: number;
          detail: {
            quality: number;
            popularity: number;
            maintenance: number;
          };
        };
      }>;
    }

    const data = await safeParseJson<NpmResponse>(response);
    if (!data?.objects) return [];

    return data.objects.map((obj, index) => {
      // Use detail scores (0-1) instead of final (can be 1000+)
      const detail = obj.score?.detail;
      const relevance = detail
        ? (detail.quality + detail.popularity + detail.maintenance) / 3
        : 0.7 - (index * 0.05);

      return {
        title: `${obj.package.name}@${obj.package.version}`,
        url: obj.package.links?.npm || `https://www.npmjs.com/package/${obj.package.name}`,
        snippet: obj.package.description || obj.package.keywords?.join(', ') || 'npm package',
        source: 'npm',
        relevance,
        metadata: {
          version: obj.package.version,
          keywords: obj.package.keywords,
          quality: obj.score?.detail?.quality,
          popularity: obj.score?.detail?.popularity,
          homepage: obj.package.links?.homepage,
          repository: obj.package.links?.repository,
        },
      };
    });
  }

  /**
   * Search PyPI
   */
  private async searchPyPi(query: string, maxResults: number): Promise<SearchResult[]> {
    // PyPI search returns HTML, not JSON - use workarounds
    // First try to get specific package if query looks like a package name
    if (query.match(/^[a-zA-Z0-9_-]+$/)) {
      const directResult = await this.searchPyPiPackage(query);
      if (directResult.length > 0) return directResult;
    }

    // Fall back to Serper with site:pypi.org
    if (process.env.SERPER_API_KEY) {
      return this.searchSerperSite('pypi.org', query, maxResults, 'pypi');
    }

    return [];
  }

  /**
   * Get specific PyPI package info
   */
  private async searchPyPiPackage(packageName: string): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      `https://pypi.org/pypi/${packageName}/json`,
      {},
      10000
    );

    if (!response.ok) return [];

    interface PyPiPackageResponse {
      info: {
        name: string;
        version: string;
        summary?: string;
        keywords?: string;
        home_page?: string;
        project_urls?: Record<string, string>;
        requires_python?: string;
        author?: string;
      };
    }

    const data = await safeParseJson<PyPiPackageResponse>(response);
    if (!data?.info) return [];

    return [{
      title: `${data.info.name} ${data.info.version}`,
      url: `https://pypi.org/project/${data.info.name}/`,
      snippet: data.info.summary || data.info.keywords || 'Python package',
      source: 'pypi',
      relevance: 1.0,
      metadata: {
        version: data.info.version,
        homepage: data.info.home_page,
        requiresPython: data.info.requires_python,
        author: data.info.author,
        projectUrls: data.info.project_urls,
      },
    }];
  }

  /**
   * Search crates.io (Rust packages)
   */
  private async searchCrates(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://crates.io/api/v1/crates');
    url.searchParams.set('q', query);
    url.searchParams.set('per_page', String(maxResults));

    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          'User-Agent': 'ResearchBot/1.0 (research tool)',
          'Accept': 'application/json',
        },
      },
      10000
    );

    if (!response.ok) return [];

    interface CratesResponse {
      crates?: Array<{
        name: string;
        newest_version: string;
        description?: string;
        downloads: number;
        recent_downloads?: number;
        repository?: string;
        documentation?: string;
        max_stable_version?: string;
      }>;
    }

    const data = await safeParseJson<CratesResponse>(response);
    if (!data?.crates) return [];

    return data.crates.map((crate, i) => ({
      title: `${crate.name} v${crate.max_stable_version || crate.newest_version}`,
      url: crate.documentation || `https://docs.rs/${crate.name}`,
      snippet: crate.description || `${crate.downloads.toLocaleString()} downloads`,
      source: 'crates',
      relevance: 1 - (i * 0.05),
      metadata: {
        version: crate.max_stable_version || crate.newest_version,
        downloads: crate.downloads,
        recentDownloads: crate.recent_downloads,
        repository: crate.repository,
        docsUrl: crate.documentation || `https://docs.rs/${crate.name}`,
        cratesUrl: `https://crates.io/crates/${crate.name}`,
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
      if (process.env.SERPER_API_KEY) {
        return this.searchSerperSite('developer.mozilla.org', query, maxResults, 'mdn');
      }
      return [];
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
      metadata: {
        slug: item.slug,
        locale: item.locale,
      },
    }));
  }

  /**
   * Search Dev.to articles
   */
  private async searchDevTo(query: string, maxResults: number): Promise<SearchResult[]> {
    // Use Dev.to's search API
    const searchUrl = new URL('https://dev.to/search/feed_content');
    searchUrl.searchParams.set('per_page', String(maxResults));
    searchUrl.searchParams.set('search_fields', query);
    searchUrl.searchParams.set('class_name', 'Article');

    const response = await fetchWithTimeout(searchUrl.toString(), {}, 10000);

    if (!response.ok) return [];

    interface DevToSearchResponse {
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
      tag_list: string[];
    }

    const data = await response.json();

    // Handle search response format
    if ((data as DevToSearchResponse).result) {
      return ((data as DevToSearchResponse).result || []).map((item, i) => ({
        title: item.title,
        url: `https://dev.to${item.path}`,
        snippet: `Tutorial by ${item.user?.username || 'unknown'}`,
        source: 'devto',
        relevance: 1 - (i * 0.05),
        metadata: {
          author: item.user?.username,
        },
      }));
    }

    // Handle array response format (tag-based search)
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
          tags: item.tag_list,
        },
      }));
    }

    return [];
  }

  /**
   * Search Official Documentation Sites
   */
  private async searchOfficialDocs(query: string, maxResults: number): Promise<SearchResult[]> {
    // Target authoritative documentation sites
    const sites = [
      'docs.python.org',
      'nodejs.org/docs',
      'react.dev',
      'vuejs.org',
      'docs.rust-lang.org',
      'go.dev/doc',
      'typescriptlang.org',
      'kubernetes.io/docs',
      'docs.docker.com',
      'docs.aws.amazon.com',
      'hono.dev',
      'expressjs.com',
      'fastify.dev',
      'nextjs.org/docs',
    ];

    const siteQuery = sites.map(s => `site:${s}`).join(' OR ');
    const fullQuery = `(${siteQuery}) ${query}`;

    return this.searchSerperSite('', fullQuery, maxResults, 'official_docs');
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
