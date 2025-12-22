<p align="center">
  <img src="assets/logo.png" alt="Claude Research Team" width="180">
</p>

<h1 align="center">Claude Research Team</h1>

<p align="center">
  <strong>A unified knowledge layer for Claude Code</strong>
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL v3"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Runtime-Bun-f472b6" alt="Bun"></a>
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-Plugin-orange" alt="Claude Code Plugin"></a>
</p>

---

## What This Is

Claude Research Team is a **knowledge augmentation system** that gives Claude Code access to:

- **Memory** — What you've done, decided, learned, and built (via [claude-mem](https://github.com/thedotmack/claude-mem))
- **Research** — External knowledge gathered asynchronously by AI agents

When Claude encounters a question, error, or unfamiliar pattern, this system queries the unified knowledge base. If relevant memory exists, it injects that context. If research would help, agents fetch and synthesize it. Often, both are combined.

The result: Claude remembers your past decisions AND can look things up—without you having to ask.

---

## The Core Idea

```
┌─────────────────────────────────────────────────────────────┐
│                    UNIFIED KNOWLEDGE BASE                    │
│                                                              │
│  ┌─────────────────┐             ┌─────────────────────┐    │
│  │     MEMORY      │             │      RESEARCH       │    │
│  │                 │             │                     │    │
│  │ Your decisions  │             │ External docs       │    │
│  │ Past solutions  │      +      │ Best practices      │    │
│  │ Code patterns   │             │ Error explanations  │    │
│  │ Project context │             │ Library guides      │    │
│  └─────────────────┘             └─────────────────────┘    │
│                                                              │
│                         ▼                                    │
│            ┌───────────────────────┐                        │
│            │   SMART INJECTION     │                        │
│            │                       │                        │
│            │ • Memory only (80t)   │                        │
│            │ • Research only (100t)│                        │
│            │ • Combined (150t)     │                        │
│            │ • Warning/pivot (120t)│                        │
│            └───────────────────────┘                        │
│                         │                                    │
│                         ▼                                    │
│              Claude's conversation                           │
│                (seamless context)                            │
└─────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Knowledge Detection

The system watches your Claude Code sessions via lifecycle hooks:

| Hook | What It Catches |
|------|-----------------|
| SessionStart | Initialize session, load project context |
| UserPromptSubmit | Analyze questions for knowledge gaps |
| PostToolUse | Detect errors, unfamiliar APIs, stuck patterns |

### Injection Types

Based on what's found in the knowledge base:

| Type | When Used | Example |
|------|-----------|---------|
| **Memory Only** | Strong match in past work | "You implemented JWT refresh tokens in project-x using httpOnly cookies" |
| **Research Only** | New topic, nothing in memory | "Hono rate-limiter middleware: configure windowMs, max, keyGenerator" |
| **Combined** | Both relevant | Memory of your approach + current best practices |
| **Warning** | Research suggests better approach | "Consider using `ky` instead of manual fetch retry logic" |

### What Gets Injected

Injections are **concise** (80-150 tokens) and **actionable**:

```
[Memory] You handled similar auth in api-gateway (Nov 20):
Sliding window rate limiting with Redis for distributed state.

[Research] Current Hono best practice: hono-rate-limiter supports
sliding window natively, no Redis needed for single-instance.
(91% confidence) [/research-detail abc123]
```

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [claude-mem](https://github.com/thedotmack/claude-mem) installed and running (port 37777)
- At least one search API key (see Configuration)

### Install

```bash
git clone https://github.com/bigph00t/claude-research-team
cd claude-research-team
bun install
bun run build

# Install as Claude Code plugin
claude plugins install .
```

### Configure

Set up API keys in `.env` or export directly:

```bash
# Search APIs (at least one required)
SERPER_API_KEY=xxx       # serper.dev (2,500/mo free)
BRAVE_API_KEY=xxx        # brave.com/search/api (2,000/mo free)
TAVILY_API_KEY=xxx       # tavily.com (1,000/mo free)

