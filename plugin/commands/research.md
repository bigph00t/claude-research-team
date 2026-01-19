---
description: "Research a topic using autonomous web search and AI synthesis"
argument-hint: "<query> [--depth quick|medium|deep]"
---

# Research Skill

Research a topic using web search and specialist agents. Results are synthesized by AI and stored for future reference.

## Arguments

The query to research, optionally followed by depth:
- `--depth quick` - Fast lookup (~10s) for simple facts
- `--depth medium` - Standard research (~30s) for how-to questions (default)
- `--depth deep` - Comprehensive analysis (~60s) for comparisons

## How to Execute

1. Parse the query from: $ARGUMENTS
2. Extract depth if specified (default: medium)
3. Call the research service API:

```bash
curl -X POST http://localhost:3200/api/research \
  -H "Content-Type: application/json" \
  -d '{"query": "<parsed_query>", "depth": "<depth>", "trigger": "manual"}'
```

4. Poll for results at: `GET http://localhost:3200/api/research/<task_id>`
5. Present the findings to the user

## Alternative: Direct Execution

For immediate results without polling, use the execute endpoint:

```bash
curl -X POST http://localhost:3200/api/research/execute \
  -H "Content-Type: application/json" \
  -d '{"query": "<parsed_query>", "depth": "<depth>"}'
```

This returns results directly (takes longer but no polling needed).

## Examples

- `/research What is HTMX` - Quick fact lookup
- `/research How to implement rate limiting in FastAPI` - Medium depth how-to
- `/research Rust vs Go for CLI tools --depth deep` - Deep comparison

## Service Status

If the service isn't running, inform the user to start it:
```bash
cd /home/bigphoot/Desktop/Projects/claude-research-team && npm run start
```

Dashboard available at: http://localhost:3200
