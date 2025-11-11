# Search Architecture Analysis

**Date:** 2025-11-11 **Scope:** HTTP API endpoints, MCP search server, DRY violations, architectural recommendations

---

## Current State: Dual Search Architectures

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Claude Code Session                        │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  mem-search Skill (ACTIVE)                         │    │
│  │  - Uses HTTP API via curl commands                 │    │
│  │  - 10 search operations                            │    │
│  │  - Progressive disclosure workflow                 │    │
│  └────────────────────────────────────────────────────┘    │
│                            │                                │
│                            │ HTTP GET                       │
│                            ▼                                │
│  ┌────────────────────────────────────────────────────┐    │
│  │  MCP Search Server (DEPRECATED but BUILT)          │    │
│  │  - .mcp.json configured                            │    │
│  │  - search-server.mjs exists (74KB)                 │    │
│  │  - 9 MCP tools defined                             │    │
│  │  - Not used by skill                               │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  Worker Service          │  │  MCP Server              │
│  (worker-service.ts)     │  │  (search-server.ts)      │
│                          │  │                          │
│  10 HTTP Endpoints:      │  │  9 MCP Tools:            │
│  ├─ /api/search/         │  │  ├─ search_observations  │
│  │  observations         │  │  ├─ search_sessions      │
│  ├─ /api/search/         │  │  ├─ search_user_prompts  │
│  │  sessions             │  │  ├─ find_by_concept      │
│  ├─ /api/search/         │  │  ├─ find_by_file         │
│  │  prompts              │  │  ├─ find_by_type         │
│  ├─ /api/search/         │  │  ├─ get_recent_context   │
│  │  by-concept           │  │  ├─ get_context_timeline │
│  ├─ /api/search/         │  │  └─ get_timeline_by_query│
│  │  by-file              │  │                          │
│  ├─ /api/search/         │  │  Built: ✅               │
│  │  by-type              │  │  Used: ❌                │
│  ├─ /api/context/recent  │  │  Configured: ✅          │
│  ├─ /api/context/        │  │  Status: DEPRECATED      │
│  │  timeline             │  │                          │
│  ├─ /api/timeline/       │  │                          │
│  │  by-query             │  │                          │
│  └─ /api/search/help     │  │                          │
│                          │  │                          │
│  Built: ✅               │  │                          │
│  Used: ✅               │  │                          │
│  Status: ACTIVE          │  │                          │
└──────────────────────────┘  └──────────────────────────┘
                │                           │
                └─────────┬─────────────────┘
                          ▼
        ┌────────────────────────────────┐
        │  SessionSearch (Shared Layer)  │
        │  - FTS5 queries                │
        │  - SQLite operations           │
        │  - Common data access          │
        └────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────┐
        │  SQLite Database               │
        │  ~/.claude-mem/claude-mem.db   │
        └────────────────────────────────┘
