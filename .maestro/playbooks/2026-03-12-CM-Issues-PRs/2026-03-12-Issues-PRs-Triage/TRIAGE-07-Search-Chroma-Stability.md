# Phase 07: Medium — Search & Chroma Stability

Search is claude-mem's primary user-facing feature. These bugs cause MCP search to return 500 errors or fail to connect to Chroma entirely, degrading the core value proposition. The fixes are in the search orchestration and Chroma connection layers.

**Issues addressed:** #1263, #1261, #1232, #1266
**Prerequisite:** Phases 01-06 should be complete (especially Phase 06's Windows Chroma fix and Phase 02's Chroma CPU fix).

## Tasks

- [ ] Fix MCP search Worker API 500 errors (#1263). The search MCP tool returns HTTP 500 from the worker API, which surfaces as an opaque error to users:
  - Read the search route handler — search for `SearchRoutes` in `src/services/worker/http/routes/`
  - Read `src/services/search/SearchManager.ts` or equivalent to find the search orchestration logic
  - The 500 likely comes from an unhandled exception in the search pipeline. Add structured error handling to the search route:
    1. Wrap the search handler in try/catch
    2. On Chroma errors, fall back to SQLite-only search (search for existing `chromaSync === null` handling)
    3. On SQLite errors, return a meaningful error message with HTTP 503 (not 500)
    4. Log the actual error with full stack trace at ERROR level
  - Check if the error is specifically a Chroma collection error — if so, the fix from Phase 06 (#1225 readiness poll) may resolve this. If the Chroma client disconnects mid-query, add reconnect logic in `ChromaMcpManager.callTool()`

- [ ] Fix Chroma "Collection setup failed" on cacheDir initialization (#1261, #1232). Users report Chroma failing to connect with collection setup errors. These are likely caused by the Chroma MCP subprocess dying or not starting:
  - Read `src/services/sync/ChromaMcpManager.ts` — find the collection creation/verification path
  - Search for `collection`, `setup`, `cacheDir` to find where the error originates
  - The fix should ensure resilient Chroma initialization:
    1. If collection doesn't exist, create it (idempotent)
    2. If creation fails, retry once after a 2-second delay
    3. If retry fails, mark Chroma as unavailable (`this.connected = false`) and log the error — SQLite search remains functional
  - Also check if the cacheDir issue is related to Chroma's data directory not existing. In `ChromaMcpManager.ts`, ensure the data directory is created with `mkdirSync(path, { recursive: true })` before starting chroma-mcp
  - Search for existing directory creation patterns in the codebase

- [ ] Fix MCP connection loss while worker appears healthy (#1266). Users report MCP tools stop working even though `localhost:37777` responds to health checks:
  - Search for MCP client initialization in `src/services/worker-service.ts` — find where the MCP server is set up and how tools are registered
  - The issue may be that the MCP client connection drops but isn't detected because health checks only verify the HTTP server, not the MCP layer
  - The fix: add MCP health verification to the `/api/health` endpoint — include `mcpConnected: true/false` in the health response
  - In the MCP tool handlers, if the worker's internal state shows Chroma disconnected, attempt auto-reconnect before returning an error
  - Check if `src/services/worker/http/routes/` has a health route that can be extended

- [ ] Run tests and verify search functionality:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - Verify search works end-to-end: `curl 'http://localhost:37777/api/search?q=test&limit=5'` should return results (adjust endpoint path based on actual route)
