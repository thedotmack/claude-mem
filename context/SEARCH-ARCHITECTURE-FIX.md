# Search Architecture Fix: HTTP → MCP Routing

**Date:** 2025-11-11
**Status:** NEEDS IMPLEMENTATION
**Priority:** HIGH

---

## The Problem

HTTP endpoints call `SessionSearch` directly (FTS5 only).
MCP server has hybrid Chroma + FTS5 search.

**Current:**
```
HTTP → SessionSearch (FTS5 only)
MCP  → Chroma + SessionSearch (hybrid)
```

**Should be:**
```
HTTP → MCP server → Chroma + SessionSearch (hybrid)
MCP  → MCP server → Chroma + SessionSearch (hybrid)
```

**Why:** Single source of truth. HTTP gets hybrid search automatically.

---

## The Fix

### 1. Add MCP Client to WorkerService

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class WorkerService {
  private mcpClient: Client;

  constructor() {
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: '1.0.0'
    }, { capabilities: {} });
  }
}
```

### 2. Connect on Start

```typescript
async start(): Promise<void> {
  await this.dbManager.initialize();

  // Connect to MCP search server
  const searchServerPath = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'search-server.mjs');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [searchServerPath],
    env: process.env
  });

  await this.mcpClient.connect(transport);
  logger.success('WORKER', 'Connected to MCP search server');

  const port = getWorkerPort();
  // ... rest of start
}
```

### 3. Update HTTP Handlers

**Example - handleSearchObservations:**

```typescript
private async handleSearchObservations(req: Request, res: Response): Promise<void> {
  try {
    const result = await this.mcpClient.callTool({
      name: 'search_observations',
      arguments: req.query
    });

    res.json(result.content);
  } catch (error) {
    logger.failure('WORKER', 'Search failed', {}, error as Error);
    res.status(500).json({ error: (error as Error).message });
  }
}
```

**Apply same pattern to all 10 handlers:**
- `handleSearchSessions` → `search_sessions`
- `handleSearchPrompts` → `search_user_prompts`
- `handleSearchByConcept` → `find_by_concept`
- `handleSearchByFile` → `find_by_file`
- `handleSearchByType` → `find_by_type`
- `handleGetRecentContext` → `get_recent_context`
- `handleGetContextTimeline` → `get_context_timeline`
- `handleGetTimelineByQuery` → `get_timeline_by_query`

---

## Testing

```bash
npm run build
npm run sync-marketplace
npm run worker:restart
npm run worker:logs  # Check for "Connected to MCP search server"

# Test endpoint
curl "http://localhost:37777/api/search/observations?query=test&format=index&limit=5"
```

---

## Files to Modify

**src/services/worker-service.ts:**
- Add imports
- Add `mcpClient` property
- Initialize in constructor
- Connect in `start()`
- Update 10 handler methods to route via MCP

That's it.
