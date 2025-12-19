/**
 * Code Expert Specialist Agent
 *
 * Expert at finding code-related resources - libraries, examples, solutions.
 * Tools: GitHub Code Search, StackOverflow, npm Registry, PyPI
 */

import {
  BaseSpecialistAgent,
  fetchWithTimeout,
  safeParseJson,
  type SearchResult,
} from './base.js';

export class CodeExpertAgent extends BaseSpecialistAgent {
  readonly name = 'CodeExpert';
  readonly domain = 'code';
  readonly description = 'Code-focused search using GitHub, StackOverflow, npm, and PyPI';

  constructor() {
    super();
    this.initializeTools();
  }

  private initializeTools(): void {
    // GitHub Code Search
    this.registerTool({
      name: 'github',
      description: 'GitHub Code Search - find code examples and repositories',
      requiresApiKey: 'GITHUB_TOKEN',
      search: this.searchGitHub.bind(this),
    });

    // StackOverflow (uses StackExchange API - no key required for basic use)
    this.registerTool({
      name: 'stackoverflow',
      description: 'StackOverflow - programming Q&A',
      search: this.searchStackOverflow.bind(this),
    });

    // npm Registry (no API key required)
    this.registerTool({
      name: 'npm',
      description: 'npm Registry - Node.js packages',
      search: this.searchNpm.bind(this),
    });

    // PyPI (no API key required)
    this.registerTool({
      name: 'pypi',
      description: 'PyPI - Python packages',
      search: this.searchPyPi.bind(this),
    });

    // Serper with site:github.com (fallback if no GitHub token)
    this.registerTool({
      name: 'serper_github',
      description: 'Google search for GitHub content',
      requiresApiKey: 'SERPER_API_KEY',
      search: this.searchSerperGitHub.bind(this),
    });
  }

  /**
   * Search GitHub Code
   */
  private async searchGitHub(query: string, maxResults: number): Promise<SearchResult[]> {
    // Use GitHub Code Search API
    const response = await fetchWithTimeout(
      `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${maxResults}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      10000
    );

    if (!response.ok) {
      // Try repositories search as fallback
      return this.searchGitHubRepos(query, maxResults);
    }

    interface GitHubCodeResponse {
      items?: Array<{
        name: string;
        path: string;
        html_url: string;
        repository: {
          full_name: string;
          description: string | null;
          stargazers_count: number;
        };
        text_matches?: Array<{
          fragment: string;
        }>;
      }>;
    }

    const data = await safeParseJson<GitHubCodeResponse>(response);
    if (!data?.items) return [];

    return data.items.map((item, i) => ({
      title: `${item.repository.full_name}/${item.path}`,
      url: item.html_url,
      snippet: item.text_matches?.[0]?.fragment ||
               item.repository.description ||
               `Code in ${item.name}`,
      source: 'github:code',
      relevance: 1 - (i * 0.05),
      metadata: {
        stars: item.repository.stargazers_count,
        repo: item.repository.full_name,
      },
    }));
  }

  /**
   * Search GitHub Repositories (fallback)
   */
  private async searchGitHubRepos(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${maxResults}`,
      {
        headers: {
          'Authorization': process.env.GITHUB_TOKEN ? `Bearer ${process.env.GITHUB_TOKEN}` : '',
          'Accept': 'application/vnd.github+json',
        },
      },
      10000
    );

    if (!response.ok) return [];

    interface GitHubRepoResponse {
      items?: Array<{
        full_name: string;
        html_url: string;
        description: string | null;
        stargazers_count: number;
        language: string | null;
        updated_at: string;
      }>;
    }

    const data = await safeParseJson<GitHubRepoResponse>(response);
    if (!data?.items) return [];

    return data.items.map((item, i) => ({
      title: item.full_name,
      url: item.html_url,
      snippet: item.description || `${item.language || 'Multi-language'} repository`,
      source: 'github:repo',
      relevance: 1 - (i * 0.05),
      metadata: {
        stars: item.stargazers_count,
        language: item.language,
        updated: item.updated_at,
      },
    }));
  }

  /**
   * Search StackOverflow
   */
  private async searchStackOverflow(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
    url.searchParams.set('site', 'stackoverflow');
    url.searchParams.set('q', query);
    url.searchParams.set('pagesize', String(maxResults));
    url.searchParams.set('order', 'desc');
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('filter', 'withbody');

    const response = await fetchWithTimeout(url.toString(), {}, 10000);

    if (!response.ok) return [];

    interface SOResponse {
      items?: Array<{
        title: string;
        link: string;
        body: string;
        score: number;
        answer_count: number;
        is_answered: boolean;
        tags: string[];
      }>;
    }

    const data = await safeParseJson<SOResponse>(response);
    if (!data?.items) return [];

    return data.items.map(item => {
      // Extract snippet from body (strip HTML)
      const snippet = item.body
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 300);

      return {
        title: item.title,
        url: item.link,
        snippet: snippet || `Score: ${item.score}, ${item.answer_count} answers`,
        source: 'stackoverflow',
        relevance: item.is_answered ? 0.9 : 0.6,
        metadata: {
          score: item.score,
          answers: item.answer_count,
          tags: item.tags,
          answered: item.is_answered,
        },
      };
    });
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

    return data.objects.map(obj => ({
      title: `${obj.package.name}@${obj.package.version}`,
      url: obj.package.links?.npm || `https://www.npmjs.com/package/${obj.package.name}`,
      snippet: obj.package.description || obj.package.keywords?.join(', ') || 'npm package',
      source: 'npm',
      relevance: obj.score?.final || 0.7,
      metadata: {
        version: obj.package.version,
        keywords: obj.package.keywords,
        quality: obj.score?.detail?.quality,
        popularity: obj.score?.detail?.popularity,
      },
    }));
  }

  /**
   * Search PyPI
   */
  private async searchPyPi(query: string, maxResults: number): Promise<SearchResult[]> {
    // PyPI search returns HTML, not JSON - use workarounds
    // by searching for specific packages if query looks like a package name
    if (query.match(/^[a-zA-Z0-9_-]+$/)) {
      return this.searchPyPiPackage(query, maxResults);
    }

    // Fall back to using Serper with site:pypi.org
    if (process.env.SERPER_API_KEY) {
      return this.searchSerperPyPi(query, maxResults);
    }

    return [];
  }

  /**
   * Get specific PyPI package info
   */
  private async searchPyPiPackage(packageName: string, _maxResults: number): Promise<SearchResult[]> {
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
      },
    }];
  }

  /**
   * Search PyPI via Serper
   */
  private async searchSerperPyPi(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: `site:pypi.org ${query}`,
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
      source: 'serper:pypi',
      relevance: 1 - (i * 0.05),
    }));
  }

  /**
   * Search GitHub via Serper (fallback when no GitHub token)
   */
  private async searchSerperGitHub(query: string, maxResults: number): Promise<SearchResult[]> {
    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: `site:github.com ${query}`,
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
      source: 'serper:github',
      relevance: 1 - (i * 0.05),
    }));
  }
}