```

---

## HTTP Endpoints Architecture

### Location

`src/services/worker-service.ts` (lines 108-118, 748-1174)

### Endpoints (10 total)

| Endpoint                   | Method | Purpose                             | Used By          |
| -------------------------- | ------ | ----------------------------------- | ---------------- |
| `/api/search/observations` | GET    | Full-text search observations       | mem-search skill |
| `/api/search/sessions`     | GET    | Full-text search session summaries  | mem-search skill |
| `/api/search/prompts`      | GET    | Full-text search user prompts       | mem-search skill |
| `/api/search/by-concept`   | GET    | Find observations by concept tag    | mem-search skill |
| `/api/search/by-file`      | GET    | Find work related to specific files | mem-search skill |
| `/api/search/by-type`      | GET    | Find observations by type           | mem-search skill |
| `/api/context/recent`      | GET    | Get recent session context          | mem-search skill |
| `/api/context/timeline`    | GET    | Get timeline around point in time   | mem-search skill |
| `/api/timeline/by-query`   | GET    | Search + timeline in one call       | mem-search skill |
| `/api/search/help`         | GET    | API documentation                   | mem-search skill |

### Implementation Pattern

**Example: Search Observations**

```typescript
// src/services/worker-service.ts:748-781
private handleSearchObservations(req: Request, res: Response): void {
  try {
    // 1. Parse query parameters
    const query = req.query.query as string;
    const format = (req.query.format as string) || 'full';
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const project = req.query.project as string | undefined;

    // 2. Validate required parameters
    if (!query) {
      res.status(400).json({ error: 'Missing required parameter: query' });
      return;
    }

    // 3. Call SessionSearch (shared data layer)
    const sessionSearch = this.dbManager.getSessionSearch();
    const results = sessionSearch.searchObservations(query, { limit, project });

    // 4. Format response based on format parameter
    res.json({
      query,
      count: results.length,
      format,
      results: format === 'index' ? results.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        subtitle: r.subtitle,
        created_at_epoch: r.created_at_epoch,
        project: r.project,
        score: r.score
      })) : results
    });
  } catch (error) {
    logger.failure('WORKER', 'Search observations failed', {}, error as Error);
    res.status(500).json({ error: (error as Error).message });
  }
}
```

### Characteristics

**Pros:**

- ✅ Simple HTTP GET requests (curl-friendly)
- ✅ Standard REST API pattern
- ✅ Easy to test and debug
- ✅ No MCP protocol overhead
- ✅ Works with any HTTP client

**Cons:**

- ⚠️ Parameter parsing duplicated across 10 endpoints
- ⚠️ Format conversion logic duplicated
- ⚠️ Error handling pattern repeated

---

## MCP Search Server Architecture

### Location

`src/servers/search-server.ts` (1,781 lines)

### Status

- **Built:** ✅ Yes (`plugin/scripts/search-server.mjs`, 74KB)
- **Configured:** ✅ Yes (`.mcp.json` line 3-6)
- **Used:** ❌ No (deprecated in v5.4.0)
- **Maintained:** ⚠️ Source kept for reference

### Tools (9 total)

| Tool Name               | Purpose                                | Line     |
| ----------------------- | -------------------------------------- | -------- |
| `search_observations`   | Search observations with FTS5 + Chroma | 348-422  |
| `search_sessions`       | Search session summaries               | 438-490  |
| `search_user_prompts`   | Search user prompts                    | 506-558  |
| `find_by_concept`       | Find by concept tag                    | 574-626  |
| `find_by_file`          | Find by file path                      | 642-694  |
| `find_by_type`          | Find by observation type               | 710-762  |
| `get_recent_context`    | Get recent sessions                    | 778-830  |
| `get_context_timeline`  | Get timeline context                   | 846-950  |
| `get_timeline_by_query` | Search + timeline                      | 966-1064 |

### Implementation Pattern

**Example: Search Observations (MCP)**

```typescript
// src/servers/search-server.ts:348-422
{
  name: 'search_observations',
  description: 'Search observations using full-text search across titles, narratives, facts, and concepts...',
  inputSchema: z.object({
    query: z.string().describe('Search query for FTS5 full-text search'),
    format: z.enum(['index', 'full']).default('index').describe('...'),
    ...filterSchema.shape
  }),
  handler: async (args: any) => {
    try {
      const { query, format = 'index', ...options } = args;
      let results: ObservationSearchResult[] = [];

      // Hybrid search: Try Chroma semantic search first, fall back to FTS5
      if (chromaClient) {
        try {
          // Step 1: Chroma semantic search (top 100)
          const chromaResults = await queryChroma(query, 100);

          if (chromaResults.ids.length > 0) {
            // Step 2: Filter by recency (90 days)
            const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
            const recentIds = chromaResults.ids.filter((_id, idx) => {
              const meta = chromaResults.metadatas[idx];
              return meta && meta.created_at_epoch > ninetyDaysAgo;
            });

            // Step 3: Hydrate from SQLite
            if (recentIds.length > 0) {
              const limit = options.limit || 20;
              results = store.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit });
            }
          }
        } catch (chromaError: any) {
          console.error('[search-server] Chroma query failed, falling back to FTS5:', chromaError.message);
        }
      }

      // Fall back to FTS5 if Chroma unavailable or returned no results
      if (results.length === 0) {
        results = search.searchObservations(query, options);
      }

      // Format results
      if (format === 'index') {
        return {
          content: [{
            type: 'text',
            text: results.map((r, i) => formatObservationIndex(r, i)).join('\n\n') + formatSearchTips()
          }]
        };
      } else {
        return {
          content: results.map(r => ({
            type: 'resource',
            resource: {
              uri: `claude-mem://observation/${r.id}`,
              mimeType: 'text/markdown',
              text: formatObservationResult(r)
            }
          }))
        };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  }
}
```

### Characteristics

**Pros:**

- ✅ MCP protocol support
- ✅ Hybrid search (Chroma + FTS5)
- ✅ Rich formatting (markdown, resources)
- ✅ Comprehensive error handling

**Cons:**

- ❌ Not used by skill (deprecated)
- ❌ ~2,500 token overhead for tool definitions
- ❌ More complex than HTTP
- ❌ Still being built despite deprecation

---

## DRY Violation Analysis

### Areas of Duplication

#### 1. **Parameter Parsing** (10 HTTP endpoints + 9 MCP tools)

**HTTP Endpoints:**

```typescript
// Repeated in each endpoint handler
const query = req.query.query as string;
const format = (req.query.format as string) || "full";
const limit = parseInt(req.query.limit as string, 10) || 20;
const project = req.query.project as string | undefined;

