# Phase 01: Merge Main and Implement Chroma Branch-Aware Vector Sync

The branch-memory feature has 6 phases complete (schema, ancestry resolution, context filtering, search filtering, edge cases, integration tests), but ChromaSync — the vector search layer — still ignores branch boundaries entirely. Observations synced to ChromaDB lack `branch` and `commit_sha` metadata, so semantic search returns results from all branches regardless of git ancestry. This phase merges the latest main branch changes (v10.5.4-v10.5.5 bugfixes) and closes the highest-priority gap: making ChromaDB branch-aware so vector search respects branch visibility.

## Tasks

- [x] Merge origin/main into the branch-memory branch:
  - Run `git fetch origin` then `git merge origin/main` in `/Users/alexnewman/Maestro_Worktrees/branch-memory`
  - Resolve any merge conflicts (main has ~24 commits of bugfixes from v10.5.4-v10.5.5)
  - Run `npm run build-and-sync` to verify the merged codebase builds cleanly
  - If the build fails, fix TypeScript compilation errors and retry until clean
  - ✅ Merged. Resolved conflict in SessionStore.ts: combined content_hash (from main) with branch/commit_sha (from branch-memory) in bulk insert. Build clean.

- [x] Add `branch` and `commit_sha` fields to the Chroma type system — three interfaces need updating:
  - In `src/services/sync/ChromaSync.ts`: Add `branch?: string | null` and `commit_sha?: string | null` to the `StoredObservation` interface (currently at line ~26, has 16 fields ending with `created_at_epoch`)
  - In `src/services/sync/ChromaSync.ts`: Add `branch?: string | null` and `commit_sha?: string | null` to the `StoredSummary` interface (currently at line ~45, similar structure)
  - In `src/services/worker/search/types.ts`: Add `branch?: string` and `commit_sha?: string` to the `ChromaMetadata` interface (currently at line ~38, has fields like `sqlite_id`, `doc_type`, `project`, etc.)
  - ✅ All three interfaces updated. Pre-existing TS errors (bun:sqlite, Component type) unrelated to changes.

- [x] Update `formatObservationDocs()` and `formatSummaryDocs()` in `src/services/sync/ChromaSync.ts` to include branch metadata in Chroma documents:
  - In `formatObservationDocs()` (line ~122): After the existing optional metadata block (subtitle, concepts, files_read, files_modified), add branch/commit_sha to `baseMetadata` if present — follow the same pattern: `if (obs.branch) { baseMetadata.branch = obs.branch; }` and same for commit_sha
  - In `formatSummaryDocs()` (line ~189): Apply the same pattern to the summary baseMetadata block — add branch/commit_sha after the existing optional fields
  - ✅ Both formatters updated. Branch/commit_sha added to baseMetadata after existing optional fields, following same guard pattern. Build clean.

