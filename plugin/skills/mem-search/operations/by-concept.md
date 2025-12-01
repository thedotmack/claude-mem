# Search by Concept

Find observations tagged with specific concepts.

## When to Use

- User asks: "What discoveries did we make?"
- User asks: "What patterns did we identify?"
- User asks: "What gotchas did we encounter?"
- Looking for observations with semantic tags

## Command

```bash
curl -s "http://localhost:37777/api/search/by-concept?concept=discovery&format=index&limit=5"
```

## Parameters

- **concept** (required): Concept tag to search for
  - `discovery` - New discoveries and insights
  - `problem-solution` - Problems and their solutions
  - `what-changed` - Change descriptions
  - `how-it-works` - Explanations of mechanisms
  - `pattern` - Identified patterns
  - `gotcha` - Edge cases and gotchas
  - `change` - General changes
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)
- **dateStart/dateEnd**: Filter by date range (optional)

## When to Use Each Format

**Use format=index for:**
- Quick overviews of observations by concept
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
  "concept": "discovery",
  "count": 3,
  "format": "index",
  "results": [
    {
      "id": 1240,
      "type": "discovery",
      "title": "Worker service uses PM2 for process management",
      "subtitle": "Discovered persistent background worker pattern",
      "created_at_epoch": 1699564800000,
      "project": "claude-mem",
      "concepts": ["discovery", "how-it-works"]
    }
  ]
}
```

## How to Present Results

For format=index, present as a compact list:

```markdown
Found 3 observations tagged with "discovery":

🔵 **#1240** Worker service uses PM2 for process management
   > Discovered persistent background worker pattern
   > Nov 9, 2024 • claude-mem
   > Tags: discovery, how-it-works

🔵 **#1241** FTS5 full-text search enables instant searches
   > SQLite FTS5 virtual tables provide sub-100ms search
   > Nov 9, 2024 • claude-mem
   > Tags: discovery, pattern
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## Available Concepts

| Concept | Description | When to Use |
|---------|-------------|-------------|
| `discovery` | New discoveries and insights | Finding what was learned |
| `problem-solution` | Problems and their solutions | Finding how issues were resolved |
| `what-changed` | Change descriptions | Understanding what changed |
| `how-it-works` | Explanations of mechanisms | Learning how things work |
| `pattern` | Identified patterns | Finding design patterns |
| `gotcha` | Edge cases and gotchas | Learning about pitfalls |
| `change` | General changes | Tracking modifications |

## Error Handling

**Missing concept parameter:**
```json
{"error": "Missing required parameter: concept"}
```
Fix: Add the concept parameter

**Invalid concept:**
```json
{"error": "Invalid concept: foobar. Valid concepts: discovery, problem-solution, what-changed, how-it-works, pattern, gotcha, change"}
```
Fix: Use one of the valid concept values

## Tips

1. Use format=index first to see overview
2. Start with limit=5-10 to avoid token overload
3. Combine concepts with type filtering for precision
4. Use `discovery` for learning what was found during investigation
5. Use `problem-solution` for finding how past issues were resolved

**Token Efficiency:**
- Start with format=index (~50-100 tokens per result)
- Use format=full only for relevant items (~500-1000 tokens per result)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)
