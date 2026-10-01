# Phase 05: Project Scoping & Session Integrity

This phase fixes two related data integrity problems: (1) project identity uses `basename(cwd)` which causes memory collisions between unrelated projects sharing a folder name (5 issues), and (2) the async observation pipeline has race conditions causing early finalization, duplicate observations, and unbounded pending queue growth (6 issues). Both undermine user trust in the memory system — if the wrong project's memories appear, or observations silently disappear, the core product promise is broken.

## Tasks

- [ ] Upgrade project identity from `basename(cwd)` to `parent/basename` format throughout the codebase. The fix already exists partially in `src/shared/paths.ts` (`getCurrentProjectName()` returns `parent/repo` format) but `src/utils/project-name.ts` (`getProjectName()`) still uses bare `basename`. To fix:
  - Read `src/utils/project-name.ts` to understand `getProjectName(cwd)` — it returns just `path.basename(cwd)`
  - Read `src/shared/paths.ts` for `getCurrentProjectName()` — it returns `basename(dirname(gitRoot))/basename(gitRoot)` (collision-resistant)
  - Search the codebase for all callers of `getProjectName()` using `grep -r "getProjectName"` to find every usage
  - Search for all callers of `getCurrentProjectName()` to understand the parallel usage
  - Consolidate: update `getProjectName(cwd)` to return the `parent/basename` format, matching what `getCurrentProjectName()` already does. This is the single function that all hooks and services should use
  - Handle edge cases: drive roots (return `drive-C` on Windows), home directory (return `home/<basename>`), paths with only one component (return `root/<basename>`)
  - Update `getProjectContext()` in the same file to use the new format for both primary and parent project names
  - **Critical**: Do NOT change the ChromaDB collection naming in `ChromaSync.ts` yet — that requires a data migration (handled separately below)

- [ ] Add a data migration for existing projects using the old `basename`-only format. When users upgrade, their existing observations are stored under the old project name (e.g., `myapp`) but new observations will use the new format (e.g., `work/myapp`). To fix:
  - Read `src/services/sqlite/SessionStore.ts` to understand the `project` column in the sessions and observations tables
  - Read `src/services/sync/ChromaSync.ts` for how project names are used in collection names (`cm__<project>`) and metadata filters
  - Create a migration function `migrateProjectNames()` in the database layer that:
    - Queries all distinct project names from the sessions table
    - For each old-format name (no `/` separator), attempts to resolve the full path by checking if a matching git repo exists in common locations
    - If resolution fails, prefixes with `legacy/` (e.g., `legacy/myapp`) to avoid collisions
    - Updates the `project` column in both `sessions` and `observations` tables within a transaction
  - Add this migration to the worker's background initialization sequence (after database init, before search services) with a one-time flag in settings.json (`projectNameMigrationComplete: true`)
  - For ChromaDB: update metadata in existing collections to use the new project name. Since Chroma doesn't support metadata updates, this means re-syncing affected documents (trigger a backfill for migrated projects)

- [ ] Fix early session finalization. Sessions can be finalized (summary generated, session marked complete) while observation messages are still in the pending queue, causing data loss. To fix:
  - Read `src/services/worker-service.ts` for the session finalization trigger — search for "finalize", "summary", or "SessionEnd"
  - Read `src/services/sqlite/PendingMessageStore.ts` for the `claimNextMessage()` / `confirmProcessed()` pattern
  - Read `src/services/worker/agents/ResponseProcessor.ts` for how observations are stored after processing
  - The fix: before finalizing a session, check if the pending message queue has any messages for that session. If yes, process them first (synchronously wait for completion) before generating the summary
  - Add a `hasPendingMessages(contentSessionId: string): boolean` method to `PendingMessageStore` that checks `SELECT COUNT(*) FROM pending_messages WHERE content_session_id = ? AND status IN ('pending', 'processing')`
  - In the session finalization path, add: `while (await pendingStore.hasPendingMessages(sessionId)) { await sleep(500); }` with a maximum wait of 30 seconds, then force-finalize with a warning
  - Log a warning if force-finalize triggers: `"Session finalized with ${count} pending messages remaining — some observations may be lost"`

- [ ] Fix duplicate observation storage. The content-hash deduplication in `SessionStore.storeObservation()` uses a 30-second window, but race conditions in concurrent message processing can produce duplicate observations with identical content hashes outside this window. To fix:
  - Read `src/services/sqlite/SessionStore.ts` `storeObservation()` (around line 1505) and `storeObservations()` (around line 1631) for the deduplication logic
  - The current check: `SELECT id FROM observations WHERE content_hash = ? AND created_at_epoch > ? AND memory_session_id = ?` (30-second window)
  - Widen the deduplication to session scope: change the time window check to match the entire session lifetime instead of 30 seconds. Replace the epoch check with a session-scoped check: `SELECT id FROM observations WHERE content_hash = ? AND memory_session_id = ?`
  - Add a unique index on `(memory_session_id, content_hash)` to enforce this at the database level. Use `CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_session_hash ON observations(memory_session_id, content_hash)` — add this as a migration
  - Handle the constraint violation gracefully: catch `UNIQUE constraint failed` errors in `storeObservation()` and return the existing observation ID instead of throwing

- [ ] Fix unbounded pending queue growth. When the worker is overloaded or AI processing fails repeatedly, the pending_messages table grows without bound, consuming disk and slowing queries. To fix:
  - Read `src/services/sqlite/PendingMessageStore.ts` for queue management
  - Read `src/services/worker-service.ts` `processPendingQueues()` (around line 811) for the recovery logic
  - Add queue size limits:
    - Maximum 100 pending messages per session (drop oldest when exceeded, with warning log)
    - Maximum 1000 total pending messages across all sessions (pause new enqueues until queue drains)
    - Stale message cleanup: messages older than 6 hours are already cleaned on startup — add a periodic cleanup (every 30 minutes during runtime) to prevent accumulation between restarts
  - Add a `getQueueSize(): number` method that returns total pending message count, and expose it on the `/api/health` endpoint as `pendingQueueSize` for monitoring

- [ ] Write tests for project scoping and session integrity:
  - Test `getProjectName()`: verify `parent/basename` format for normal paths, drive roots, home directories, single-component paths
  - Test project name migration: create test data with old format, run migration, verify new format and ChromaDB re-sync trigger
  - Test early finalization guard: mock pending messages, verify finalization waits for processing
  - Test deduplication: insert two observations with same content hash in same session, verify only one is stored
  - Test queue limits: enqueue 101 messages for a session, verify oldest is dropped with warning

- [ ] Run build and verify:
  - Run `npm run build-and-sync`
  - Run the test suite and fix any failures
  - Verify the migration runs cleanly on a fresh database (no old data to migrate = no-op)