# Code search
GITHUB_TOKEN=xxx         # For GitHub repo/code search

# AI synthesis (choose one)
# Default: Claude SDK (uses your Anthropic account)
GEMINI_API_KEY=xxx       # Alternative: Gemini Flash (free tier)
```

### Start

```bash
bun run start
```

**Dashboards:**
- Research: [http://localhost:3200](http://localhost:3200)
- Memory: [http://localhost:37777](http://localhost:37777)

---

## Usage

### Automatic (Default)

Once running, knowledge injection happens automatically:

1. You work with Claude Code normally
2. System detects questions, errors, or unfamiliar patterns
3. Queries unified knowledge base
4. Injects relevant memory and/or research
5. You see context in your next response

### Manual Skills

```bash
/research <query>              # Research any topic
/research-status               # Check service health
/research-detail <finding-id>  # Get full details + sources
```

### Research Depths

| Depth | Time | Use For |
|-------|------|---------|
| quick | ~5s | Facts, definitions |
| medium | ~15s | How-to, documentation |
| deep | ~30s | Comparisons, analysis |

---

## Architecture

### Multi-Agent Research

```
ConversationWatcher
│   Monitors tool outputs for research opportunities
│   Queries unified knowledge base first
│
└── Coordinator
    │   Plans research strategy
    │   Dispatches to specialists
    │
    ├── WebSearchAgent
    │   Serper, Brave, Tavily, DuckDuckGo
    │
    ├── CodeExpertAgent
    │   GitHub, StackOverflow, npm, PyPI, crates.io
    │
    └── DocsExpertAgent
        Wikipedia, ArXiv, MDN, HackerNews, Reddit, Dev.to
```

### claude-mem Integration

Research findings are saved as **observations** (type: `discovery`) in claude-mem's database:

```
research-team                    claude-mem
     │                               │
     │  saveResearchAsObservation()  │
     │ ────────────────────────────► │
     │                               │
     │  • observations table         │
     │  • type = 'discovery'         │
     │  • full FTS5 indexing         │
     │  • vector embeddings          │
     │                               │
     │  searchKnowledge()            │
     │ ◄──────────────────────────── │
     │                               │
     │  • Combined memory + research │
     │  • Relevance scoring          │
     │  • Smart injection decision   │
```

### Knowledge Flow

```
Tool Output → Watcher → Knowledge Query → Decision
                              │              │
                              ▼              ▼
                    ┌──────────────┐  ┌──────────────┐
                    │ Memory Found │  │ No Memory    │
                    └──────────────┘  └──────────────┘
                           │                 │
                    ┌──────┴──────┐          ▼
                    ▼             ▼    ┌──────────────┐
             ┌──────────┐  ┌──────────┐│   Trigger    │
             │ Inject   │  │ Inject + ││   Research   │
             │ Memory   │  │ Research ││              │
             └──────────┘  └──────────┘└──────────────┘
                                              │
                                              ▼
                                       ┌──────────────┐
                                       │ When Ready:  │
                                       │ Inject       │
                                       │ Research     │
                                       └──────────────┘