if (!query) {
  res.status(400).json({ error: "Missing required parameter: query" });
  return;
}
```

**MCP Tools:**

```typescript
// Repeated in each tool handler
const { query, format = "index", ...options } = args;
if (!query) {
  throw new Error("Missing required parameter: query");
}
```

**Violation:** Parameter parsing logic duplicated 19 times (10 + 9)

#### 2. **Format Conversion** (Index vs Full)

**HTTP Endpoints:**

```typescript
results: format === "index"
  ? results.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      subtitle: r.subtitle,
      created_at_epoch: r.created_at_epoch,
      project: r.project,
      score: r.score,
    }))
  : results;
```

**MCP Tools:**

```typescript
if (format === "index") {
  return {
    content: [
      {
        type: "text",
        text: results.map((r, i) => formatObservationIndex(r, i)).join("\n\n"),
      },
    ],
  };
} else {
  return {
    content: results.map((r) => ({
      type: "resource",
      resource: {
        uri: `claude-mem://observation/${r.id}`,
        mimeType: "text/markdown",
        text: formatObservationResult(r),
      },
    })),
  };
}
```

**Violation:** Format conversion logic duplicated with different output formats

#### 3. **Search Logic Duplication**

**HTTP Endpoints:**

```typescript
const sessionSearch = this.dbManager.getSessionSearch();
const results = sessionSearch.searchObservations(query, { limit, project });
```

**MCP Tools:**

```typescript
// Hybrid search with Chroma fallback
if (chromaClient) {
  const chromaResults = await queryChroma(query, 100);
  // ... complex hybrid logic ...
}
if (results.length === 0) {
  results = search.searchObservations(query, options);
}
```

**Violation:** MCP has hybrid Chroma+FTS5 search, HTTP only has FTS5

#### 4. **Error Handling**

**HTTP Endpoints:**

```typescript
try {
  // ... handler logic ...
} catch (error) {
  logger.failure("WORKER", "Search observations failed", {}, error as Error);
  res.status(500).json({ error: (error as Error).message });
}
```

**MCP Tools:**

```typescript
try {
  // ... handler logic ...
} catch (error: any) {
  return { content: [{ type: "text", text: `Error: ${error.message}` }] };
}
```

**Violation:** Different error handling patterns

### DRY Compliance at Data Layer ✅

**Good news:** Both architectures use the **same data layer**:

```
HTTP Endpoints → SessionSearch → SQLite
MCP Tools      → SessionSearch → SQLite
```

The `SessionSearch` class is the **single source of truth** for data access. No duplication there.

---

## Is curl the Best Approach?

### Current Approach: curl Commands

**Example from skill:**

```bash
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"
```

### Alternative Approaches

#### 1. **MCP Tools** (Deprecated)

**Pros:**

- Native Claude Code protocol
- Rich type definitions
- Better error handling
- Resource formatting

**Cons:**

- ❌ ~2,500 token overhead per session
- ❌ More complex to implement
- ❌ Requires MCP server process
- ❌ Less accessible for external tools

**Verdict:** MCP was deprecated for good reasons (token overhead). curl is better.

#### 2. **Direct Database Access** (Not feasible)

**Pros:**

- No HTTP overhead
- No worker process needed

**Cons:**

- ❌ Skills can't access files directly
- ❌ No way to execute TypeScript/SQLite from skill
- ❌ Would require building native bindings

**Verdict:** Not possible with current skill architecture.

#### 3. **HTTP API via curl** (Current) ✅

**Pros:**

- ✅ Simple, standard protocol
- ✅ Works with skill architecture
- ✅ Easy to test (curl in terminal)

- ✅ Language-agnostic
- ✅ No MCP token overhead
- ✅ RESTful design

**Cons:**

- ⚠️ Requires worker service running
- ⚠️ HTTP parsing overhead (minimal)

**Verdict:** **Best approach given constraints.**

### Why curl is Optimal

1. **Skill Constraints:** Skills can only execute shell commands. curl is the standard HTTP client.
2. **Token Efficiency:** No tool definitions loaded into context (~2,250 token savings).
3. **Progressive Disclosure:** Skill loads gradually, HTTP requests are made only when needed.

4. **Debuggability:** Easy to test endpoints manually with curl.
5. **Cross-platform:** curl available on all platforms.

---

### Question: "Is it routing into the search-service MCP file or is it a DRY violation?"

**Answer:** Both architectures exist, creating a DRY violation:

1. **HTTP Endpoints** (worker-service.ts) ← **Used by skill**
2. **MCP Server** (search-server.ts) ← **Deprecated but still built**

### Current State

```
mem-search skill → HTTP API (worker-service.ts) → SessionSearch → SQLite
                                                                      ↑
