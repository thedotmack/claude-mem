# API Help

Get comprehensive API documentation from the search service.

## Wrapper Script (Recommended)

The `claude-mem-search` wrapper script provides a unified interface to all search endpoints with:
- **Single permission prompt** (no repeated permission requests)
- Proper error handling
- Clean output formatting

### Usage Examples

```bash
# Search operations
claude-mem-search.cjs observations "authentication" --format=index --limit=5
claude-mem-search.cjs sessions "bug fix" --format=index
claude-mem-search.cjs prompts "implement feature" --project=myapp

# Filtered search
claude-mem-search.cjs by-type bugfix --limit=10 --from=2025-11-09T00:00:00
claude-mem-search.cjs by-concept discovery --limit=5
claude-mem-search.cjs by-file "auth/login.ts" --format=index

# Context retrieval
claude-mem-search.cjs recent --project=myapp --limit=3
claude-mem-search.cjs timeline 1234 --depth-before=5 --depth-after=5
claude-mem-search.cjs timeline-by-query "authentication" --depth-before=10

# Documentation
claude-mem-search.cjs help
```

## Direct API Command

You can also access the API directly using curl:

```bash
curl -s "http://localhost:37777/api/search/help"
```

**Note:** Direct curl usage requires permission for each API call, which can become tedious when making multiple requests. Use the wrapper script for better usability.

## Response

Returns complete API documentation in JSON format including:
- All 10 endpoint paths
- HTTP methods (all GET)
- Parameter descriptions
- Example curl commands

## Example Response

```json
{
  "title": "Claude-Mem Search API",
  "description": "HTTP API for searching persistent memory",
  "endpoints": [
    {
      "path": "/api/search/observations",
      "method": "GET",
      "description": "Search observations using full-text search",
      "parameters": {
        "query": "Search query (required)",
        "format": "Response format: 'index' or 'full' (default: 'full')",
        "limit": "Number of results (default: 20)",
        "project": "Filter by project name (optional)"
      }
    },
    // ... 9 more endpoints
  ],
  "examples": [
    "curl \"http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5\"",
    "curl \"http://localhost:37777/api/search/by-type?type=bugfix&limit=10\"",
    // ... more examples
  ]
}
```

## When to Use

- User asks: "How do I use the search API?"
- Need to see all available endpoints
- Reference for parameter names and formats
- Getting started with search

## How to Present

```markdown
## Claude-Mem Search API Documentation

**Base URL:** http://localhost:37777
**Port:** Configurable via `CLAUDE_MEM_WORKER_PORT` (default: 37777)

### Available Endpoints

**Full-Text Search:**
1. `GET /api/search/observations` - Search observations by keyword
2. `GET /api/search/sessions` - Search session summaries
3. `GET /api/search/prompts` - Search user prompts

**Filtered Search:**
4. `GET /api/search/by-type` - Filter by observation type
5. `GET /api/search/by-concept` - Filter by concept tags
6. `GET /api/search/by-file` - Find work by file path

**Context Retrieval:**
7. `GET /api/context/recent` - Get recent sessions
8. `GET /api/context/timeline` - Timeline around a point
9. `GET /api/timeline/by-query` - Search + timeline in one call

**Documentation:**
10. `GET /api/search/help` - This help documentation

### Example Usage

\`\`\`bash
# Search for authentication-related observations
curl "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"

# Get recent bugfixes
curl "http://localhost:37777/api/search/by-type?type=bugfix&limit=10"

# Get timeline around observation #1234
curl "http://localhost:37777/api/context/timeline?anchor=1234&depth_before=5&depth_after=5"
\`\`\`

For detailed information on each endpoint, see the operation-specific documentation files.
```

## Tips

- This endpoint is useful for quick API reference
- Most users won't need to use this directly
- The router SKILL.md provides better user-facing guidance
- Use this when users specifically ask "how do I use the API"
