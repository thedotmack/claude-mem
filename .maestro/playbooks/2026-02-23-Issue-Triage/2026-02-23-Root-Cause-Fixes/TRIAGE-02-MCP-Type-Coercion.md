# Phase 02: MCP Type Coercion — Fix get_observations and Search Serialization

The MCP `get_observations` tool fails because the `ids` parameter arrives as a JSON string or comma-separated string instead of a native array. The worker's `handleGetObservationsByIds` handler (DataRoutes.ts line 119) validates `Array.isArray(ids)` which fails when MCP serializes `[1,2,3]` as `"[1,2,3]"`. This is a ~3-line fix per endpoint, not a middleware module.

**Issues resolved:** #1172 (get_observations fails), #1091 (persistent 500 errors)

## Root Cause Validation

**get_observations ids serialization** — CONFIRMED: `DataRoutes.ts` line 116-138 receives `req.body.ids` from POST and immediately checks `Array.isArray(ids)`. The MCP server (`mcp-server.ts` line 233-234) sends the body via `callWorkerAPIPost` which does `JSON.stringify(body)` — so if the MCP SDK sends `ids` as a proper array, JSON round-trip should preserve it. The bug is likely in how specific MCP clients serialize the `arguments` field, sending `ids: "[1,2,3]"` (string) instead of `ids: [1,2,3]` (array).

**Search string-to-array coercion** — ALREADY FIXED: `SearchOrchestrator.normalizeParams()` (line 239-281) already splits comma-separated strings into arrays for concepts, files, obs_type, and type. No additional work needed for search.

## Tasks

- [x] Add type coercion for `ids` in `src/services/worker/http/routes/DataRoutes.ts`:
  - In `handleGetObservationsByIds` (around line 116-117), before the `Array.isArray(ids)` check:
    ```
    let { ids, orderBy, limit, project } = req.body;
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { ids = ids.split(',').map(Number); }
    }
    ```
  - Apply the same pattern to `handleGetSdkSessionsByIds` for `memorySessionIds`
  - Do NOT create a separate utility module or middleware — inline the coercion at the point of use
  - Keep the existing `Array.isArray` and `Number.isInteger` validation after coercion
  - **DONE**: Both handlers now coerce string-encoded arrays before validation. 11 new tests in `tests/worker/http/routes/data-routes-coercion.test.ts` cover JSON strings, comma-separated strings, trimming, and rejection of invalid input.

- [x] Add defensive error handling to the observation POST endpoint:
  - The 500 errors from #1091 may come from unhandled exceptions in the observation storage path
  - Find the POST endpoint that handles observation storage from hooks (search for `/api/sessions` POST handler in the routes)
  - Ensure the handler returns a 200 with `{ stored: false, reason: '...' }` on recoverable errors instead of letting Express return a 500
  - A 500 from the worker should not break the hook — the hook already handles non-ok responses
  - **DONE**: `handleObservationsByClaudeId` in `SessionRoutes.ts` now wraps the storage path in try/catch, returning `{ stored: false, reason: '...' }` on recoverable errors instead of letting `wrapHandler` return a 500.

- [x] Run `npm test` and fix any failures
  - **DONE**: 211 tests pass across 11 worker/server test files (0 failures). Pre-existing failures in integration/chroma-vector-sync and server health endpoint tests are unrelated.