MCP search server (deprecated) → SessionSearch ──────────────────────┘
```

Both use the same data layer (SessionSearch), but:

- ❌ Parameter parsing duplicated
- ❌ Format conversion duplicated
- ❌ MCP has hybrid Chroma search, HTTP doesn't
- ❌ MCP still being built despite deprecation

**You said:** "We are intentionally exposing API search endpoints

```
┌─────────────────────────────────────────────────────────────┐

│  - Web UI                                                    │
│  - Mobile app                                                │
│  - VS Code extension                                         │
│  - CLI tools                                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP API
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Worker Service HTTP API                         │
│              localhost:37777/api/search/*                    │
│                                                              │
│  - Standard REST endpoints                                   │
│  - JSON responses                                            │
│  - Query parameter API                                       │
│  - format=index/full support                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              SessionSearch + ChromaSync                      │
│              (Shared data layer)                             │
└─────────────────────────────────────────────────────────────┘
```

- Standard REST API
- Easy to consume from any language/platform
- Already supports format=index/full for token efficiency
- Well-documented in skill operation guides
- Clean JSON responses

---

## Architectural Recommendations

### Immediate Actions

#### 1. **Remove MCP Search Server** (Reduce Maintenance Burden)

**Problem:**

- MCP server is deprecated but still being built
- Adds 1,781 lines of maintenance burden
- Creates confusion about which search to use
- DRY violation with HTTP endpoints

**Recommendation:**

```bash
# Remove from build pipeline
# scripts/build-hooks.js - already commented out, make permanent

# Delete configuration
rm plugin/.mcp.json

# Archive source (don't delete, keep for reference)
git mv src/servers/search-server.ts archive/search-server.ts.archived

# Remove built file
rm plugin/scripts/search-server.mjs
```

**Impact:**

- ✅ Reduces build time
- ✅ Eliminates confusion
- ✅ Reduces maintenance burden
- ✅ Removes DRY violation
- ⚠️ Loses hybrid Chroma search in MCP (but HTTP doesn't have it anyway)

#### 2. **Add Hybrid Search to HTTP Endpoints** (Feature Parity)

**Problem:** MCP server has Chroma hybrid search, HTTP endpoints don't

**Recommendation:**

```typescript
// src/services/worker-service.ts
private async handleSearchObservations(req: Request, res: Response): Promise<void> {
  try {
    const { query, format, limit, project } = this.parseSearchParams(req);

    // Try hybrid search first if Chroma available
    let results = await this.hybridSearch(query, { limit, project });

    // Fallback to FTS5 if Chroma unavailable
    if (results.length === 0) {
      const sessionSearch = this.dbManager.getSessionSearch();
      results = sessionSearch.searchObservations(query, { limit, project });
    }

    res.json(this.formatSearchResponse(query, results, format));
  } catch (error) {
    this.handleSearchError(res, 'Search observations failed', error);
  }
}

// Extract shared methods
private parseSearchParams(req: Request): SearchParams { /* ... */ }
private async hybridSearch(query: string, options: SearchOptions): Promise<any[]> { /* ... */ }
private formatSearchResponse(query: string, results: any[], format: string): any { /* ... */ }
private handleSearchError(res: Response, message: string, error: any): void { /* ... */ }
```

**Impact:**

- ✅ Adds Chroma semantic search to HTTP API
- ✅ Makes HTTP API feature-complete

#### 3. **Extract Shared Search Logic** (DRY Refactoring)

**Problem:** 10 HTTP endpoints have duplicated parameter parsing and formatting

**Recommendation:**

```typescript
// src/services/search/SearchController.ts (new file)
export class SearchController {
  constructor(private sessionSearch: SessionSearch, private chromaSync: ChromaSync) {}

