# Search by Type

Find observations by type: bugfix, feature, refactor, decision, discovery, or change.

## When to Use

- User asks: "What bugs did we fix?"
- User asks: "What features did we add?"
- User asks: "What decisions did we make?"
- Looking for specific types of work

## Command

```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&format=index&limit=5"
```

## Parameters

- **type** (required): One or more types (comma-separated)
  - `bugfix` - Bug fixes
  - `feature` - New features
  - `refactor` - Code refactoring
  - `decision` - Architectural/design decisions
  - `discovery` - Discoveries and insights
  - `change` - General changes
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)
- **dateStart/dateEnd**: Filter by date range (optional)

## When to Use Each Format

**Use format=index for:**
- Quick overviews of work by type
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
  "type": "bugfix",
  "count": 5,
  "format": "index",
  "results": [
    {
      "id": 1235,
      "type": "bugfix",
      "title": "Fixed token expiration edge case",
      "subtitle": "Handled race condition in refresh flow",
      "created_at_epoch": 1699564800000,
      "project": "api-server"
    }
  ]
}
```

## How to Present Results

For format=index, present as a compact list with type emojis:

```markdown
Found 5 bugfixes:

🔴 **#1235** Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024 • api-server

🔴 **#1236** Resolved memory leak in worker
   > Fixed event listener cleanup
   > Nov 8, 2024 • worker-service
```

**Type Emojis:**
- 🔴 bugfix
- 🟣 feature
- 🔄 refactor
- 🔵 discovery
- 🧠 decision
- ✅ change

For complete formatting guidelines, see [formatting.md](formatting.md).

## Multiple Types

To search for multiple types:

```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix,feature&format=index&limit=10"
```

## Error Handling

**Missing type parameter:**
```json
{"error": "Missing required parameter: type"}
```
Fix: Add the type parameter

**Invalid type:**
```json
{"error": "Invalid type: foobar. Valid types: bugfix, feature, refactor, decision, discovery, change"}
```
Fix: Use one of the valid type values

## Tips

1. Use format=index first to see overview
2. Start with limit=5-10 to avoid token overload
3. Combine with dateStart for recent work: `?type=bugfix&dateStart=2024-11-01`
4. Use project filtering when working on one codebase

**Token Efficiency:**
- Start with format=index (~50-100 tokens per result)
- Use format=full only for relevant items (~500-1000 tokens per result)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)
