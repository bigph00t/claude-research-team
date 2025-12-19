/**
 * MCP Server for Research Tools
 *
 * Exposes research() as an MCP tool that Claude can call directly.
 * This is for MANUAL research when user explicitly asks Claude to research something.
 *
 * Usage: Claude calls research() when user says "go research X" or "look up Y online"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { research, type ResearchSkillInput } from '../skills/research.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('MCPServer');

// ============================================================================
// Tool Definitions
// ============================================================================

const RESEARCH_TOOL: Tool = {
  name: 'research',
  description: `Research a topic using web search and AI synthesis. Use this when:
- User explicitly asks you to research something ("look this up", "go online", "investigate")
- You need external information to answer a question
- You want to verify or validate technical information

Returns a synthesized summary with key findings and source links.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The research query - be specific and include context',
      },
      depth: {
        type: 'string',
        enum: ['quick', 'medium', 'deep'],
        default: 'medium',
        description: 'quick (~10s, simple facts), medium (~30s, how-to), deep (~60s, comprehensive)',
      },
      context: {
        type: 'string',
        description: 'Additional context to focus the research (e.g., "for a Node.js backend")',
      },
    },
    required: ['query'],
  },
};

const RESEARCH_STATUS_TOOL: Tool = {
  name: 'research_status',
  description: 'Check the status of the research service and recent research history.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ============================================================================
// MCP Server
// ============================================================================

async function createServer(): Promise<Server> {
  const server = new Server(
    {
      name: 'claude-research-team',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [RESEARCH_TOOL, RESEARCH_STATUS_TOOL],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'research': {
          const input: ResearchSkillInput = {
            query: (args as Record<string, unknown>).query as string,
            depth: ((args as Record<string, unknown>).depth as 'quick' | 'medium' | 'deep') || 'medium',
            context: (args as Record<string, unknown>).context as string | undefined,
            mode: 'execute', // Always execute directly for manual calls
          };

          logger.info(`Manual research request: "${input.query}" (${input.depth})`);

          const result = await research(input);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Research failed: ${result.message}`,
                },
              ],
              isError: true,
            };
          }

          // Format response for Claude
          const parts: string[] = [];

          if (result.summary) {
            parts.push('## Research Summary\n');
            parts.push(result.summary);
            parts.push('');
          }

          if (result.keyFindings && result.keyFindings.length > 0) {
            parts.push('## Key Findings\n');
            for (const finding of result.keyFindings) {
              parts.push(`- ${finding}`);
            }
            parts.push('');
          }

          if (result.sources && result.sources.length > 0) {
            parts.push('## Sources\n');
            for (const source of result.sources) {
              parts.push(`- [${source.title}](${source.url})`);
            }
            parts.push('');
          }

          if (result.pivot) {
            parts.push('## Alternative Approach Detected\n');
            parts.push(`**${result.pivot.alternative}**`);
            parts.push(`Reason: ${result.pivot.reason}`);
            parts.push(`Urgency: ${result.pivot.urgency}`);
            parts.push('');
          }

          parts.push(`\n_Confidence: ${Math.round((result.confidence || 0) * 100)}% | Duration: ${result.duration}ms_`);

          return {
            content: [
              {
                type: 'text',
                text: parts.join('\n'),
              },
            ],
          };
        }

        case 'research_status': {
          try {
            const healthResponse = await fetch('http://localhost:3200/api/health', {
              signal: AbortSignal.timeout(2000),
            });
            const statsResponse = await fetch('http://localhost:3200/api/queue/stats', {
              signal: AbortSignal.timeout(2000),
            });

            const health = await healthResponse.json() as { status: string };
            const stats = await statsResponse.json() as {
              success: boolean;
              data: { completed: number; queued: number; running: number }
            };

            return {
              content: [
                {
                  type: 'text',
                  text: [
                    '## Research Service Status\n',
                    `- Service: ${health.status === 'ok' ? '✓ Running' : '✗ Down'}`,
                    `- Queued: ${stats.data.queued}`,
                    `- Running: ${stats.data.running}`,
                    `- Completed: ${stats.data.completed}`,
                    '',
                    'Dashboard: http://localhost:3200',
                  ].join('\n'),
                },
              ],
            };
          } catch {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Research service is not running. Start it with: npm start (in claude-research-team directory)',
                },
              ],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      logger.error(`Tool ${name} failed`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  logger.info('Starting MCP server...');

  const server = await createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info('MCP server connected via stdio');
}

main().catch((error) => {
  logger.error('MCP server failed to start', error);
  process.exit(1);
});
