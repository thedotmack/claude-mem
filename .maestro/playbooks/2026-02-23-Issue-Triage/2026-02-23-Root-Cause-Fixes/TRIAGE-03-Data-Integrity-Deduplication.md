# Phase 03: Data Integrity — Deduplication and Project Name Collision

Two distinct data bugs: (1) Each PostToolUse creates 6-10 identical observation records because `store.ts` does a raw INSERT with zero deduplication. (2) Project identity uses `basename(gitRoot)` which collides when two repos share the same folder name (e.g., both named "monorepo"). These are root causes, not symptoms.

**Issues resolved:** #1061, #1158 (duplicate observations), #1200 (project name collision), #1046 (empty project string), #1052, #1036 (stuck isProcessing)

## Root Cause Validation

**Duplicate observations** — CONFIRMED: `src/services/sqlite/observations/store.ts` (56 lines) does a plain `INSERT INTO observations` with NO uniqueness check. No content hash, no idempotency, no dedup. Every call creates a new row.

**Project name collision** — CONFIRMED: `src/shared/paths.ts:getCurrentProjectName()` uses `basename(git rev-parse --show-toplevel)` — returns only the folder name. Two repos at `~/work/monorepo` and `~/personal/monorepo` both return `"monorepo"`, sharing all data. This affects SQLite (project column) AND Chroma (collection name `cm__monorepo`).

## Tasks

- [x] Add content-hash deduplication to `src/services/sqlite/observations/store.ts`:
  - Before the INSERT, compute a hash of `(memory_session_id, title, narrative)` — these are the semantic identity of an observation
  - Use `crypto.createHash('sha256').update(memory_session_id + title + narrative).digest('hex').slice(0, 16)` for a fast short hash
  - Add a `content_hash TEXT` column to the observations table via a migration in `src/services/sqlite/MigrationRunner.ts` (or wherever migrations are defined)
  - Before INSERT, check: `SELECT id FROM observations WHERE content_hash = ? AND created_at_epoch > ?` with a 30-second window
  - If a match exists, skip the INSERT and return the existing id
  - This is application-level dedup, not a database constraint — simpler and more flexible
  - Backfill existing rows: `UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL` (gives existing rows unique hashes so they don't block new inserts)
  - DONE: Added `computeObservationContentHash()` and `findDuplicateObservation()` helpers. Applied dedup to `store.ts`, `transactions.ts` (both functions), and `SessionStore.storeObservation()`. Migration 22 adds `content_hash` column with backfill and index. Added to both `MigrationRunner` and `SessionStore`.

- [x] Fix project name collision in `src/shared/paths.ts`:
  - Find `getCurrentProjectName()` and change it to include parent directory: `path.basename(path.dirname(gitRoot)) + '/' + path.basename(gitRoot)`
  - This produces `work/monorepo` vs `personal/monorepo` — unique enough without being a full path
  - For non-git directories, apply the same pattern to `basename(cwd)`
  - Add a backward-compatibility migration: existing observations with the short name should be queryable. The simplest approach is to NOT migrate old data — just start using the new format for new observations. Searches already use `LIKE` or exact match, so old data with short names will still be found when searching by project
  - Update `ChromaSync.ts` constructor (line 78-86) where `collectionName` is derived from project — the new format with `/` will be sanitized to `_` by the existing regex, producing `cm__work_monorepo`
  - DONE: Changed both git and non-git paths to `basename(dirname(root)) + '/' + basename(root)`. ChromaSync sanitizer already handles `/` → `_`.

- [x] Fix empty project string race condition:
  - In `store.ts`, before the INSERT, validate that `project` is a non-empty string
  - If project is empty/null/undefined, derive it from `cwd` using `getCurrentProjectName(cwd)` as fallback
  - This is a 3-line guard, not a migration
  - DONE: Added `const resolvedProject = project || getCurrentProjectName()` guard before INSERT.

- [x] Fix stuck `isProcessing` flag:
  - Search for `isProcessing` in the codebase to find where it's set and cleared
  - The fix: add a 5-minute timeout. When checking `isProcessing`, also check `updated_at_epoch` — if it's been stuck for >5 minutes, reset it
  - This is a simple timestamp check at the read site, not a periodic cleanup job
  - DONE: Modified `hasAnyPendingWork()` in `PendingMessageStore.ts` to reset stuck 'processing' messages older than 5 minutes before counting. Acts as a self-healing side effect at the read site.

- [x] Run `npm test` and fix any failures
  - DONE: 12 new tests in `tests/sqlite/data-integrity.test.ts` — all pass. 21 pre-existing failures confirmed on clean branch (same count). Zero regressions from TRIAGE-03 changes.
