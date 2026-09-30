# Phase 03: MCP Search Output Metadata and End-to-End Verification

MCP search results (used by the `mem-search` skill and `get_observations` tool) filter observations by branch ancestry correctly, but the returned result objects don't include `branch` or `commit_sha` fields. The `ObservationRow` type in `src/services/sqlite/types.ts` — which `ObservationSearchResult` extends — lacks these columns. Since SQLite queries use `SELECT *` or `SELECT o.*`, the data is already present in query results but gets silently dropped by TypeScript's type system. This phase adds the fields to the type, updates the search result formatter to optionally display branch info, and performs end-to-end verification of all three branch-memory gaps.

## Tasks

- [x] Add `branch` and `commit_sha` to the `ObservationRow` interface in `src/services/sqlite/types.ts`:
  - The `ObservationRow` interface (line ~204) currently has 16 fields ending with `created_at_epoch`
  - Add `branch?: string | null` and `commit_sha?: string | null` as optional fields
  - This automatically flows to `ObservationSearchResult` (extends `ObservationRow` at line ~275) and all search result consumers
  - Note: `AllRecentObservationRow` in `src/services/sqlite/observations/types.ts` already has these fields (lines 86-87), so only the main `ObservationRow` needs updating

- [x] Update `ResultFormatter.formatObservationSearchRow()` in `src/services/worker/search/ResultFormatter.ts` to include branch info in the display table:
  - The current table format (line ~150) is: `| ID | Time | T | Title | Read | Work |`
  - The observation row format (line ~170) is: `| ${id} | ${timeDisplay} | ${icon} | ${title} | ~${readTokens} |`
  - The "Work" column already exists in the header but is empty in the row format — this is by design (work tokens shown elsewhere)
  - Add branch info to the Title column rather than adding a new column, to avoid breaking existing table consumers: if `obs.branch` is present and not null, append a short branch indicator, e.g., format title as `${title} (${obs.branch})` or `${title} [${obs.branch.substring(0, 20)}]`
  - Keep it concise — branch names can be long, so truncate to 20 chars with ellipsis if needed
  - When branch is null (pre-migration observations), display title unchanged (backward compat)

- [x] Write tests for MCP output metadata:
  - Create test cases in an appropriate test file (e.g., `tests/mcp-output-metadata.test.ts`) covering:
    - `ObservationSearchResult` objects include branch/commit_sha when present in query results
    - `ResultFormatter.formatObservationSearchRow()` includes branch in title when branch is present
    - `ResultFormatter.formatObservationSearchRow()` displays title unchanged when branch is null
    - Branch name truncation works correctly for long branch names
  - Follow existing test patterns in the codebase for imports and test structure

- [x] Run the complete test suite and perform full build:
  - Run `npm test` — all tests must pass, including:
    - Existing branch-memory integration tests (`tests/branch-memory-integration.test.ts`)
    - Git ancestry tests (`tests/git-ancestry.test.ts`)
    - Branch detection tests (`tests/hook-branch-detection.test.ts`)
    - Context filtering tests (`tests/context/branch-filtering.test.ts`)
    - SQLite filtering tests (`tests/sqlite/observations-branch-filter.test.ts`)
    - New Chroma branch sync tests from Phase 01
    - New MCP output metadata tests from this phase
  - Run `npm run build-and-sync` for complete production build
  - Fix any failures and re-run until fully green

- [x] Verify all three branch-memory gaps are closed by reviewing the changes:
  - **Gap 1 (Chroma)**: Confirm `StoredObservation` has branch/commit_sha, `formatObservationDocs` adds them to metadata, `syncObservation` passes them through, and `buildWhereFilter` can filter by commit_sha
  - **Gap 2 (Viewer)**: Confirm `Observation` type has branch/commit_sha, `PaginationHelper` selects them, and `ObservationCard` renders them
  - **Gap 3 (MCP Output)**: Confirm `ObservationRow` has branch/commit_sha and `ResultFormatter` includes branch in output
  - Run `git diff main...HEAD --stat` to see the complete scope of changes across all phases
