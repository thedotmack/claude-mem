# Timeline by Query

Search for observations and get timeline context in a single request. Combines search + timeline into one operation.

## When to Use

- User asks: "What was happening when we worked on authentication?"
- User asks: "Show me context around bug fixes"
- User asks: "Timeline of database work"
- Need to find something then see temporal context

## MCP Tool

Use the `get_timeline_by_query` MCP tool:

```
# Auto mode: Uses top search result as timeline anchor
get_timeline_by_query(query="authentication", mode="auto", depth_before=10, depth_after=10)

# Interactive mode: Shows top N search results for manual selection
get_timeline_by_query(query="authentication", mode="interactive", limit=5)
```

## Parameters

- **query** (required): Search terms (e.g., "authentication", "bug fix", "database")
- **mode**: Search mode
  - `auto` (default): Automatically uses top search result as timeline anchor
  - `interactive`: Returns top N search results for manual anchor selection
- **depth_before**: Records before anchor (default: 10, max: 50) - for auto mode
- **depth_after**: Records after anchor (default: 10, max: 50) - for auto mode
- **limit**: Number of search results (default: 5, max: 20) - for interactive mode
- **project**: Filter by project name (optional)

## Auto Mode (Recommended)

Automatically gets timeline around best match:

```
get_timeline_by_query(query="JWT authentication", mode="auto", depth_before=10, depth_after=10)
```

**Response:**
```json
{
  "query": "JWT authentication",
  "mode": "auto",
  "best_match": {
    "id": 1234,
    "type": "feature",
    "title": "Implemented JWT authentication",
    "score": 0.95
  },
  "timeline": [
    // ... timeline records around observation #1234
  ]
}
```

**When to use auto mode:**
- You're confident the top result is what you want
- Want fastest path to timeline context
- Query is specific enough for accurate top result

## Interactive Mode

Shows top search results for manual review:

```
get_timeline_by_query(query="authentication", mode="interactive", limit=5)
```

**Response:**
```json
{
  "query": "authentication",
  "mode": "interactive",
  "top_matches": [
    {
      "id": 1234,
      "type": "feature",
      "title": "Implemented JWT authentication",
      "subtitle": "Added token-based auth with refresh tokens",
      "score": 0.95
    },
    {
      "id": 1240,
      "type": "bugfix",
      "title": "Fixed authentication token expiration",
      "subtitle": "Resolved race condition in refresh flow",
      "score": 0.87
    }
  ],
  "next_step": "Use get_context_timeline(anchor=<id>, depth_before=10, depth_after=10)"
}
```

**When to use interactive mode:**
- Query is broad and may have multiple relevant results
- Want to review options before getting timeline
- Not sure which result is most relevant

## How to Present Results

**For auto mode:**

```markdown
## Timeline: JWT authentication

**Best Match:** 🟣 Observation #1234 - Implemented JWT authentication (score: 0.95)

### Before (10 records)
**2:45 PM** - 🟣 Added authentication middleware

### ⭐ Anchor Point (2:55 PM)
🟣 **Observation #1234**: Implemented JWT authentication

### After (10 records)
**3:00 PM** - 🎯 Session completed: JWT authentication system
```

**For interactive mode:**

```markdown
Found 5 matches for "authentication":

1. 🟣 **#1234** Implemented JWT authentication (score: 0.95)
   > Added token-based auth with refresh tokens

2. 🔴 **#1240** Fixed authentication token expiration (score: 0.87)
   > Resolved race condition in refresh flow

To see timeline context, use observation ID with timeline operation.
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## Error Handling

**Missing query parameter:**
```json
{"error": "Missing required parameter: query"}
```
Fix: Add the query parameter

**No results found:**
```json
{"query": "foobar", "top_matches": []}
```
Response: "No results found for 'foobar'. Try different search terms."

## Tips

1. **Use auto mode** for specific queries: "JWT authentication implementation"
2. **Use interactive mode** for broad queries: "authentication"
3. Start with depth 10/10 for balanced context
4. Be specific in queries for better auto mode accuracy
5. This is fastest way to find + explore context in one request

**Token Efficiency:**
- Auto mode: ~3,000-4,000 tokens (search + timeline)
- Interactive mode: ~500-1,000 tokens (search results only)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)

## Workflow Comparison

**timeline-by-query (auto):**
1. One request → get timeline around best match
2. ~3,000 tokens

**timeline-by-query (interactive) → timeline:**
1. First request → see top matches (~500 tokens)
2. Second request → get timeline for chosen match (~3,000 tokens)
3. Total: ~3,500 tokens

**observations search → timeline:**
1. Search observations (~500 tokens)
2. Get timeline for chosen result (~3,000 tokens)
3. Total: ~3,500 tokens

Use auto mode when you're confident about the query. Use interactive mode or separate search when you want more control.

## When to Use Timeline-by-Query

**Use timeline-by-query when:**
- Need to find something AND see temporal context
- Want one-request convenience (auto mode)
- Investigating "what was happening when we worked on X?"
- Don't have observation ID already

**Don't use timeline-by-query when:**
- Already have observation ID (use timeline instead)
- Just need search results (use observations search)
- Need recent work overview (use recent-context)
