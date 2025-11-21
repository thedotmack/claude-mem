# Search Observations (Semantic + Full-Text Hybrid)

Search all observations using natural language queries.

## When to Use

- User asks: "How did we implement authentication?"
- User asks: "What bugs did we fix?"
- User asks: "What features did we add?"
- Looking for past work by keyword or topic

## Command

```bash
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"
```

## Parameters

- **query** (optional): Natural language search query - uses semantic search (ChromaDB) for ranking with SQLite FTS5 fallback (e.g., "authentication", "bug fix", "database migration"). Can be omitted for filter-only searches.
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)
- **dateRange**: Filter by date range (optional) - `dateRange[start]` and/or `dateRange[end]`
- **obs_type**: Filter by observation type: bugfix, feature, refactor, decision, discovery, change (optional)
- **concepts**: Filter by concept tags (optional)
- **files**: Filter by file paths (optional)

**Important**: When omitting `query`, you MUST provide at least one filter (project, dateRange, obs_type, concepts, or files)

## When to Use Each Format

**Use format=index for:**
- Quick overviews
- Finding IDs for deeper investigation
- Listing multiple results
- **Token cost: ~50-100 per result**

**Use format=full for:**
- Complete details including narrative, facts, files, concepts
- Understanding the full context of specific observations
- **Token cost: ~500-1000 per result**

## Example Response (format=index)

```json
{
  "query": "authentication",
  "count": 5,
  "format": "index",
  "results": [
    {
      "id": 1234,
      "type": "feature",
      "title": "Implemented JWT authentication",
      "subtitle": "Added token-based auth with refresh tokens",
      "created_at_epoch": 1699564800000,
      "project": "api-server",
      "score": 0.95
    }
  ]
}
```

## How to Present Results

For format=index, present as a compact list:

```markdown
Found 5 results for "authentication":

1. **#1234** [feature] Implemented JWT authentication
   > Added token-based auth with refresh tokens
   > Nov 9, 2024 • api-server

2. **#1235** [bugfix] Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024 • api-server
```

**Include:** ID (for follow-up), type emoji (🔴 bugfix, 🟣 feature, 🔄 refactor, 🔵 discovery, 🧠 decision, ✅ change), title, subtitle, date, project.

For complete formatting guidelines, see formatting.md (documentation coming soon).

## Filter-Only Examples

Search without query text (direct SQLite filtering):

```bash
# Get all observations from November 2025
curl -s "http://localhost:37777/api/search?type=observations&dateRange[start]=2025-11-01&format=index"

# Get all bug fixes from a specific project
curl -s "http://localhost:37777/api/search?type=observations&obs_type=bugfix&project=api-server&format=index"

# Get all observations from last 7 days
curl -s "http://localhost:37777/api/search?type=observations&dateRange[start]=2025-11-11&format=index"
```

## Error Handling

**Missing query and filters:**
```json
{"error": "Either query or filters required for search"}
```
Fix: Provide either a query parameter OR at least one filter (project, dateRange, obs_type, concepts, files)

**No results found:**
```json
{"query": "foobar", "count": 0, "results": []}
```
Response: "No results found for 'foobar'. Try different search terms."

## Tips

1. Be specific: "authentication JWT" > "auth"
2. Start with format=index and limit=5-10
3. Use project filtering when working on one codebase
4. If no results, try broader terms or check spelling

**Token Efficiency:**
- Start with format=index (~50-100 tokens per result)
- Use format=full only for relevant items (~500-1000 tokens per result)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)
