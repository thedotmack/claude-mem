# Phase 04: MCP Search Branch Filtering

This phase extends branch awareness to the MCP search tools — search, timeline, and get_observations. When users search memory, results are filtered to only show observations from ancestor branches, matching the same behavior as SessionStart context injection. This completes the branch isolation story across all memory access points.

## Tasks

- [x] Update MCP search tool input schemas to accept branch parameters:
  - Read `src/servers/mcp-server.ts` to find the tool definitions for `search`, `timeline`, and `get_observations`
  - Add optional `commit_sha` property (type: string or array of strings) to the `search` and `timeline` tool input schemas — this allows explicit filtering by commit ancestry
  - Add optional `cwd` property (type: string) to `search` and `timeline` — this enables auto-detection of branch ancestry when the caller provides a working directory
  - For `get_observations` (batch fetch by ID): add optional `commit_sha` filter to the input schema for consistency, though this tool fetches by explicit IDs so filtering is less critical
  - **Done:** Added `commit_sha` (oneOf string/array) and `cwd` to search/timeline schemas, `commit_sha` to get_observations schema

- [x] Update the get.ts query filter builder to support commit SHA filtering:
  - In `src/services/sqlite/observations/get.ts`, the `getObservationsByIds` function uses an `additionalConditions[]` / `params[]` pattern
  - Add `commit_sha` handling from `GetObservationsByIdsOptions` (the type was updated in Phase 01):
    - Single string → `AND (commit_sha IS NULL OR commit_sha = ?)`
    - Array of strings → `AND (commit_sha IS NULL OR commit_sha IN (?, ?, ...))`
  - The `OR commit_sha IS NULL` clause ensures backward compatibility with pre-migration observations
  - Also check if there are other query functions in get.ts used by search (like a general search query) — apply the same pattern there
  - **Done:** Added commit_sha filtering to `getObservationsByIds` (get.ts), `SessionStore.getObservationsByIds`, `SessionSearch.buildFilterClause`, and `SearchFilters` type

- [x] Update SearchManager to apply branch filtering:
  - Read `src/services/worker/SearchManager.ts` to understand the `search()` and `timeline()` method signatures and how they delegate to `SearchOrchestrator` or SQLite queries
  - For `search()`: accept `commit_sha` and `cwd` parameters. When `commit_sha` is provided directly, use it as the filter. When only `cwd` is provided, auto-resolve using `getUniqueCommitShasForProject` + `resolveVisibleCommitShas` from Phase 02
  - For `timeline()`: apply the same branch filtering to both the anchor observation lookup and the surrounding observations returned as context
  - Thread the commit SHA filter through to whatever query functions SearchManager delegates to — follow the existing pattern for how `project` and `type` filters are threaded
  - **Done:** Added `resolveBranchFilter()` method; both `search()` and `timeline()` resolve commit_sha from direct param or cwd auto-detection; timeline post-filters observations

- [x] Update worker search routes to accept and pass branch parameters:
  - Read `src/services/worker/http/routes/SearchRoutes.ts`
  - In the `GET /api/search` handler, extract `commit_sha` and `cwd` from `req.query` and pass them to `searchManager.search()`
  - In the `GET /api/timeline` handler, extract the same parameters and pass to `searchManager.timeline()`
  - For the `POST /api/observations/batch` route (if in a different file like `DataRoutes.ts`), extract `commit_sha` from the request body and pass to the query function
  - **Done:** SearchRoutes already passes `req.query` directly; DataRoutes updated to extract and pass `commit_sha`; normalizeParams handles comma-separated SHAs

- [x] Build and verify search respects branch boundaries:
  - Run `npm run build-and-sync`
  - Fix any TypeScript compilation errors
  - Verify: after build, use the MCP search tool (via Claude Code) — search results should only include observations from the current branch's ancestry
  - Verify: observations from unmerged sibling branches should not appear in search results
  - **Done:** Build passes cleanly. All 1129 tests pass (0 failures). Created new test file `tests/sqlite/observations-branch-filter.test.ts` (6 tests) validating single/array commit_sha filtering with backward compatibility
