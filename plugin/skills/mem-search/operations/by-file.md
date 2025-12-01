# Search by File

Find all work related to a specific file path.

## When to Use

- User asks: "What changes to auth/login.ts?"
- User asks: "What work was done on this file?"
- User asks: "Show me the history of src/services/worker.ts"
- Looking for all observations that reference a file

## Command

```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=src/services/worker-service.ts&format=index&limit=10"
```

## Parameters

- **filePath** (required): File path to search for (supports partial matching)
  - Full path: `src/services/worker-service.ts`
  - Partial path: `worker-service.ts`
  - Directory: `src/hooks/`
- **format**: "index" (summary) or "full" (complete details). Default: "full"
- **limit**: Number of results (default: 20, max: 100)
- **project**: Filter by project name (optional)
- **dateStart/dateEnd**: Filter by date range (optional)

## When to Use Each Format

**Use format=index for:**
- Quick overviews of work on a file
- Finding IDs for deeper investigation
- Listing multiple changes
- **Token cost: ~50-100 per result**

**Use format=full for:**
- Complete details including narrative, facts, files, concepts
- Understanding the full context of specific changes
- **Token cost: ~500-1000 per result**

## Example Response (format=index)

```json
{
  "filePath": "src/services/worker-service.ts",
  "count": 8,
  "format": "index",
  "results": [
    {
      "id": 1245,
      "type": "refactor",
      "title": "Simplified worker health check logic",
      "subtitle": "Removed redundant PM2 status check",
      "created_at_epoch": 1699564800000,
      "project": "claude-mem",
      "files": ["src/services/worker-service.ts", "src/services/worker-utils.ts"]
    }
  ]
}
```

## How to Present Results

For format=index, present as a compact list:

```markdown
Found 8 observations related to "src/services/worker-service.ts":

🔄 **#1245** Simplified worker health check logic
   > Removed redundant PM2 status check
   > Nov 9, 2024 • claude-mem
   > Files: worker-service.ts, worker-utils.ts

🟣 **#1246** Added SSE endpoint for real-time updates
   > Implemented Server-Sent Events for viewer UI
   > Nov 8, 2024 • claude-mem
   > Files: worker-service.ts
```

For complete formatting guidelines, see [formatting.md](formatting.md).

## Partial Path Matching

The file path parameter supports partial matching:

```bash
# These all match "src/services/worker-service.ts"
curl -s "http://localhost:37777/api/search/by-file?filePath=worker-service.ts&format=index"
curl -s "http://localhost:37777/api/search/by-file?filePath=services/worker&format=index"
curl -s "http://localhost:37777/api/search/by-file?filePath=worker-service&format=index"
```

## Directory Searches

Search for all work in a directory:

```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=src/hooks/&format=index&limit=20"
```

## Error Handling

**Missing filePath parameter:**
```json
{"error": "Missing required parameter: filePath"}
```
Fix: Add the filePath parameter

**No results found:**
```json
{"filePath": "nonexistent.ts", "count": 0, "results": []}
```
Response: "No observations found for 'nonexistent.ts'. Try a partial path or check the spelling."

## Tips

1. Use format=index first to see overview of all changes
2. Start with partial paths (e.g., filename only) for broader matches
3. Use full paths when you need specific file matches
4. Combine with dateStart to see recent changes: `?filePath=worker.ts&dateStart=2024-11-01`
5. Use directory searches to see all work in a module

**Token Efficiency:**
- Start with format=index (~50-100 tokens per result)
- Use format=full only for relevant items (~500-1000 tokens per result)
- See [../principles/progressive-disclosure.md](../principles/progressive-disclosure.md)
