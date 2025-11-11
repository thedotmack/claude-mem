# Get Recent Context

Get recent session summaries and observations for a project.

## When to Use

- User asks: "What did we do last session?"
- User asks: "What have we been working on recently?"
- User asks: "Catch me up on recent work"
- Starting a new session and need context

## Command

```bash
curl -s "http://localhost:37777/api/context/recent?project=api-server&limit=3"
```

## Parameters

- **project**: Project name (defaults to current working directory basename)
- **limit**: Number of recent sessions to retrieve (default: 3, max: 10)

## Response Structure

Returns combined context from recent sessions:

```json
{
  "project": "api-server",
  "limit": 3,
  "sessions": [
    {
      "id": 545,
      "session_id": "S545",
      "title": "Implemented JWT authentication system",
      "request": "Add JWT authentication with refresh tokens",
      "completion": "Implemented token-based auth with refresh logic",
      "learnings": "JWT expiration requires careful handling of refresh race conditions",
      "created_at_epoch": 1699564800000,
      "observations": [
        {
          "id": 1234,
          "type": "feature",
          "title": "Implemented JWT authentication",
          "subtitle": "Added token-based auth with refresh tokens",
          "files": ["src/auth/jwt.ts", "src/auth/refresh.ts"]
        }
      ]
    }
  ]
}
```

## How to Present Results

Present as a chronological narrative:

```markdown
## Recent Work on api-server

### Session #545 - Nov 9, 2024
**Request:** Add JWT authentication with refresh tokens

**Completed:**
- Implemented token-based auth with refresh logic
- Added JWT signing and verification
- Created refresh token rotation

**Key Learning:** JWT expiration requires careful handling of refresh race conditions

**Observations:**
- 🟣 **#1234** Implemented JWT authentication
  - Files: jwt.ts, refresh.ts
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## Default Project Detection

If no project parameter is provided, uses current working directory:

```bash
# Auto-detects project from current directory
curl -s "http://localhost:37777/api/context/recent?limit=3"
```

## Error Handling

**No sessions found:**
```json
{"project": "new-project", "sessions": []}
```
Response: "No recent sessions found for 'new-project'. This might be a new project."

**Worker not running:**
Connection refused error. Inform user to check if worker is running: `pm2 list`

## Tips

1. Start with limit=3 for quick overview (default)
2. Increase to limit=5-10 for deeper context
3. Recent context is perfect for session start
4. Combines both sessions and observations in one request
5. Use this when user asks "what did we do last time?"

**Token Efficiency:**
- limit=3 sessions: ~1,500-2,500 tokens (includes observations)
- limit=5 sessions: ~2,500-4,000 tokens
- limit=10 sessions: ~5,000-8,000 tokens
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)

## When to Use Recent Context

**Use recent-context when:**
- Starting a new session
- User asks about recent work
- Need quick catch-up on project activity
- Want both sessions and observations together

**Don't use recent-context when:**
- Looking for specific topics (use search instead)
- Need timeline around specific event (use timeline instead)
- Want only observations or only sessions (use search operations)

## Comparison with Other Operations

| Operation | Use Case | Token Cost |
|-----------|----------|------------|
| recent-context | Quick catch-up on recent work | 1,500-4,000 |
| sessions search | Find sessions by topic | 50-100 per result (index) |
| observations search | Find specific implementations | 50-100 per result (index) |
| timeline | Context around specific point | 3,000-6,000 |

Recent context is optimized for "what happened recently?" questions with minimal token usage.