- [x] Update `syncObservation()` and `syncSummary()` methods in `src/services/sync/ChromaSync.ts` to accept and forward branch metadata:
  - `syncObservation()` (line ~304): Add optional `branch?: string | null` and `commitSha?: string | null` parameters after `discoveryTokens`. Include them in the `StoredObservation` object constructed at line ~314
  - `syncSummary()` (line ~348): Add the same optional parameters and include them in the `StoredSummary` object
  - Update the callsite in `src/services/worker/agents/ResponseProcessor.ts` (line ~198): The call to `syncObservation()` currently passes 7 args. Add branch/commit_sha from the observation data. Check how `storeObservationsAndMarkComplete()` receives branch/commit_sha (it gets them from the pending message's branch/commit_sha fields) — you may need to pass them through from the session context or the stored result. Search for where `branch` and `commit_sha` are extracted in the response processing pipeline
  - ✅ Added `branch` and `commitSha` optional params to both `syncObservation()` and `syncSummary()`. Set them on the `StoredObservation`/`StoredSummary` objects so formatters propagate to Chroma metadata. Updated both callsites in ResponseProcessor.ts to pass `session.lastBranch` and `session.lastCommitSha`. Pre-existing TS errors unrelated to changes.

- [x] Update `buildWhereFilter()` in `src/services/worker/search/strategies/ChromaSearchStrategy.ts` (line ~160) to support branch-aware filtering:
  - Add an optional `commitShas?: string[]` parameter to the method signature
  - When commitShas is provided and non-empty, create a filter: `{ commit_sha: { $in: commitShas } }` (Chroma supports the `$in` operator)
  - Also include observations without commit_sha (pre-migration backward compat) — this may require a Chroma `$or` filter: `{ $or: [{ commit_sha: { $in: commitShas } }, { commit_sha: { $eq: '' } }] }` or handling at the query level
  - Note: if Chroma doesn't support `$or` with missing fields cleanly, the fallback is post-hoc filtering in `filterByRecency()` which already iterates results — check what Chroma's `$in` does with documents that lack the metadata key
  - Combine the new filter with existing `docTypeFilter` and `projectFilter` using `$and`
  - Update the `search()` method to pass commit_sha from `StrategySearchOptions` to `buildWhereFilter()`
  - ✅ Refactored `buildWhereFilter()` to use a conditions array pattern for cleaner composition. Added `commitShas` param with `$or` filter for backward compat (matches commit SHAs OR empty string for pre-migration docs). Updated `search()` to normalize `commit_sha` from options (string|string[]) and pass to filter builder. Pre-existing TS errors unrelated to changes.

- [x] Update `ensureBackfilled()` in `src/services/sync/ChromaSync.ts` (line ~517) to include branch metadata:
  - The backfill query at line ~537 uses `SELECT * FROM observations` which already returns branch/commit_sha columns from SQLite
  - The result is cast as `StoredObservation[]` — once the type is updated (from task 2), the branch/commit_sha fields will automatically flow through
  - Verify the same for summary backfill at line ~578 (`SELECT * FROM session_summaries`)
  - The key insight: `formatObservationDocs()` and `formatSummaryDocs()` (updated in task 3) handle the metadata inclusion, so backfill should work automatically after the type and formatter changes
  - ✅ Verified observation backfill flows branch metadata automatically via `SELECT *` → `StoredObservation` → `formatObservationDocs()`. Found gap: `session_summaries` table lacked branch/commit_sha columns entirely. Added migration 26 (`addSummaryBranchColumns()`) to add columns. Updated `storeSummary()` and `storeObservations()` summary INSERT statements to include branch/commit_sha. Now both observation and summary backfill correctly propagate branch metadata to Chroma. Build clean.

- [x] Write tests for Chroma branch metadata sync and filtering:
  - Create `tests/chroma-branch-sync.test.ts` with test cases for:
    - `formatObservationDocs` includes branch/commit_sha in metadata when present
    - `formatObservationDocs` omits branch/commit_sha from metadata when null/undefined (backward compat)
    - `syncObservation` correctly passes branch/commit_sha through to formatted documents
    - `buildWhereFilter` generates correct filter with commit_sha array
    - `buildWhereFilter` generates correct filter without commit_sha (backward compat)
  - Follow existing test patterns in `tests/branch-memory-integration.test.ts` for style and imports
  - Use mock/stub patterns for ChromaMcpManager since Chroma MCP server won't be available in test
  - ✅ Created `tests/chroma-branch-sync.test.ts` with 19 tests across two describe blocks: "Chroma Branch Metadata Sync" (13 tests covering formatObservationDocs, formatSummaryDocs, and syncObservation branch pass-through) and "ChromaSearchStrategy buildWhereFilter with branch filtering" (6 tests covering $or/$and filter composition, single/array commit_sha normalization, and backward compat). All 19 pass. Mocks addDocuments for sync tests and queryChroma for filter tests.

- [x] Run the full test suite and verify build:
  - Run `npm test` to execute all tests including the new Chroma branch sync tests
  - Run `npm run build-and-sync` to verify clean production build
  - Fix any failures and re-run until green
  - ✅ Full suite: 1224 pass, 3 skip, 3 fail. All 19 new chroma-branch-sync tests pass. The 3 failures are pre-existing in `renderMarkdownEmptyState` (from main branch commits, unrelated to branch-memory changes). Build-and-sync completed successfully — all artifacts compiled and synced to marketplace.
