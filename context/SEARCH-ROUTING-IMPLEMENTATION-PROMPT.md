# Implementation Prompt: Route HTTP Through MCP Server

## Task

Refactor HTTP search endpoints in `src/services/worker-service.ts` to route through MCP search server instead of calling `SessionSearch` directly.

**Why:** MCP server has hybrid Chroma + FTS5 search. HTTP only has FTS5. Single source of truth.

---

## Changes Needed

### 1. Add Imports

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
```

### 2. Add MCP Client Property

```typescript
export class WorkerService {
  private mcpClient: Client;
  // ... existing properties
}
```

### 3. Initialize in Constructor

```typescript
constructor() {
  // ... existing initialization

  this.mcpClient = new Client({
    name: 'worker-search-proxy',
    version: '1.0.0'
  }, { capabilities: {} });
}
```

### 4. Connect in start()

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
  // ... rest of existing start logic
}
```

### 5. Update All 10 HTTP Handlers

**Pattern (use for all):**

```typescript
// BEFORE:
private handleSearchObservations(req: Request, res: Response): void {
  const sessionSearch = this.dbManager.getSessionSearch();
  const results = sessionSearch.searchObservations(query, params);
  res.json(results);
}

// AFTER:
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

**HTTP → MCP Tool Mapping:**

| Handler | MCP Tool Name |
|---------|---------------|
| `handleSearchObservations` | `search_observations` |
| `handleSearchSessions` | `search_sessions` |
| `handleSearchPrompts` | `search_user_prompts` |
| `handleSearchByConcept` | `find_by_concept` |
| `handleSearchByFile` | `find_by_file` |
| `handleSearchByType` | `find_by_type` |
| `handleGetRecentContext` | `get_recent_context` |
| `handleGetContextTimeline` | `get_context_timeline` |
| `handleGetTimelineByQuery` | `get_timeline_by_query` |

---

## Build & Test

```bash
npm run build
npm run sync-marketplace
npm run worker:restart

# Check logs
npm run worker:logs  # Should see "Connected to MCP search server"

# Test endpoint
curl "http://localhost:37777/api/search/observations?query=test&format=index&limit=5"
```

---

## Notes

- Make handlers `async`
- MCP returns `{ content: [...] }`, just send that directly
- Keep error handling simple
- No need for conversion layers - MCP SDK handles it

Done.
