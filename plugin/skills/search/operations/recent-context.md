# Get Recent Context

Get recent session summaries and observations for a project.

## When to Use

- User asks: "What did we do last session?"
- User asks: "What have we been working on?"
- Need to understand recent project activity

## Command

```bash
curl -s "http://localhost:37777/api/context/recent?project=claude-mem&limit=3"
```

## Parameters

- **project**: Project name (default: current directory basename)
- **limit**: Number of recent sessions (default: 3, max: 10)

## Response Structure

Returns complete session data including summaries, observations, and status:

```json
{
  "project": "claude-mem",
  "limit": 3,
  "count": 3,
  "sessions": [
    {
      "sdk_session_id": "abc-123",
      "status": "completed",
      "has_summary": 1,
      "summary": {
        "request": "Add authentication",
        "completed": "Implemented JWT auth...",
        "learned": "...",
        "next_steps": "..."
      },
      "observations": [...]
    }
  ]
}
```

## Use Case: "What did we do last session?"

```bash
# Get last 3 sessions
RESULT=$(curl -s "http://localhost:37777/api/context/recent?limit=3")

# Parse and format:
# - Show session request
# - Show what was completed
# - List key observations
# - Highlight next steps
```

## How to Present Results

```markdown
## Recent Work on claude-mem

### Session 1 (Nov 9, 2024 - Completed)
**Request:** Add user authentication

**Completed:**
- Implemented JWT authentication with token-based auth
- Added middleware for route protection
- Created login and refresh token endpoints

**Key Observations:**
1. 🟣 Implemented JWT authentication (#1234)
2. 🔴 Fixed token expiration edge case (#1235)

**Next Steps:**
- Add password reset functionality
- Implement rate limiting

---

### Session 2 (Nov 8, 2024 - Completed)
...
```

## Tips

1. This is the best operation for "what did we do recently" questions
2. Returns complete context including summaries and observations
3. Active sessions show current work in progress
4. Default limit=3 is usually sufficient for recent context
