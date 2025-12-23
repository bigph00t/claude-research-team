/**
 * Context7 MCP Adapter
 *
 * Connects to Context7 MCP server for deep library documentation.
 * Context7 provides curated, up-to-date docs with code examples.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface LibraryInfo {
  id: string;
  name: string;
  description?: string;
}

export interface LibraryDocs {
  content: string;
  truncated: boolean;
  tokenCount?: number;
}

// ============================================================================
// Context7 Adapter
// ============================================================================

export class Context7Adapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private logger: Logger;
  private connected = false;
  private connecting = false;

  constructor() {
    this.logger = new Logger('Context7Adapter');
  }

  /**
   * Connect to Context7 MCP server
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connecting) {
      // Wait for existing connection attempt
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.connected;
    }

    this.connecting = true;

    try {
      this.transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      });

      this.client = new Client(
        { name: 'research-team', version: '1.0.0' },
        { capabilities: {} }
      );

      await this.client.connect(this.transport);
      this.connected = true;
      this.logger.info('Connected to Context7 MCP server');
      return true;
    } catch (error) {
      this.logger.warn('Failed to connect to Context7', { error });
      this.connected = false;
      return false;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Disconnect from Context7
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.connected = false;
      this.client = null;
      this.transport = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Resolve a library name to Context7 library ID
   *
   * @param libraryName - Name like "react", "hono", "express"
   * @returns Library ID or null if not found
   */
  async resolveLibrary(libraryName: string): Promise<LibraryInfo | null> {
    if (!this.connected || !this.client) {
      const connected = await this.connect();
      if (!connected) return null;
    }

    try {
      const result = await this.client!.callTool({
        name: 'resolve-library-id',
        arguments: { libraryName },
      });

      // Parse the response
      const content = result.content;
      if (Array.isArray(content) && content.length > 0) {
        const textContent = content.find((c: { type: string }) => c.type === 'text');
        if (textContent && 'text' in textContent) {
          const text = textContent.text as string;

          // Context7 returns a formatted text list of libraries
          // Parse out the first library ID with highest relevance
          // Format: "- Context7-compatible library ID: /org/project"
          const libraryIdMatch = text.match(/Context7-compatible library ID:\s*([^\n\s]+)/);
          if (libraryIdMatch) {
            const libraryId = libraryIdMatch[1].trim();

            // Also extract title and description if available
            const titleMatch = text.match(/- Title:\s*([^\n]+)/);
            const descMatch = text.match(/- Description:\s*([^\n]+)/);

            return {
              id: libraryId,
              name: titleMatch ? titleMatch[1].trim() : libraryName,
              description: descMatch ? descMatch[1].trim() : undefined,
            };
          }

          // Try JSON fallback
          try {
            const parsed = JSON.parse(text);
            if (parsed.id) {
              return {
                id: parsed.id,
                name: parsed.name || libraryName,
                description: parsed.description,
              };
            }
          } catch {
            // Not JSON format
          }
        }
      }

      this.logger.debug(`Library not found: ${libraryName}`);
      return null;
    } catch (error) {
      this.logger.warn(`Failed to resolve library: ${libraryName}`, { error });
      return null;
    }
  }

  /**
   * Get documentation for a library
   *
   * @param libraryId - Context7-compatible library ID
   * @param topic - Optional topic to focus on (e.g., "routing", "middleware")
   * @param tokens - Max tokens to return (default 5000)
   * @returns Documentation content
   */
  async getLibraryDocs(
    libraryId: string,
    topic?: string,
    tokens: number = 5000
  ): Promise<LibraryDocs | null> {
    if (!this.connected || !this.client) {
      const connected = await this.connect();
      if (!connected) return null;
    }

    try {
      const args: Record<string, unknown> = {
        context7CompatibleLibraryID: libraryId,
        tokens,
      };

      if (topic) {
        args.topic = topic;
      }

      const result = await this.client!.callTool({
        name: 'get-library-docs',
        arguments: args,
      });

      // Parse the response
      const content = result.content;
      if (Array.isArray(content) && content.length > 0) {
        const textContent = content.find((c: { type: string }) => c.type === 'text');
        if (textContent && 'text' in textContent) {
          const text = textContent.text as string;
          return {
            content: text,
            truncated: text.length >= tokens * 4, // Rough estimate
            tokenCount: Math.ceil(text.length / 4),
          };
        }
      }

      return null;
    } catch (error) {
      this.logger.warn(`Failed to get docs for: ${libraryId}`, { error });
      return null;
    }
  }

  /**
   * Search for library documentation by query
   *
   * Convenience method that:
   * 1. Extracts potential library name from query
   * 2. Resolves to library ID
   * 3. Gets docs focused on the query topic
   *
   * @param query - Search query like "hono middleware" or "react hooks"
   * @returns Docs content or null
   */
  async searchDocs(query: string): Promise<{
    library: LibraryInfo;
    docs: LibraryDocs;
  } | null> {
    // Extract library name (first word or common patterns)
    const libraryPatterns = [
      // Common library names
      /^(react|vue|angular|svelte|next|nuxt|remix|astro|hono|express|fastify|koa|nest|django|flask|fastapi|spring|rails|laravel|gin|echo|fiber|actix|axum|rocket|warp|tokio|serde|diesel|sqlx|prisma|drizzle|mongoose|sequelize|typeorm|knex|redis|mongodb|postgres|mysql|sqlite)\b/i,
      // First word as library name
      /^([a-z0-9_-]+)\s/i,
    ];

    let libraryName: string | null = null;
    let topic: string | null = null;

    for (const pattern of libraryPatterns) {
      const match = query.match(pattern);
      if (match) {
        libraryName = match[1].toLowerCase();
        topic = query.slice(match[0].length).trim() || null;
        break;
      }
    }

    if (!libraryName) {
      this.logger.debug(`No library name found in query: ${query}`);
      return null;
    }

    // Resolve library
    const library = await this.resolveLibrary(libraryName);
    if (!library) {
      return null;
    }

    // Get docs
    const docs = await this.getLibraryDocs(library.id, topic || undefined);
    if (!docs) {
      return null;
    }

    return { library, docs };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: Context7Adapter | null = null;

export function getContext7Adapter(): Context7Adapter {
  if (!instance) {
    instance = new Context7Adapter();
  }
  return instance;
}

export async function shutdownContext7(): Promise<void> {
  if (instance) {
    await instance.disconnect();
    instance = null;
  }
}
