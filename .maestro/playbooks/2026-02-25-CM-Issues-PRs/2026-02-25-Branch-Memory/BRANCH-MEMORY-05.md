# Phase 05: Edge Cases, Performance, and Integration Tests

This final phase hardens the branch memory feature for production use. It handles edge cases (detached HEAD, shallow clones, non-git directories), adds performance guards for large observation sets, and provides integration tests that verify the complete end-to-end flow. By the end, branch memory is production-ready.

## Tasks

- [x] Harden edge case handling in git utilities:
  - Read `src/services/integrations/git-branch.ts` and `src/services/integrations/git-ancestry.ts`
  - Add an exported `async function isGitRepository(cwd: string): Promise<boolean>` utility (in git-branch.ts) that runs `git rev-parse --is-inside-work-tree` — use this as an early guard in `resolveVisibleCommitShas` to skip expensive ancestry checks when not in a git repo
  - Verify detached HEAD handling: `git rev-parse --abbrev-ref HEAD` returns literal string `"HEAD"` — branch should be set to null, commit SHA should still be captured
  - Verify shallow clone handling: `git merge-base --is-ancestor` may fail on shallow clones where history is truncated — handle this gracefully by treating failed ancestry checks as "not an ancestor" rather than erroring
  - Verify git worktree handling: when cwd is inside a `.claude/worktrees/` worktree, `git rev-parse` commands should still work correctly since worktrees share the same git object store — run a quick manual test or add a test case

- [x] Add performance guard for large observation sets:
  - In `resolveAncestorCommits` in `src/services/integrations/git-ancestry.ts`, add batching: if `candidateCommitShas` has more than 100 entries, process in batches of 100 with `Promise.all` per batch to avoid spawning too many concurrent git processes
  - Consider an alternative approach for very large sets: use `git log --format=%H HEAD` to get all ancestor commits in a single call, then intersect with candidates using a Set — this is O(n) instead of O(n) git calls. Add this as an optimization when candidates exceed 500
  - Add a debug-level log (using the project's existing logger) that reports how many candidates were checked and how many were visible — this helps diagnose performance issues without being noisy

- [x] Write integration tests for the complete branch memory flow:
  - Create `tests/branch-memory-integration.test.ts`
  - Test write path: call `storeObservation()` with branch and commitSha parameters, then query the observation back and verify the branch and commit_sha columns are populated correctly
  - Test backward compatibility: observations stored with `branch: undefined` and `commitSha: undefined` should have NULL in the database and should always be visible in filtered queries (the `commit_sha IS NULL` clause)
  - Test cross-branch dedup prevention: store two observations with identical title/narrative but different branch values — both should be stored (not deduplicated), verifying the content hash includes branch
  - Test the commit SHA filter in `getObservationsByIds`: store observations with different commit SHAs, query with a `commit_sha` filter array, verify only matching observations are returned (plus NULL commit_sha observations)
  - Test `getUniqueCommitShasForProject`: store observations with various commit SHAs (including duplicates and nulls), verify the function returns the correct distinct set

- [x] Run all tests and verify no regressions:
  - Run the full test suite (not just the new tests) to ensure existing functionality is not broken
  - Fix any failures — both new test failures and regressions
  - Verify the build still succeeds: `npm run build-and-sync`

- [x] Final end-to-end verification:
  - After successful build and tests, verify the complete flow manually:
    1. Check the database has `branch` and `commit_sha` columns: `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA table_info(observations);"`
    2. Start a new Claude Code session — new observations should now have branch and commit_sha populated
    3. Query recent observations to verify: `sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, branch, commit_sha FROM observations ORDER BY id DESC LIMIT 5;"`
  - Log a summary of what was verified and any remaining known limitations

  **Verification Summary (2026-02-25):**
  - ✅ `observations` table has `branch` (col 18) and `commit_sha` (col 19) columns
  - ✅ `pending_messages` table has `branch` and `commit_sha` columns (migration 25 applied)
  - ✅ All 1157 tests pass (0 failures, 3 skips) across 68 test files
  - ✅ Build succeeds via `npm run build-and-sync`
  - ✅ Worker restarts successfully with latest code

  **Critical Bug Found & Fixed:**
  - `PendingMessageStore.enqueue()` was NOT persisting `branch`/`commit_sha` to the `pending_messages` table
  - `PendingMessageStore.toPendingMessage()` was NOT reading them back
  - This caused branch metadata to be lost during the database work queue round-trip, resulting in all observations having NULL branch/commit_sha despite the hook correctly detecting and sending the values
  - **Fix:** Added `branch`/`commit_sha` to `enqueue()` INSERT, `PersistentPendingMessage` interface, `toPendingMessage()` conversion, and added migration 25 to both `SessionStore.ts` and `migrations/runner.ts`

  **Known Limitations:**
  - Observations stored before the fix will have NULL branch/commit_sha (backward compatible — the `commit_sha IS NULL` clause includes them in filtered queries)
  - The deprecated `storeObservationsAndMarkComplete()` method in SessionStore does NOT include branch/commit_sha (only the active `storeObservations()` method does)
  - Branch detection requires `cwd` to be present in hook input and the directory to be inside a git repository
