# Get Timeline

Get a chronological timeline around a specific point in time.

## When to Use

- User asks: "What was happening when we fixed that bug?"
- Need context around a specific observation or session
- Understanding the sequence of events

## Command

```bash
# Around an observation ID
curl -s "http://localhost:37777/api/context/timeline?anchor=1234&depth_before=10&depth_after=10"

# Around a session ID
curl -s "http://localhost:37777/api/context/timeline?anchor=S123&depth_before=10&depth_after=10"

# Around a timestamp
curl -s "http://localhost:37777/api/context/timeline?anchor=2024-11-09T15:30:00Z&depth_before=10&depth_after=10"
```

## Parameters

- **anchor** (required): Observation ID (number), Session ID ("S123"), or ISO timestamp
- **depth_before**: Number of records before anchor (default: 10, max: 50)
- **depth_after**: Number of records after anchor (default: 10, max: 50)
- **project**: Filter by project name (optional)

## Response Structure

Returns unified timeline with observations, sessions, and prompts interleaved chronologically:

```json
{
  "anchor": "1234",
  "depth_before": 10,
  "depth_after": 10,
  "timeline": {
    "observations": [...],
    "sessions": [...],
    "prompts": [...]
  }
}
```

## Workflow: "What was happening when we fixed that auth bug?"

1. First, find the bug observation:
```bash
curl -s "http://localhost:37777/api/search/observations?query=auth+bug&format=index&limit=5"
# Get observation ID (e.g., #1234)
```

2. Then get timeline around it:
```bash
curl -s "http://localhost:37777/api/context/timeline?anchor=1234&depth_before=5&depth_after=5"
```

## How to Present Results

Present chronologically grouped by day:

```markdown
## Timeline around Observation #1234

**Window:** 5 records before → 5 records after
**Total:** 12 items (7 obs, 3 sessions, 2 prompts)

### Nov 8, 2024

**4:30 PM** - 🎯 **Session Request:** "Add user authentication"

**4:45 PM** - 🔵 **Discovery #1230:** "JWT library options compared"
> Evaluated 3 libraries: jsonwebtoken, jose, passport-jwt

**5:00 PM** - 🧠 **Decision #1231:** "Chose jsonwebtoken for simplicity"

### Nov 9, 2024

**3:30 PM** - 🟣 **Feature #1234:** "Implemented JWT authentication"  ← ANCHOR

**4:00 PM** - 🔴 **Bugfix #1235:** "Fixed token expiration edge case"
> Handled race condition in refresh flow
```

**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | 🔵 discovery | 🧠 decision

For complete formatting guidelines, see [formatting.md](formatting.md).

## Tips

1. Use depth_before=5, depth_after=5 for focused context
2. Increase depth for broader investigation
3. Timeline shows the full story around a specific point
4. Helps understand causality and sequence of events
