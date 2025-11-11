# Search Observations (Full-Text)

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

- **query** (required): Search terms (e.g., "authentication", "bug fix", "database migration")
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)

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

## Error Handling

**Missing query parameter:**
```json
{"error": "Missing required parameter: query"}
```
Fix: Add the query parameter

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