```

---

## Configuration

### Dashboard Settings

Access at [http://localhost:3200](http://localhost:3200):

| Setting | Default | Description |
|---------|---------|-------------|
| AI Provider | Claude | Claude SDK or Gemini Flash |
| Model | Haiku | Claude tier (Haiku/Sonnet/Opus) |
| Autonomous Research | Enabled | Auto-trigger from conversation |
| Confidence Threshold | 0.85 | Min confidence to inject |
| Relevance Threshold | 0.8 | Min relevance to inject |
| Session Cooldown | 60s | Between researches |
| Max Per Hour | 15 | Global limit |

### Injection Budget

| Parameter | Default | Description |
|-----------|---------|-------------|
| maxPerSession | 5 | Max injections per session |
| maxTokensPerInjection | 150 | Token limit per injection |
| maxTotalTokensPerSession | 500 | Total tokens per session |
| cooldownMs | 30000 | Between injections |

### claude-mem Thresholds

| Threshold | Default | Description |
|-----------|---------|-------------|
| minRelevanceScore | 0.5 | Consider for injection |
| memoryOnlyThreshold | 0.8 | Strong memory = memory only |
| researchOnlyThreshold | 0.6 | Research threshold |
| combinedThreshold | 0.6 | Both must exceed for combined |

---

## Free Tools (No API Key)

These work out of the box:

- **Search**: DuckDuckGo
- **Code**: StackOverflow, npm, PyPI, crates.io
- **Docs**: Wikipedia, ArXiv, HackerNews, Reddit, MDN, Dev.to
- **Scraping**: Jina Reader

---

## API Reference

### Status
```http
GET /api/health              # Health check
GET /api/status              # Full status + config
```

### Research
```http
POST /api/research
{
  "query": "how to implement caching",
  "depth": "medium",
  "trigger": "user"
}
```

### Knowledge
```http
GET /api/knowledge/search?q=<query>    # Unified search
GET /api/knowledge/:id                  # Get observation
GET /api/findings                       # Research findings
GET /api/injections                     # Injection history
```

### Sessions
```http
GET /api/sessions                       # Active sessions
POST /api/sessions                      # Create session
```

---

## Project Structure

```
claude-research-team/
├── src/
│   ├── adapters/
│   │   └── claude-mem-adapter.ts    # Unified knowledge access
│   ├── agents/
│   │   ├── coordinator.ts           # Research planning
│   │   ├── conversation-watcher.ts  # Opportunity detection
│   │   └── specialists/             # WebSearch, CodeExpert, DocsExpert
│   ├── crew/
│   │   ├── autonomous-crew.ts       # Multi-agent orchestration
│   │   └── research-executor.ts     # Task execution
│   ├── database/
│   │   ├── index.ts                 # SQLite + FTS5
│   │   └── sqlite-adapter.ts        # Bun/Node compatibility
│   ├── injection/
│   │   ├── manager.ts               # Injection logic
│   │   └── formatters.ts            # Format functions
│   ├── hooks/                       # Claude Code hooks
│   ├── service/
│   │   ├── server.ts                # HTTP + Dashboard
│   │   └── session-manager.ts       # Session tracking
│   └── types.ts                     # TypeScript definitions
├── skills/
│   ├── research/                    # /research skill
│   ├── research-status/             # /research-status skill
│   └── research-detail/             # /research-detail skill
├── plugin.json                      # Claude Code manifest
└── package.json
```

---

## Development

```bash
bun install           # Install dependencies
bun run build         # Build
bun run dev           # Watch mode
bun run start         # Start service
bun run clean         # Clean build
bun test              # Run tests
```

---

## Troubleshooting

**Service won't start**
```bash
lsof -i :3200         # Check port
bun run start         # Start manually
```

**claude-mem not connecting**
```bash
curl http://localhost:37777/api/health   # Check claude-mem
ls ~/.claude-mem/claude-mem.db           # Database exists?
```

**No injections happening**
- Check dashboard: autonomous research enabled?
- Lower thresholds (try 0.6 relevance)
- Verify API keys

**Research not saving to claude-mem**
- Check logs for "fallback mode" (adapter couldn't connect)
- Restart both services

---

## Philosophy

This system is built on a simple insight: **knowledge compounds**.

Every time you solve a problem, make a decision, or learn something new, that knowledge should be available in future sessions. Every research query should benefit not just the current conversation, but all future ones.

The goal isn't to replace Claude's capabilities—it's to give Claude access to two things it doesn't have by default:
1. Memory of your specific project history
2. The ability to look things up during conversation

Combined, these create an assistant that learns your codebase over time and can always fetch current information when needed.

---

## License

AGPL-3.0 — See [LICENSE](LICENSE)

---

<p align="center">
  <sub>Built for developers who want Claude to remember what they've done and know what they don't.</sub>
</p>
