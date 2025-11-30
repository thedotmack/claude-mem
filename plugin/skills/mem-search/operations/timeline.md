# Get Context Timeline

Get a chronological timeline of observations, sessions, and prompts around a specific point in time.

## When to Use

- User asks: "What was happening when we deployed?"
- User asks: "Show me context around that bug fix"
- User asks: "What happened before and after that change?"
- Need temporal context around an event

## MCP Tool

Use the `get_context_timeline` MCP tool:

```
get_context_timeline(anchor=1234, depth_before=10, depth_after=10)
get_context_timeline(anchor="S545", depth_before=10, depth_after=10)
get_context_timeline(anchor="2024-11-09T12:00:00Z", depth_before=10, depth_after=10)
```

## Parameters

- **anchor** (required): Point in time to center timeline
  - Observation ID: `1234`
  - Session ID: `S545`
  - ISO timestamp: `2024-11-09T12:00:00Z`
- **depth_before**: Number of records before anchor (default: 10, max: 50)
- **depth_after**: Number of records after anchor (default: 10, max: 50)
- **project**: Filter by project name (optional)

## Response Structure

Returns unified chronological timeline:

```json
{
  "anchor": 1234,
  "depth_before": 10,
  "depth_after": 10,
  "total_records": 21,
  "timeline": [
    {
      "record_type": "observation",
      "id": 1230,
      "type": "feature",
      "title": "Added authentication middleware",
      "created_at_epoch": 1699564700000
    },
    {
      "record_type": "prompt",
      "id": 1250,
      "session_id": "S545",
      "prompt_preview": "How do I add JWT authentication?",
      "created_at_epoch": 1699564750000
    },
    {
      "record_type": "observation",
      "id": 1234,
      "type": "feature",
      "title": "Implemented JWT authentication",
      "created_at_epoch": 1699564800000,
      "is_anchor": true
    },
    {
      "record_type": "session",
      "id": 545,
      "session_id": "S545",
      "title": "Implemented JWT authentication system",
      "created_at_epoch": 1699564900000
    }
  ]
}
```

## How to Present Results

Present as chronological narrative with anchor highlighted:

```markdown
## Timeline around Observation #1234

### Before (10 records)

**2:45 PM** - 🟣 Observation #1230: Added authentication middleware

**2:50 PM** - 💬 User asked: "How do I add JWT authentication?"

### ⭐ Anchor Point (2:55 PM)
🟣 **Observation #1234**: Implemented JWT authentication

### After (10 records)

**3:00 PM** - 🎯 Session #545 completed: Implemented JWT authentication system

**3:05 PM** - 🔴 Observation #1235: Fixed token expiration edge case
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## Anchor Types

**Observation ID:**
- Use when you know the specific observation ID
- Example: `anchor=1234`

**Session ID:**
- Use when you want context around a session
- Example: `anchor=S545`

**ISO Timestamp:**
- Use when you know approximate time
- Example: `anchor=2024-11-09T14:30:00Z`

## Error Handling

**Missing anchor parameter:**
```json
{"error": "Missing required parameter: anchor"}
```
Fix: Add the anchor parameter

**Anchor not found:**
```json
{"error": "Anchor not found: 9999"}
```
Response: "Observation #9999 not found. Check the ID or try a different anchor."

**Invalid timestamp:**
```json
{"error": "Invalid timestamp format"}
```
Fix: Use ISO 8601 format: `2024-11-09T14:30:00Z`

## Tips

1. Start with depth_before=10, depth_after=10 for balanced context
2. Increase depth for broader investigation (max: 50 each)
3. Use observation IDs from search results as anchors
4. Timelines show all record types interleaved chronologically
5. Perfect for understanding "what was happening when X occurred"

**Token Efficiency:**
- depth 10/10: ~3,000-4,000 tokens (21 records)
- depth 20/20: ~6,000-8,000 tokens (41 records)
- depth 50/50: ~15,000-20,000 tokens (101 records)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)

## When to Use Timeline

**Use timeline when:**
- Need context around specific event
- Understanding sequence of events
- Investigating "what was happening then?"
- Want all record types (observations, sessions, prompts) together

**Don't use timeline when:**
- Just need recent work (use recent-context)
- Looking for specific topics (use search)
- Don't have an anchor point (use timeline-by-query)

## Comparison with Timeline-by-Query

| Feature | timeline | timeline-by-query |
|---------|----------|-------------------|
| Requires anchor | Yes (ID or timestamp) | No (uses search query) |
| Best for | Known event investigation | Finding then exploring context |
| Steps | 1 (direct timeline) | 2 (search + timeline) |
| Use when | You have observation ID | You have search term |

Timeline is faster when you already know the anchor point.
