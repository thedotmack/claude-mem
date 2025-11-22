# Unified Search Implementation Plan

## Context

We need to add a unified search endpoint that searches ALL record types (observations, sessions, prompts) in a single query and returns them mixed together, sorted by date.

## Current State ✅

**Architecture is correct and working:**
- mem-search skill → HTTP endpoints in worker → worker routes to search-server MCP → search-server has hybrid Chroma+SQLite logic
- Routes exist: `/api/search/observations`, `/api/search/sessions`, `/api/search/prompts`
- All routes correctly call `this.mcpClient.callTool()` to invoke search-server MCP

**Chroma is working:**
- Logs confirm: `[search-server] Using hybrid semantic search (Chroma + SQLite)`
- Example: Query for "PreToolUse SKIP_TOOLS" returned 63 Chroma matches, hydrated 5 from SQLite
- No fallback to FTS5 needed

## The Gap ❌

**Missing unified search endpoint** that:
- Searches all types (observations, sessions, user_prompts) in ONE query
- Returns mixed results sorted by date_desc
- Uses Chroma semantic search across all doc_types
- Provides index/full format like other endpoints

## Implementation Plan

### 1. Add `search_unified` tool to search-server.ts

**Location:** `src/servers/search-server.ts` (add to `tools` array before line 1694)

**Tool definition:**
```typescript
{
  name: 'search_unified',
  description: 'Search all record types (observations, sessions, user prompts) with a single query. Returns unified results sorted by date. Uses hybrid Chroma semantic + SQLite FTS5 search.',
  inputSchema: z.object({
    query: z.string().describe('Natural language search query'),
    format: z.enum(['index', 'full']).default('index').describe('Output format'),
    project: z.string().optional().describe('Filter by project name'),
    dateRange: z.object({
      start: z.union([z.string(), z.number()]).optional(),
      end: z.union([z.string(), z.number()]).optional()
    }).optional().describe('Filter by date range'),
    limit: z.number().min(1).max(100).default(20).describe('Maximum results per type'),
    offset: z.number().min(0).default(0).describe('Skip results'),
    orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc')
  }),
  handler: async (args: any) => {
    // Implementation below
  }
}
```

**Handler logic:**
1. Query Chroma WITHOUT doc_type filter (gets all types)
2. Parse metadata to group IDs by doc_type: 'observation', 'session_summary', 'user_prompt'
3. Hydrate each type from SQLite using store methods:
   - `store.getObservationsByIds(obsIds, { orderBy, limit })`
   - `store.getSessionSummariesByIds(sessionIds, { orderBy, limit })`
   - `store.getUserPromptsByIds(promptIds, { orderBy, limit })`
4. Combine all results into unified array with type field
5. Sort by created_at_epoch based on orderBy
6. Format as index or full (unified format showing type icons)

**Response format (index):**
```
Found 15 result(s) matching "auth":

🎯 Session #1234 - Implemented JWT authentication (Nov 17, 5:30 PM)
🟣 Observation #5678 - Added login endpoint (Nov 17, 5:45 PM)
💬 User Prompt #42 - "How do we handle auth?" (Nov 17, 6:00 PM)
...
```

### 2. Add HTTP endpoint in worker-service.ts

**Location:** `src/services/worker-service.ts` (add after line 189)

```typescript
this.app.get('/api/search/unified', this.handleSearchUnified.bind(this));
```

**Handler method:** (add after line 1088)
```typescript
/**
 * Unified search across all types
 * GET /api/search/unified?query=...&format=index&limit=20
 */
private async handleSearchUnified(req: Request, res: Response): Promise<void> {
  try {
    const result = await this.mcpClient.callTool({
      name: 'search_unified',
      arguments: req.query
    });
    res.json(result.content);
  } catch (error) {
    logger.failure('WORKER', 'Unified search failed', {}, error as Error);
    res.status(500).json({ error: (error as Error).message });
  }
}
```

### 3. Update mem-search skill documentation (optional)

**Location:** `plugin/skills/mem-search/SKILL.md`

Add to "Available Operations" section:
```markdown
- **unified** - Search all types (observations, sessions, prompts) in one query
  - Use when: "Search everything for X" or general cross-type searches
  - Example: Search for "authentication" across all record types
```

### 4. Build and test

```bash
npm run build
npm run sync-marketplace
npm run worker:restart
```

Test with curl:
```bash
curl "http://localhost:37777/api/search/unified?query=auth&format=index&limit=10"
```

## Additional Enhancements (lower priority)

1. **Add silentDebug logging** to search-server.ts to trace search paths
2. **Fact search support** - if facts become first-class records, include them in unified search
3. **Type filtering** - Add optional `types` parameter to filter which types to search

## Related Work

- Was investigating "endless mode phase 3" (PreToolUse hook, SKIP_TOOLS optimization)
- Discovered search issue during investigation
- Decided to fix search architecture first before continuing endless mode work