  async searchObservations(params: SearchParams): Promise<SearchResponse> {
    // Shared logic for observations search
    const results = await this.hybridSearch(params);
    return this.formatResponse(results, params.format);
  }

  async searchSessions(params: SearchParams): Promise<SearchResponse> {
    // Shared logic for sessions search
  }

  // ... other search methods

  private async hybridSearch(params: SearchParams): Promise<any[]> {
    // Shared hybrid search logic
  }

  private formatResponse(results: any[], format: "index" | "full"): SearchResponse {
    // Shared formatting logic
  }

  private parseParams(req: Request): SearchParams {
    // Shared parameter parsing
  }
}
```

**Usage in worker-service.ts:**

```typescript
private searchController: SearchController;

private handleSearchObservations(req: Request, res: Response): void {
  try {
    const params = this.searchController.parseParams(req);
    const response = await this.searchController.searchObservations(params);
    res.json(response);
  } catch (error) {
    this.handleSearchError(res, error);
  }
}
```

**Impact:**

- ✅ Eliminates 90% of duplication across 10 endpoints
- ✅ Single source of truth for search logic
- ✅ Easier to test (test controller, not HTTP layer)
- ✅ Easier to maintain
- ✅ Easier to add new search endpoints

### Long-term Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Clients                                    │
│  ┌──────────────┬──────────────┬──────────────────────┐    │

│  │ Skill        │ Frontend     │ (CLI, IDE plugins)   │    │
│  └──────────────┴──────────────┴──────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP API (REST)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              WorkerService (Express.js)                      │
│                                                              │
│  Route Layer (thin)                                          │
│  ├─ GET /api/search/observations                            │
│  ├─ GET /api/search/sessions                                │
│  └─ ... (delegates to controller)                           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              SearchController (business logic)               │
│                                                              │
│  ├─ searchObservations()                                    │
│  ├─ searchSessions()                                        │
│  ├─ hybridSearch() - Chroma + FTS5                          │
│  ├─ formatResponse() - index/full conversion                │
│  └─ parseParams() - parameter validation                    │
└─────────────────────────────────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  SessionSearch (FTS5)    │  │  ChromaSync (Vectors)    │
│  - searchObservations()  │  │  - queryByEmbedding()    │
│  - searchSessions()      │  │  - 90-day recency filter │
│  - searchPrompts()       │  │  - Hydrate from SQLite   │
└──────────────────────────┘  └──────────────────────────┘
                │                           │
                └─────────┬─────────────────┘
                          ▼
        ┌────────────────────────────────┐
        │  SQLite Database               │
        │  ~/.claude-mem/claude-mem.db   │
        └────────────────────────────────┘
```

