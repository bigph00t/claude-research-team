---
description: "Get more detail from a previous research finding"
argument-hint: "<finding-id or query>"
---

# Research Detail

Retrieve full details from a previous research finding when the summary wasn't enough.

## Arguments

- A finding ID (numeric) from previous research
- OR a query string to search past findings

## How to Execute

1. Parse the argument from: $ARGUMENTS

2. If numeric ID, fetch directly:
```bash
curl -s "http://localhost:3200/api/findings/<id>"
```

3. If text query, search findings:
```bash
curl -s "http://localhost:3200/api/findings/search?q=<query>"
```

4. Present full finding details:
   - Complete summary
   - All key findings (not truncated)
   - Full source list with URLs
   - Confidence score
   - Related findings

## Progressive Disclosure

This skill supports the progressive disclosure pattern:
- Level 1: Brief summary (shown in initial injection)
- Level 2: Key findings + sources (this command)
- Level 3: Full content + related research

Request higher levels by adding `--full` flag.
