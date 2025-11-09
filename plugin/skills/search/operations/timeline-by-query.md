# Timeline by Query

Search for something, then automatically get timeline context around the best match.

## When to Use

- User asks: "What led to the authentication refactor?"
- Want to find something AND see surrounding context in one request
- Understand the full story with minimal requests

## Command

```bash
curl -s "http://localhost:37777/api/timeline/by-query?query=authentication+refactor&mode=auto&depth_before=10&depth_after=10"
```

## Parameters

- **query** (required): Search terms
- **mode**: Where to search (default: "auto")
  - `"auto"`: Search both observations and sessions, return best match
  - `"observations"`: Search only observations
  - `"sessions"`: Search only sessions
- **depth_before**: Records before match (default: 10, max: 50)
- **depth_after**: Records after match (default: 10, max: 50)
- **project**: Filter by project name (optional)

## Response Structure

Returns both the best match AND timeline around it:

```json
{
  "query": "authentication refactor",
  "mode": "auto",
  "match": {
    "type": "observation",
    "id": 1234,
    "title": "Refactored authentication middleware",
    "score": 0.95,
    "created_at_epoch": 1699564800000
  },
  "depth_before": 10,
  "depth_after": 10,
  "timeline": {
    "observations": [...],
    "sessions": [...],
    "prompts": [...]
  }
}
```

## Use Case: "What led to the authentication refactor?"

One query gets both:
1. The authentication refactor observation (best match)
2. Complete timeline before and after showing what led to it

```bash
curl -s "http://localhost:37777/api/timeline/by-query?query=authentication+refactor&depth_before=10&depth_after=10"
```

## How to Present Results

```markdown
## Found: Refactored authentication middleware (Observation #1234)

**Match score:** 0.95
**Date:** Nov 9, 2024 3:30 PM

### Timeline (10 before → 10 after)

**Total:** 18 items (11 obs, 5 sessions, 2 prompts)

### Nov 8, 2024

**2:00 PM** - 🔴 **Bugfix #1220:** "Fixed token validation bug"
> Tokens weren't properly validated

**3:00 PM** - 🔵 **Discovery #1225:** "Current auth middleware is fragile"
> Multiple edge cases not handled

### Nov 9, 2024

**3:30 PM** - 🔄 **Refactor #1234:** "Refactored authentication middleware"  ← MATCH
> Complete rewrite with better error handling

**4:00 PM** - ✅ **Change #1235:** "Updated all routes to use new middleware"
```

## Tips

1. This is the most efficient operation for "what led to X" questions
2. One request instead of two (search + timeline)
3. Use mode="auto" to search both observations and sessions
4. Adjust depth based on how much context you need
5. Great for understanding causality and sequence