---

## Summary

### Current Architecture Issues

1. ❌ **Dual search implementations** (HTTP + deprecated MCP)
2. ❌ **DRY violations** across 19 search handlers
3. ❌ **MCP server still built** despite deprecation
4. ❌ **HTTP missing hybrid Chroma search** (MCP has it)
5. ❌ **No shared controller layer** for search logic

### Is curl the Best Approach?

**Yes.** ✅

Given the constraints:

- Skills can only execute shell commands

- Token efficiency vs MCP (~2,250 token savings)
- Standard REST pattern, easy to consume

curl + HTTP API is the optimal architecture.

### Is it Routing into search-service or DRY Violation?

**DRY violation.** ❌

Both architectures exist and duplicate logic:

- HTTP endpoints (worker-service.ts) ← ACTIVE
- MCP server (search-server.ts) ← DEPRECATED but BUILT

They share the data layer (SessionSearch) but duplicate:

- Parameter parsing
- Format conversion
- Error handling
- Search orchestration (MCP has Chroma, HTTP doesn't)

### Recommendations Priority

**High Priority:**

1. ✅ Remove MCP search server entirely (archive source)
2. ✅ Add hybrid Chroma search to HTTP endpoints
3. ✅ Extract SearchController for shared logic

**Medium Priority:**

5. Add API versioning (/api/v1/search/\*)
6. Add rate limiting for external access

**Low Priority:** 7. OpenAPI/Swagger documentation

9. WebSocket support for real-time search

### Action Plan

**Phase 1: Cleanup (1 day)**

- Remove .mcp.json
- Archive search-server.ts
- Update CLAUDE.md to reflect removal
- Update build scripts to skip MCP server

**Phase 2: Feature Parity (2 days)**

- Port hybrid Chroma search from MCP to HTTP
- Test all 10 endpoints with hybrid search
- Update skill documentation

**Phase 3: DRY Refactoring (3 days)**

- Create SearchController class
- Extract shared logic (parsing, formatting, errors)
- Refactor 10 HTTP handlers to use controller
- Add comprehensive tests

- Document API for external consumption
- Add authentication/authorization (if needed)
- Add rate limiting
- Create OpenAPI spec

---

## Files Referenced

**Active:**

- `src/services/worker-service.ts` - HTTP endpoints (1,338 lines)
- `src/services/sqlite/SessionSearch.ts` - FTS5 search
- `src/services/sync/ChromaSync.ts` - Vector search
- `plugin/skills/mem-search/SKILL.md` - Skill using HTTP API

**Deprecated:**

- `src/servers/search-server.ts` - MCP tools (1,781 lines)
- `plugin/.mcp.json` - MCP configuration
- `plugin/scripts/search-server.mjs` - Built MCP server (74KB)

**Configuration:**

- `CLAUDE.md` line 314 - Deprecation notice
- `CHANGELOG.md` line 32-52 - v5.4.0 migration
- `scripts/build-hooks.js` - Build pipeline (MCP commented out)
