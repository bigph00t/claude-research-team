---
description: "Fetch content from a specific URL and store it"
argument-hint: "<url>"
---

# Fetch Skill

Fetch and extract content from a specific URL. Use when you have a direct link rather than needing to search.

## Arguments

The URL to fetch: $ARGUMENTS

## How to Execute

1. Extract the URL from arguments
2. Call the fetch endpoint:

```bash
curl -X POST http://localhost:3200/api/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "<url>"}'
```

3. Present the extracted content to the user:
   - Page title
   - Main content (cleaned/extracted)
   - Metadata (author, date if available)

## Content Extraction

The service uses Jina Reader for intelligent content extraction:
- Removes navigation, ads, footers
- Extracts main article content
- Preserves code blocks and formatting
- Handles various page types (docs, blogs, repos)

## When to Use

- User provides a specific URL to analyze
- Following up on a search result
- Fetching documentation from a known source
- Reading GitHub READMEs or wiki pages

## When NOT to Use

- Searching for information (use /research instead)
- Need to explore multiple sources
- Don't have a specific URL
