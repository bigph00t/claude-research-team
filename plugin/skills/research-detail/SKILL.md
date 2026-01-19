---
name: research-detail
description: Get detailed information about a specific research finding or observation. Use when injected research mentions "[/research-detail ID]" for more sources and context.
---

# Research Detail Skill

Retrieve full details, sources, and context for a specific research finding or memory observation.

## When to Use

Use this skill when:
- A research injection mentions `[/research-detail <id>]`
- You need more context about a previously injected finding
- You want to see the full sources for a research result
- You need the complete content instead of just the summary

## Usage

Get details for a finding by ID:
```bash
curl -s http://localhost:3200/api/findings/<id> | jq
```

For observations from claude-mem (memory), the ID will be numeric:
```bash
curl -s http://localhost:3200/api/knowledge/<id> | jq
```

## Arguments

Pass the finding ID as the argument:
- `/research-detail abc123` - Get details for finding abc123
- `/research-detail 1847` - Get details for observation #1847

## Response Format

The API returns detailed information including:
- `query` - Original research query
- `summary` - Short summary
- `fullContent` - Complete research content
- `keyPoints` - Bullet point findings (if available)
- `sources` - Array of sources with URLs and snippets
- `confidence` - Quality/confidence score
- `depth` - Research depth (quick/medium/deep)
- `createdAt` - When the research was performed

## Examples

1. **Get research details after injection**:
   When you see: `(confidence: 87%) [/research-detail abc123 for sources]`
   Run: `curl -s http://localhost:3200/api/findings/abc123 | jq`

2. **Get memory observation details**:
   When you see: `[Memory] observation #1847`
   Run: `curl -s http://localhost:3200/api/knowledge/1847 | jq`

3. **Quick check if finding exists**:
   ```bash
   curl -s http://localhost:3200/api/findings/abc123 | jq '.sources | length'
   ```

## Related Skills

- `/research <query>` - Perform new research
- `/research-status` - Check research service status and recent activity
