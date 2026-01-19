# Claude Research Team

A research system for Claude Code that provides web search, documentation lookup, and AI synthesis through slash commands.

## Features

- **Multi-source search**: Serper, Brave, GitHub, StackOverflow, npm, PyPI, crates.io, Wikipedia, ArXiv, HackerNews, Reddit, MDN, and more
- **AI synthesis**: Results synthesized by Claude or Gemini Flash
- **Depth control**: Quick (~10s), medium (~30s), or deep (~60s) research
- **Dashboard**: Web UI at http://localhost:3200

## Quick Install

### 1. Clone and build

```bash
git clone https://github.com/bigph00t/claude-research-team
cd claude-research-team
npm install
npm run build
```

### 2. Configure API keys

Create `.env` file:

```bash
# At least one search API required
SERPER_API_KEY=xxx       # serper.dev (2,500/mo free)
BRAVE_API_KEY=xxx        # brave.com/search/api (2,000/mo free)

# Optional
GITHUB_TOKEN=xxx         # For GitHub search
GEMINI_API_KEY=xxx       # Alternative AI provider
```

### 3. Install commands

Copy the slash commands to your Claude Code commands directory:

```bash
cp commands/*.md ~/.claude/commands/
```

### 4. Start the service

```bash
npm run start
```

## Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/research <query>` | Research a topic |
| `/research-status` | Check service status |
| `/research-detail <id>` | Get full details on a finding |
| `/fetch <url>` | Fetch and extract content from a URL |

### Research Depths

```bash
/research What is HTMX                              # quick (default for simple queries)
/research How to implement rate limiting --depth medium
/research Rust vs Go for CLI tools --depth deep
```

| Depth | Time | Best For |
|-------|------|----------|
| quick | ~10s | Facts, definitions |
| medium | ~30s | How-to, documentation |
| deep | ~60s | Comparisons, analysis |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Research Service (:3200)            │
├─────────────────────────────────────────────────┤
│                                                  │
│  Coordinator                                     │
│  └── Routes queries to specialist agents         │
│                                                  │
│  ├── WebSearchAgent     (Serper, Brave, DDG)    │
│  ├── CodeExpertAgent    (GitHub, StackOverflow) │
│  ├── DocsExpertAgent    (npm, PyPI, MDN, etc)   │
│  ├── CommunityExpert    (HackerNews, Reddit)    │
│  └── ResearchExpert     (Wikipedia, ArXiv)      │
│                                                  │
│  AI Synthesis (Claude SDK or Gemini Flash)       │
│                                                  │
└─────────────────────────────────────────────────┘
```

## Search Sources

### Free (no API key)
- DuckDuckGo, StackOverflow, npm, PyPI, crates.io, MDN, Dev.to, Wikipedia, ArXiv, HackerNews, Reddit

### Requires API key
- Serper (Google results), Brave Search, Tavily, GitHub

## API

```bash
# Start research
POST /api/research
{"query": "...", "depth": "quick|medium|deep"}

# Check status
GET /api/research/:id

# Get findings
GET /api/findings

# Health check
GET /api/health
```

## Dashboard

Open http://localhost:3200 to:
- View research history
- Configure settings
- Monitor activity

## Development

```bash
npm install       # Install deps
npm run build     # Build
npm run dev       # Watch mode
npm run start     # Start service
```

## Project Structure

```
claude-research-team/
├── .claude-plugin/
│   └── plugin.json       # Plugin manifest
├── commands/             # Slash command definitions
│   ├── research.md
│   ├── research-status.md
│   ├── research-detail.md
│   └── fetch.md
├── skills/               # Agent skills (SKILL.md files)
├── src/                  # TypeScript source
│   ├── agents/           # Specialist agents
│   ├── crew/             # Multi-agent orchestration
│   ├── service/          # HTTP server + dashboard
│   └── ...
└── dist/                 # Compiled output
```

## Troubleshooting

**Service won't start**
```bash
lsof -i :3200        # Check if port in use
npm run start        # Start manually
```

**Commands not working**
```bash
# Verify commands are installed
ls ~/.claude/commands/research.md

# Re-copy if missing
cp commands/*.md ~/.claude/commands/
```

**No results**
- Check API keys in `.env`
- Verify service is running: `curl http://localhost:3200/api/health`

## License

AGPL-3.0
