# API Help

Get comprehensive API documentation for all search endpoints.

## When to Use

- User asks: "What search operations are available?"
- User asks: "How do I use the search API?"
- Need reference documentation for endpoints
- Want to see all available parameters

## Command

```bash
curl -s "http://localhost:37777/api/help"
```

## Response Structure

Returns complete API documentation:

```json
{
  "version": "5.4.0",
  "base_url": "http://localhost:37777/api",
  "endpoints": [
    {
      "path": "/search/observations",
      "method": "GET",
      "description": "Search observations using full-text search",
      "parameters": [
        {
          "name": "query",
          "required": true,
          "type": "string",
          "description": "Search terms"
        },
        {
          "name": "format",
          "required": false,
          "type": "string",
          "default": "full",
          "options": ["index", "full"],
          "description": "Response format"
        }
      ],
      "example": "curl -s \"http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5\""
    }
  ]
}
```

## How to Present Results

Present as reference documentation:

```markdown
## claude-mem Search API Reference (v5.4.0)

Base URL: `http://localhost:37777/api`

### Search Operations

**1. Search Observations**
- **Endpoint:** `GET /search/observations`
- **Description:** Search observations using full-text search
- **Parameters:**
  - `query` (required, string): Search terms
  - `format` (optional, string): "index" or "full" (default: "full")
  - `limit` (optional, number): Max results (default: 20, max: 100)
- **Example:**
  ```bash
  curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"
  ```

[... continue for all endpoints ...]
```

## Endpoint Categories

The API help response organizes endpoints by category:

1. **Full-Text Search**
   - `/search/observations`
   - `/search/sessions`
   - `/search/prompts`

2. **Filtered Search**
   - `/search/by-type`
   - `/search/by-concept`
   - `/search/by-file`

3. **Context Retrieval**
   - `/context/recent`
   - `/timeline/context`
   - `/timeline/by-query`

4. **Utilities**
   - `/help`

## Common Parameters

Many endpoints share these parameters:

- **format**: "index" (summary) or "full" (complete details)
- **limit**: Number of results to return
- **offset**: Number of results to skip (for pagination)
- **project**: Filter by project name
- **dateStart/dateEnd**: Filter by date range
  - `dateStart`: Start date (YYYY-MM-DD or epoch timestamp)
  - `dateEnd`: End date (YYYY-MM-DD or epoch timestamp)

## Error Handling

**Worker not running:**
Connection refused error. Response: "The search API isn't available. Check if worker is running: `pm2 list`"

**Invalid endpoint:**
```json
{"error": "Not found"}
```
Response: "Invalid API endpoint. Use /api/help to see available endpoints."

## Tips

1. Save help response for reference during investigation
2. Use examples as starting point for your queries
3. Check required parameters before making requests
4. Refer to format options for each endpoint
5. All endpoints use GET method with query parameters

**Token Efficiency:**
- Help response: ~2,000-3,000 tokens (complete API reference)
- Use sparingly - refer to operation-specific docs instead
- Keep help response cached for repeated reference

## When to Use Help

**Use help when:**
- Starting to use the search API
- Need complete parameter reference
- Forgot which endpoints are available
- Want to see all options at once

**Don't use help when:**
- You know which operation you need (use operation-specific docs)
- Just need examples (use common-workflows.md)
- Token budget is limited (help is comprehensive)

## Alternative to Help Endpoint

Instead of calling `/api/help`, you can:

1. **Use SKILL.md** - Quick decision guide with operation links
2. **Use operation docs** - Detailed guides for specific endpoints
3. **Use common-workflows.md** - Step-by-step examples
4. **Use formatting.md** - Response presentation templates

The help endpoint is most useful when you need complete API reference in one response.

## API Versioning

The help response includes version information:

```json
{
  "version": "5.4.0",
  "skill_migration": true,
  "deprecated": {
    "mcp_tools": "Replaced by HTTP API in v5.4.0"
  }
}
```

Check version to ensure compatibility with documentation.
