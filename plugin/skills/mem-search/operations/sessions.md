# Search Sessions (Full-Text)

Search session summaries using natural language queries.

## When to Use

- User asks: "What did we work on last week?"
- User asks: "What sessions involved database work?"
- User asks: "Show me sessions where we fixed bugs"
- Looking for past sessions by topic or theme

## Command

```bash
curl -s "http://localhost:37777/api/search/sessions?query=authentication&format=index&limit=5"
```

## Parameters

- **query** (required): Search terms (e.g., "authentication", "database migration", "bug fixes")
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)
- **dateStart/dateEnd**: Filter by date range (optional)

## When to Use Each Format

**Use format=index for:**
- Quick overviews of past sessions
- Finding session IDs for deeper investigation
- Listing multiple sessions
- **Token cost: ~50-100 per result**

**Use format=full for:**
- Complete session summaries with requests, completions, learnings
- Understanding the full context of a session
- **Token cost: ~500-1000 per result**

## Example Response (format=index)

```json
{
  "query": "authentication",
  "count": 3,
  "format": "index",
  "results": [
    {
      "id": 545,
      "session_id": "S545",
      "title": "Implemented JWT authentication system",
      "subtitle": "Added token-based auth with refresh tokens",
      "created_at_epoch": 1699564800000,
      "project": "api-server"
    }
  ]
}
```

## How to Present Results

For format=index, present as a compact list:

```markdown
Found 3 sessions about "authentication":

🎯 **Session #545** Implemented JWT authentication system
   > Added token-based auth with refresh tokens
   > Nov 9, 2024 • api-server

🎯 **Session #546** Fixed authentication token expiration
   > Resolved race condition in token refresh flow
   > Nov 8, 2024 • api-server
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## Session Summary Structure

Full session summaries include:

- **Session request**: What the user asked for
- **What was completed**: Summary of work done
- **Key learnings**: Important insights and discoveries
- **Files modified**: List of changed files
- **Observations**: Links to detailed observations

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
Response: "No sessions found for 'foobar'. Try different search terms."

## Tips

1. Be specific: "JWT authentication implementation" > "auth"
2. Start with format=index and limit=5-10
3. Use dateStart for recent sessions: `?query=auth&dateStart=2024-11-01`
4. Sessions provide high-level overview, observations provide details
5. Use project filtering when working on one codebase

**Token Efficiency:**
- Start with format=index (~50-100 tokens per result)
- Use format=full only for relevant items (~500-1000 tokens per result)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)

## When to Use Sessions vs Observations

**Use sessions search when:**
- Looking for high-level work summaries
- Understanding what was done in past sessions
- Getting overview of recent activity

**Use observations search when:**
- Looking for specific implementation details
- Finding bugs, features, or decisions
- Need fine-grained context about code changes
