<p align="center">
  <img src="assets/logo.png" alt="Claude Research Team" width="200">
</p>

<h1 align="center">Claude Research Team</h1>

<p align="center">
  <strong>Autonomous research agents for Claude Code — passively research and inject helpful context</strong>
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL v3"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node.js"></a>
  <a href="https://docs.anthropic.com/claude-code"><img src="https://img.shields.io/badge/powered%20by-Claude%20Agent%20SDK-orange" alt="Claude Agent SDK"></a>
</p>

<p align="center">
  <a href="#what-is-this">What is This?</a> •
  <a href="#search-engines--tools">Tools</a> •
  <a href="#installation">Installation</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## What is This?

Claude Research Team is a **Claude Code plugin** that runs background research while you work. When you ask questions or encounter errors, it automatically:

1. **Detects research opportunities** from your prompts and tool outputs
2. **Searches the web** using multiple search APIs (Serper, Brave, Tavily)
3. **Synthesizes findings** with Claude Agent SDK
4. **Injects context** back into your Claude conversation at the right moment
5. **Remembers everything** by storing research in [claude-mem](https://github.com/thedotmack/claude-mem)'s database

**No manual intervention required** — research happens in the background and gets injected automatically.

### Built for claude-mem Users

This plugin integrates deeply with [claude-mem](https://github.com/thedotmack/claude-mem). All research findings are stored as observations in claude-mem's SQLite database, making them:

- **Searchable** across sessions via claude-mem's semantic search
- **Visible** in claude-mem's web UI timeline
- **Persistent** — past research informs future sessions

Don't have claude-mem? That's fine — the plugin works standalone too, but you'll lose cross-session memory.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CLAUDE RESEARCH TEAM                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   STREAMING CONVERSATION ANALYSIS                                        │
│   ───────────────────────────────                                        │
│                                                                          │
│   ┌─────────────┐     ┌─────────────────┐     ┌─────────────┐           │
│   │  USER       │────▶│  CONVERSATION   │────▶│  RESEARCH   │           │
│   │  PROMPT     │     │  ANALYZER       │     │  DETECTOR   │           │
│   └─────────────┘     └─────────────────┘     └──────┬──────┘           │
│         │                     │                       │                  │
│         │                     ▼                       ▼                  │
│         │            ┌─────────────────┐     ┌─────────────┐            │
│         │            │  SESSION STATE  │     │  RESEARCH   │            │
│         │            │  (topics, errs) │     │  QUEUE      │            │
│         │            └─────────────────┘     └──────┬──────┘            │
│         │                                           │                    │
│   ┌─────────────┐                                   ▼                    │
│   │  TOOL USE   │     ┌─────────────────┐   ┌─────────────┐             │
│   │  (streamed) │────▶│  POST-TOOL-USE  │◀──│  CLAUDE SDK │             │
│   └─────────────┘     │  HOOK           │   │  SYNTHESIS  │             │
│                       └────────┬────────┘   └─────────────┘             │
│                                │                    │                    │
│                                ▼                    ▼                    │
│   ┌─────────────┐     ┌─────────────────┐   ┌─────────────────────┐     │
│   │  CLAUDE     │◀────│  INJECTION      │   │  CLAUDE-MEM DB      │     │
│   │  CONTEXT    │     │  MANAGER        │   │  ~/.claude-mem/     │     │
│   └─────────────┘     └─────────────────┘   └─────────────────────┘     │
│                                                                          │
│   ═══════════════════════════════════════════════════════════════════   │
│                                                                          │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐               │
│   │  HTTP API   │     │  WEB UI     │     │  SQLITE DB  │               │
│   │  :3200      │     │  DASHBOARD  │     │  + FTS5     │               │
│   └─────────────┘     └─────────────┘     └─────────────┘               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Streaming Conversation Flow

The plugin uses Claude Code's **stdin/stdout hook protocol** to stream conversation data to the research service:

1. **User prompts** → Streamed via `UserPromptSubmit` hook for trigger detection
2. **Tool uses** → ALL tool executions streamed via `PostToolUse` hook
3. **Conversation analyzer** → Maintains session state (topics, errors, patterns)
4. **Research detector** → Analyzes content for research opportunities
5. **Context injection** → Returns research via `additionalContext` in hook response

### Two Injection Paths

1. **Real-time Injection** (PostToolUse hook)
   - After each tool execution, checks if research has completed
   - Injects findings via `additionalContext` immediately
   - You see results within the same conversation

2. **Session Memory** (claude-mem integration)
   - Research stored as observations in claude-mem's database
   - Available in future sessions via claude-mem's context injection
   - Builds long-term knowledge base

---

## Features

### Core Capabilities
- **100% Claude Powered** — Uses Claude Agent SDK for AI synthesis, no external AI keys needed
- **Intelligent Trigger Detection** — Recognizes questions, errors, and research-worthy patterns
- **Priority Queue Management** — Research tasks are prioritized by relevance and urgency
- **Passive Context Injection** — Results are injected without disrupting your workflow
- **Web Dashboard** — Monitor research tasks and queue status at http://localhost:3200
- **Plugin Architecture** — Install as a Claude Code plugin with hooks and skills

### v1.0 Advanced Features
- **Multi-Agent Research** — Specialized agents (web-search, code-expert, docs-expert) work in parallel
- **Meta-Evaluator** — Evaluates research quality, detects knowledge gaps, suggests improvements
- **Source Assessor** — Tracks source reliability per domain/topic, learns from feedback
- **Progressive Disclosure** — 3-tier injection system (summary → key points → full content)
- **Meta-Learning** — System learns which approaches work best for different query types
- **Isolated Learning** — Local research.db stores all findings; claude-mem gets synthesized insights only
- **Proactive Triggers** — Detects stuck patterns, repeated errors, and topic focus

---

## Search Engines & Tools

### Built-in (Always Available)

| Tool | Purpose | Cost |
|------|---------|------|
| **Claude Agent SDK** | AI synthesis & summarization | Uses your Anthropic API key |
| **Jina Reader** | Web page scraping & content extraction | Free, unlimited |
| **SQLite + FTS5** | Local storage with full-text search | Free, built-in |

### Search APIs (Configure at least one)

| Provider | What It Does | Free Tier | Sign Up |
|----------|--------------|-----------|---------|
| **Serper** ⭐ | Google search results (recommended) | 2,500 queries/month | [serper.dev](https://serper.dev) |
| **Brave** | Privacy-focused web search | 2,000 queries/month | [brave.com/search/api](https://brave.com/search/api) |
| **Tavily** | AI-optimized search results | 1,000 queries/month | [tavily.com](https://tavily.com) |

**How search works:**
1. Tries Serper first (if configured) — most reliable Google results
2. Falls back to Brave (if configured) — privacy-focused alternative
3. Falls back to Tavily (if configured) — AI-optimized results
4. Results are deduplicated across all engines

**You need at least one search API key** — without it, the research crew can't search the web. Serper is recommended for the best results.

---

## Prerequisites

Before installing, ensure you have:

### Required

- **Node.js 18+** — Check with `node --version`
- **npm** — Comes with Node.js
- **Build tools** — Required for `better-sqlite3` native module:
  - **Ubuntu/Debian**: `sudo apt install build-essential python3`
  - **macOS**: `xcode-select --install`
  - **Windows**: Install Visual Studio Build Tools

### Required: Search API Key (at least one)

You need at least one search API key for web research:

| Provider | Cost | Sign Up |
|----------|------|---------|
| **Serper** (recommended) | 2,500 free queries/month | https://serper.dev |
| **Brave** | 2,000 free queries/month | https://brave.com/search/api |
| **Tavily** | 1,000 free queries/month | https://tavily.com |

### Optional

- **[claude-mem](https://github.com/thedotmack/claude-mem)** — For cross-session memory persistence
  - If installed, research automatically stores to claude-mem's database
  - Research appears in claude-mem's timeline UI
  - Past research informs future sessions

---

## Installation

### Option 1: Install as Claude Code Plugin (Recommended)

```bash
# Install from GitHub
claude plugins install bigph00t/claude-research-team

# Or install from local path during development
claude plugins install /path/to/claude-research-team
```

The plugin automatically:
- Starts the background research service on port 3200
- Registers lifecycle hooks (SessionStart, SessionEnd, UserPromptSubmit, PostToolUse)
- Makes skills available (`research`, `research-status`)

### Option 2: Manual Installation

```bash
# Clone the repository
git clone https://github.com/bigph00t/claude-research-team.git
cd claude-research-team

# Install dependencies (requires build tools for better-sqlite3)
npm install

# Build TypeScript and hooks
npm run build

# Set your search API key(s)
export SERPER_API_KEY="your-key-here"
# and/or
export BRAVE_API_KEY="your-key-here"
export TAVILY_API_KEY="your-key-here"

# Start the service
npm start
```

The service runs on port **3200**. Open http://localhost:3200 to view the dashboard.

### Verify Installation

```bash
# Check if service is running
curl http://localhost:3200/api/status

# Should return something like:
# {"status":"ok","queue":{"queued":0,"running":0,"completed":5,"failed":0}}
```

---

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SERPER_API_KEY` | Serper.dev API key | At least one search key |
| `BRAVE_API_KEY` | Brave Search API key | At least one search key |
| `TAVILY_API_KEY` | Tavily API key | At least one search key |
| `CLAUDE_RESEARCH_PORT` | HTTP service port | No (default: 3200) |
| `CLAUDE_RESEARCH_DATA_DIR` | Data directory | No (default: ~/.claude-research-team) |
| `CLAUDE_RESEARCH_LOG_LEVEL` | Log level (debug/info/warn/error) | No (default: info) |

### Config File

Configuration is stored in `~/.claude-research-team/config.json`:

```json
{
  "port": 3200,
  "dataDir": "~/.claude-research-team",
  "logLevel": "info",
  "defaultDepth": "medium",
  "engines": ["serper", "brave", "tavily"],
  "injection": {
    "maxPerSession": 5,
    "maxTokensPerInjection": 150,
    "maxTotalTokensPerSession": 500,
    "cooldownMs": 30000
  },
  "queue": {
    "maxConcurrent": 2,
    "maxQueueSize": 20,
    "taskTimeoutMs": 120000,
    "retryAttempts": 2
  }
}
```

---

## Multi-Agent Architecture

Claude Research Team uses specialized agents that work together for comprehensive research:

### Search Specialists (Parallel Execution)

| Agent | Domain | Tools |
|-------|--------|-------|
| **Web Search** | General web research | Serper, Brave, Tavily, Jina Reader |
| **Code Expert** | Code repositories, Stack Overflow | GitHub API, Stack Overflow |
| **Docs Expert** | Official documentation | MDN, official docs sites |

### Evaluation Agents (Post-Research)

| Agent | Purpose |
|-------|---------|
| **Coordinator** | Plans research strategy, evaluates progress, synthesizes results |
| **Meta-Evaluator** | Scores research quality, detects gaps, suggests improvements |
| **Source Assessor** | Tracks source reliability, learns from feedback |

### Learning System

The **Meta-Learner** continuously improves research quality:

1. **Query Performance** — Tracks which depths/approaches work for different query types
2. **Source Scoring** — Learns which domains are reliable for specific topics
3. **Implicit Feedback** — Detects success/failure signals from Claude's behavior:
   - Positive: Error resolved, task completed, suggestion followed
   - Negative: Same error repeated, injection ignored, clarifying question asked

---

## How It Works

### 1. Hook Communication (stdin/stdout Protocol)

All hooks use Claude Code's **stdin/stdout protocol**:

```typescript
// Hooks receive JSON input from stdin:
{
  "session_id": "uuid",
  "prompt": "user's message",      // UserPromptSubmit
  "tool_name": "Read",              // PostToolUse
  "tool_input": {...},              // PostToolUse
  "tool_response": "..."            // PostToolUse
}

// Hooks output JSON to stdout:
{
  "continue": true,
  "suppressOutput": true,
  "hookSpecificOutput": {           // Optional - for context injection
    "hookEventName": "PostToolUse",
    "additionalContext": "<research-context>...</research-context>"
  }
}
```

### 2. Trigger Detection

When you send a prompt, the `UserPromptSubmit` hook streams it to the research service for analysis:

```typescript
// Patterns that trigger research:
- Questions: "how do I...", "what is...", "why does..."
- Errors: "error:", "failed:", stack traces
- Technical queries: library names, API references
- Comparisons: "X vs Y", "best way to..."
```

If confidence score ≥ 0.6, research is queued in the background.

### 3. Research Execution

The research executor:

1. **Checks memory** — Finds related past research to avoid redundancy
2. **Searches** — Queries configured search APIs in parallel
3. **Scrapes** — Extracts content from top results using Jina Reader (free)
4. **Synthesizes** — Uses Claude Agent SDK to create intelligent summary
5. **Stores** — Saves to claude-mem database as a `discovery` observation

### 4. Context Injection

After each tool use, the `PostToolUse` hook:

1. Checks if relevant research has completed
2. Formats findings as XML context block
3. Returns via `additionalContext` field
4. Claude sees the research and can use it

```xml
<research-context query="how to implement rate limiting">
Rate limiting in Node.js can be implemented using token bucket
or sliding window algorithms. Popular libraries include
rate-limiter-flexible and express-rate-limit.

Source: Rate Limiting Best Practices (https://example.com/rate-limiting)
</research-context>
```

---

## Research Depths

| Depth | Time | Max Searches | Max Scrapes | Best For |
|-------|------|--------------|-------------|----------|
| `quick` | ~15s | 5 | 2 | Simple facts, definitions |
| `medium` | ~30s | 10 | 4 | How-to questions, technical docs |
| `deep` | ~60s | 20 | 8 | Complex comparisons, thorough research |

---

## Using the Skills

Once installed, you can manually trigger research:

```
Use the research skill to look up "best practices for rate limiting in Node.js"
```

```
Use the research-status skill to check the queue
```

### Available Skills

| Skill | Description |
|-------|-------------|
| `research` | Execute or queue research on a topic (supports quick/medium/deep depth) |
| `research-status` | Check queue status and recent findings |
| `research-detail` | Get more detail from a previous finding (progressive disclosure) |

### Progressive Disclosure with research-detail

When research is injected, you initially see a **summary only** (Level 1). If you need more detail:

```
Use the research-detail skill to get key points for finding "abc123"
```

```
Use the research-detail skill with level "full" for finding "abc123"
```

| Level | What You Get |
|-------|--------------|
| 1 (default injection) | Summary only (~100-200 tokens) |
| 2 (`key_points`) | Summary + bullet point insights |
| 3 (`full`) | Summary + key points + complete scraped content |

---

## CLI Commands

```bash
# Check service status
claude-research-team status

# Queue manual research
claude-research-team research "how to implement caching in Redis"

# List recent tasks
claude-research-team tasks --limit 20

# View/update configuration
claude-research-team config
claude-research-team config port 3201
```

---

## API Reference

### Status & Health

```http
GET /api/status          # Service status with queue stats
```

### Research Queue

```http
POST /api/research       # Queue new research
{
  "query": "how to implement caching",
  "depth": "medium",      # quick | medium | deep
  "priority": 7,          # 1-10
  "sessionId": "optional"
}

GET /api/queue/stats     # Queue statistics
GET /api/tasks           # List recent tasks
GET /api/tasks/:id       # Get specific task
GET /api/search/tasks?q= # Search tasks (uses FTS5)
```

### Conversation Streaming (Hook Endpoints)

```http
POST /api/conversation/user-prompt   # Stream user prompt from hook
{
  "sessionId": "session-uuid",
  "prompt": "How do I implement...",
  "projectPath": "/path/to/project",
  "timestamp": 1702934567890
}

POST /api/conversation/tool-use      # Stream tool use from hook
{
  "sessionId": "session-uuid",
  "toolName": "Read",
  "toolInput": {"file_path": "/foo.ts"},
  "toolOutput": "File contents...",
  "projectPath": "/path/to/project",
  "timestamp": 1702934567890
}
# Returns: {success, data: {injection?: string}}

GET /api/conversation/:sessionId/stats   # Get session statistics
```

### Trigger Analysis

```http
POST /api/analyze/prompt        # Analyze prompt for triggers
POST /api/analyze/tool-output   # Analyze tool output for triggers
```

### Injection

```http
GET /api/injection/:sessionId           # Get pending injection
GET /api/injection/:sessionId/history   # Injection history
```

### Memory (claude-mem integration)

```http
GET /api/memory/stats           # Memory statistics
GET /api/memory/research        # List stored research
GET /api/memory/search?q=       # Search past research
```

---

## Web Dashboard

Access the dashboard at **http://localhost:3200** to:

- View real-time queue status
- Monitor active and completed tasks
- See research results and sources
- Track injection history
- View memory statistics

---

## Troubleshooting

### "Service not running"

```bash
# Start the service
npm start

# Or check if port 3200 is in use
lsof -i :3200
```

### "No search results"

Ensure you have at least one search API key set:

```bash
export SERPER_API_KEY="your-key-here"
```

### "better-sqlite3 build failed"

Install build tools:

```bash
# Ubuntu/Debian
sudo apt install build-essential python3

# macOS
xcode-select --install

# Then reinstall
rm -rf node_modules
npm install
```

### "Research not appearing in claude-mem"

The research service needs to connect to claude-mem's database. Check:

1. claude-mem is installed and working
2. Database exists at `~/.claude-mem/claude-mem.db`
3. Research service has read/write access

### "Hooks not firing"

Verify the plugin is installed:

```bash
claude plugins list
```

Rebuild if needed:

```bash
npm run clean && npm run build
```

---

## Project Structure

```
claude-research-team/
├── assets/
│   ├── logo.png              # Project logo (for README)
│   ├── logo.webp             # Dashboard logo (static)
│   └── logo-animated.webp    # Dashboard logo (when research active)
├── src/
│   ├── agents/               # Agent architecture
│   │   ├── coordinator.ts    # Orchestrates research planning & synthesis
│   │   ├── conversation-watcher.ts  # Proactive trigger detection
│   │   └── specialists/      # Domain-specialized agents
│   │       ├── base.ts       # Base specialist interface
│   │       ├── web-search.ts # General web research
│   │       ├── code-expert.ts    # Code-specific research (GitHub, SO)
│   │       ├── docs-expert.ts    # Documentation research
│   │       ├── meta-evaluator.ts # Research quality evaluation
│   │       └── source-assessor.ts # Source reliability tracking
│   ├── conversation/         # Streaming conversation analyzer
│   ├── crew/                 # Research execution
│   │   ├── autonomous-crew.ts    # Self-directing research crew
│   │   └── research-executor.ts  # Single research execution
│   ├── database/             # SQLite with FTS5
│   │   └── index.ts          # research.db with research_findings, injection_log, source_quality
│   ├── hooks/                # Claude Code lifecycle hooks
│   ├── injection/            # Context injection manager
│   ├── learning/             # Meta-learning system
│   │   └── meta-learner.ts   # Query performance tracking, source scoring
│   ├── memory/               # claude-mem integration
│   │   └── memory-integration.ts  # Isolated learning, single injection category
│   ├── plugin/               # Plugin entry point
│   ├── queue/                # Task queue manager
│   ├── service/              # HTTP service & web dashboard
│   ├── skills/               # Claude Code skills
│   │   ├── research.ts       # /research skill
│   │   ├── research-status.ts    # /research-status skill
│   │   └── research-detail.ts    # /research-detail skill (progressive disclosure)
│   ├── sync/                 # HTTP-based claude-mem sync
│   ├── utils/                # Logger, config utilities
│   ├── types.ts              # TypeScript types
│   ├── index.ts              # Library exports
│   └── cli.ts                # CLI entry point
├── scripts/
│   └── build-hooks.js        # Hook bundler (esbuild)
├── plugin.json               # Claude Code plugin manifest
├── package.json
├── tsconfig.json
└── README.md
```

---

## Development

```bash
# Development build with watch
npm run dev

# Run tests
npm test

# Lint
npm run lint

# Clean build
npm run clean && npm run build

# View service logs
npm run service:logs
```

---

## License

**AGPL-3.0** — See [LICENSE](LICENSE) for details.

This means:
- You can use, modify, and distribute this code
- Modifications must also be AGPL-licensed
- If you run this as a service, you must release your source code

---

## Related Projects

- **[claude-mem](https://github.com/thedotmack/claude-mem)** — Persistent memory for Claude Code (recommended companion)
- **[Claude Agent SDK](https://docs.anthropic.com/claude-code)** — Powers the AI synthesis

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm test` and `npm run lint`
5. Submit a pull request

---

## Credits

- Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) for its elegant approach to Claude Code enhancement
- Powered by the [Claude Agent SDK](https://docs.anthropic.com/claude-code) for AI synthesis
- Uses [Jina Reader](https://jina.ai/reader/) for free, unlimited web scraping
