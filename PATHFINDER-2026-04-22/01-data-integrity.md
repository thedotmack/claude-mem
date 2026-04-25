# 01 — Data Integrity

**Purpose**: Cure the data layer's second-system accretion by letting the database enforce uniqueness, making the claim query self-heal against live-worker liveness, and deleting every recovery surface that existed only to paper over the absent primary-path correctness. The cure is four moves: add `UNIQUE` constraints to `pending_messages` and `observations`; rewrite `claimNextMessage` to be idempotent against crashes via `worker_pid NOT IN live_worker_pids`; replace the 30-s dedup window with `INSERT … ON CONFLICT DO NOTHING`; and delete `STALE_PROCESSING_THRESHOLD_MS`, `started_processing_at_epoch`, `DEDUP_WINDOW_MS`, `findDuplicateObservation`, `clearFailedOlderThan` (interval), `repairMalformedSchema`, and migration 19 — in the same PR that they stop being referenced.

---

## Principles invoked

This plan is measured against `00-principles.md`:

1. **Principle 1 — No recovery code for fixable failures.** `recoverStuckProcessing`, `clearFailedOlderThan` interval, and `repairMalformedSchema` all hide primary-path bugs. They are deleted, not relocated.
2. **Principle 2 — Fail-fast over grace-degrade.** Chroma conflict errors surface through a narrow, flagged fallback; the rest of the data layer throws. No silent `.catch(() => undefined)`.
3. **Principle 3 — UNIQUE constraint over dedup window.** The database prevents duplicates; no timer gates them. `DEDUP_WINDOW_MS` and `findDuplicateObservation` are replaced by `UNIQUE(memory_session_id, content_hash)` + `ON CONFLICT DO NOTHING`.

Principles 4, 6, 7 are invoked implicitly: the self-healing claim is event-driven against worker liveness rather than timer-scanned (4); the claim query is one helper for N workers (6); every deleted identifier goes in the same PR as its deletion (7).

---

## Phase 1 — Fresh `schema.sql`

**Purpose**: Regenerate `schema.sql` from the current migration tip so fresh databases boot directly into the post-refactor shape without replaying migrations. Drops `started_processing_at_epoch`, adds `worker_pid INTEGER`, and adds both `UNIQUE` constraints inline.

**Files**:
- `src/services/sqlite/schema.sql` (regenerate)
- `src/services/sqlite/migrations/runner.ts:658-837` — cited as the authoritative shape of `observations` + `session_summaries` after migration 21 (FK cascade fix), per `_reference.md` Part 1 §Data layer.

**Schema changes**:

```sql
-- pending_messages: self-healing claim columns
CREATE TABLE pending_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT    NOT NULL,
  tool_use_id         TEXT    NOT NULL,
  payload             TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending',
  worker_pid          INTEGER,                      -- ADDED (self-healing claim)
  retry_count         INTEGER NOT NULL DEFAULT 0,
  created_at_epoch    INTEGER NOT NULL,
  failed_at_epoch     INTEGER,
  -- started_processing_at_epoch  INTEGER            -- DELETED (Phase 3)
  UNIQUE(session_id, tool_use_id)                   -- ADDED (Phase 4 + ingestion pairing)
);

-- observations: UNIQUE over content_hash
CREATE TABLE observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id   TEXT    NOT NULL,
  content_hash        TEXT    NOT NULL,
  -- … other columns elided …
  UNIQUE(memory_session_id, content_hash)           -- ADDED (replaces DEDUP_WINDOW_MS)
);
```

**Citation**: `_reference.md` Part 1 §Data layer — `runner.ts:658-837` (migration 21) is the precedent for the `observations` table's current column set; `PendingMessageStore.ts:99-145` names the columns this schema replaces.

---

## Phase 2 — Migrate existing databases

**Purpose**: Get every already-installed database onto the new shape via `ALTER TABLE` + backfill + `CREATE UNIQUE INDEX`. Existing rows with duplicate `(session_id, tool_use_id)` or `(memory_session_id, content_hash)` must be deduplicated before the index is created.

**Files**:
- `src/services/sqlite/migrations/runner.ts` — add migration 23 (and 24 if split).

**Precedent**: Migration 22 at `src/services/sqlite/migrations/runner.ts:658-837` is the canonical pattern for non-trivial schema changes — it recreates tables wholesale to add `ON UPDATE CASCADE`. New migrations follow the same shape: recreate or `ALTER`, backfill, then add the unique index.

**Migration sketch**:

```sql
-- Migration 23: pending_messages self-healing claim shape
ALTER TABLE pending_messages ADD COLUMN worker_pid INTEGER;
-- backfill: nothing to do; new column is NULL on existing rows
-- drop old stale column in the table rebuild:
CREATE TABLE pending_messages_new (… without started_processing_at_epoch …);
INSERT INTO pending_messages_new SELECT … (excluding started_processing_at_epoch) … FROM pending_messages;
DROP TABLE pending_messages;
ALTER TABLE pending_messages_new RENAME TO pending_messages;
-- dedup any existing duplicate (session_id, tool_use_id) rows before the index
DELETE FROM pending_messages WHERE id NOT IN (
  SELECT MIN(id) FROM pending_messages GROUP BY session_id, tool_use_id
);
CREATE UNIQUE INDEX ux_pending_session_tool ON pending_messages(session_id, tool_use_id);

-- Migration 24: observations UNIQUE(memory_session_id, content_hash)
DELETE FROM observations WHERE id NOT IN (
  SELECT MIN(id) FROM observations GROUP BY memory_session_id, content_hash
);
CREATE UNIQUE INDEX ux_observations_session_hash ON observations(memory_session_id, content_hash);
```

**Citation**: `_reference.md` Part 1 §Data layer — migration 21 at `runner.ts:658-837` as the table-recreate precedent. Part 2 row "SQLite UNIQUE on added column" confirms the ALTER + backfill + unique-index sequence is the verified pattern.

---

## Phase 3 — Self-healing claim query

**Purpose**: Replace the 60-s stale-reset pattern with a single `UPDATE` whose predicate checks worker liveness at claim time. After this phase, `STALE_PROCESSING_THRESHOLD_MS` and `started_processing_at_epoch` are both gone; `claimNextMessage` has no "recover" branch because no recovery is needed.

**Files**:
- `src/services/sqlite/PendingMessageStore.ts:99-145` — replace the transactional body of `claimNextMessage`.
- `src/services/sqlite/PendingMessageStore.ts` — remove the `STALE_PROCESSING_THRESHOLD_MS` constant.

**Before** (current, at `PendingMessageStore.ts:99-145`): transactional claim that first `UPDATE … SET status='pending' WHERE status='processing' AND started_processing_at_epoch < now - STALE_PROCESSING_THRESHOLD_MS` (self-heal block, lines 107-115), then claims one `pending` row.

**After** (single statement, no self-heal block):

```sql
UPDATE pending_messages
   SET worker_pid = ?,
       status     = 'processing'
 WHERE id = (
   SELECT id FROM pending_messages
    WHERE status = 'pending'
       OR (status = 'processing' AND worker_pid NOT IN (SELECT pid FROM live_worker_pids))
    ORDER BY created_at_epoch
    LIMIT 1
 )
RETURNING *;
```

`live_worker_pids` is populated by the supervisor at claim time (in-process table or a parameterized IN-list of PIDs constructed from `supervisor/process-registry.ts`). The query is correct even after a crash: if a row's `worker_pid` is not a current live worker PID, the row is immediately reclaimable.

**Delete in the same PR**:
- `STALE_PROCESSING_THRESHOLD_MS` constant
- `started_processing_at_epoch` column (via Phase 2 migration)
- The self-heal `UPDATE` block at `PendingMessageStore.ts:107-115`

**Citation**: `_reference.md` Part 1 §Data layer — `PendingMessageStore.ts:99-145` (current `claimNextMessage` transaction, self-heal block at 107-115 is the target).

---

## Phase 4 — Delete dedup window

**Purpose**: Remove the 30-s content-hash dedup window entirely. The `UNIQUE(memory_session_id, content_hash)` constraint added in Phase 1/2 makes duplicates a database error that `ON CONFLICT DO NOTHING` silently absorbs.

**Files**:
- `src/services/sqlite/observations/store.ts:13-46` — delete `DEDUP_WINDOW_MS` constant and `findDuplicateObservation` function.
- `src/services/sqlite/observations/store.ts` — change the insert path to `ON CONFLICT DO NOTHING`.

**Before**: `insert()` first calls `findDuplicateObservation(memory_session_id, content_hash, DEDUP_WINDOW_MS)` and short-circuits if a row exists within the window.

**After**:

```sql
INSERT INTO observations (memory_session_id, content_hash, …)
VALUES (?, ?, …)
ON CONFLICT(memory_session_id, content_hash) DO NOTHING;
```

**Delete in the same PR**:
- `DEDUP_WINDOW_MS` constant
- `findDuplicateObservation` function + all callers
- Any test fixture that depended on the window's timing

**Citation**: `_reference.md` Part 1 §Data layer — `src/services/sqlite/observations/store.ts:13-46` (`DEDUP_WINDOW_MS` + `findDuplicateObservation`). Part 2 row "SQLite `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`" verifies the idempotent-insert primitive.

---

## Phase 5 — Delete `clearFailedOlderThan` interval

**Purpose**: A 2-minute background interval purging `status='failed'` rows is a retention policy pretending to be a correctness concern. Retention moves to a query-time filter; no timer runs.

**Files**:
- `src/services/worker/worker-service.ts:567` — delete the `setInterval(() => …clearFailedOlderThan(…), …)` registration.
- `src/services/sqlite/PendingMessageStore.ts:486-495` — the `clearFailedOlderThan` method itself stays only if an explicit user-invoked purge path needs it; otherwise delete in the same PR.

**After**: Every query that must exclude old failures applies the filter at read time:

```sql
-- at any read site that doesn't want ancient failures
SELECT … FROM pending_messages
 WHERE status != 'failed'
    OR failed_at_epoch > (strftime('%s','now') - 3600) * 1000;
```

If no reader ever needs to suppress old failed rows, then no filter is needed — failed rows simply accumulate until an explicit user purge, and the `clearFailedOlderThan` method is deleted outright.

**Delete in the same PR**:
- The `setInterval` registration at `worker-service.ts:567`
- (Probable) `PendingMessageStore.clearFailedOlderThan` method at `:486-495`

**Citation**: `_reference.md` Part 1 §Data layer — `PendingMessageStore.ts:486-495` (`clearFailedOlderThan`); §Worker/lifecycle — `worker-service.ts:567` (interval call site).

---

## Phase 6 — Delete `repairMalformedSchema` Python subprocess

**Purpose**: The Python fallback that rewrites a corrupt SQLite schema via `execFileSync` is cross-machine WAL corruption that should be root-caused, not repaired. Shipping repair code incentivizes accepting corruption as normal. Delete it; if WAL corruption recurs, investigate and fix the cause (likely an interrupted writer, a misconfigured `PRAGMA`, or a stale `.db-wal` at daemon startup).

**Files**:
- `src/services/sqlite/Database.ts:37-130` — delete `repairMalformedSchema` function, its tempfile-write helper, and its `execFileSync` call site.
- All callers of `repairMalformedSchema` — delete the call; let the original SQLite error propagate.

**Delete in the same PR**:
- `repairMalformedSchema`
- Any `// if malformed, repair` comment or try/catch around its invocation
- The `python3` presence check that gates its availability

**Citation**: `_reference.md` Part 1 §Data layer — `src/services/sqlite/Database.ts:37-130`.

---

## Phase 7 — Chroma sync — upsert semantics

**Purpose**: Chroma MCP has no native upsert. The current `ChromaSync` catches `already exist` on add, deletes the conflicting IDs, then re-adds. This is a brittle error-text match. Document the pattern, gate it behind `CHROMA_SYNC_FALLBACK_ON_CONFLICT=true`, and commit to removing the fallback once Chroma MCP ships upsert natively. The flag is not permanent; it is a bridge.

**Files**:
- `src/services/sync/ChromaSync.ts:290-318` — wrap the delete-then-add reconciliation in the env-flag check.

**Flag contract**:

```ts
// src/services/sync/ChromaSync.ts
const CHROMA_SYNC_FALLBACK_ON_CONFLICT =
  process.env.CHROMA_SYNC_FALLBACK_ON_CONFLICT === 'true';

try {
  await chroma.add(ids, embeddings, metadatas, documents);
} catch (err) {
  if (CHROMA_SYNC_FALLBACK_ON_CONFLICT && isAlreadyExistsError(err)) {
    await chroma.delete(ids);
    await chroma.add(ids, embeddings, metadatas, documents);
    return;
  }
  throw err;
}
```

**Bridge-out plan**: When Chroma MCP exposes `upsert(ids, …)`, replace the `try/add` with `await chroma.upsert(…)` and delete the flag, the error-text predicate, and this phase's code entirely — in the same PR.

**Citation**: `_reference.md` Part 1 §Data layer — `src/services/sync/ChromaSync.ts:290-318`. Part 4 (Known gaps) row 1 flags the error-text brittleness.

---

## Phase 8 — Delete migration 19 no-op

**Purpose**: Migration 19 became a no-op after migration 17 made renames idempotent. It records itself as applied and does nothing. Absorb it into the fresh `schema.sql` (Phase 1) and delete its runner block.

**Files**:
- `src/services/sqlite/migrations/runner.ts:621-628` — delete the migration 19 block.

**After**: No code references `version === 19` except the migration-history table, which is append-only; past-applied rows remain harmless.

**Delete in the same PR**:
- The migration 19 case block at `runner.ts:621-628`
- Any fixture or test that invoked it

**Citation**: `_reference.md` Part 1 §Data layer — `src/services/sqlite/migrations/runner.ts:621-628` (migration 19 no-op).

---

## Verification grep targets

Each command below must return the indicated count after this plan lands.

```
grep -rn "STALE_PROCESSING_THRESHOLD_MS" src/                              → 0
grep -rn "started_processing_at_epoch" src/                                → 0
grep -rn "DEDUP_WINDOW_MS" src/                                            → 0
grep -rn "findDuplicateObservation" src/                                   → 0
grep -rn "repairMalformedSchema" src/                                      → 0
grep -rn "clearFailedOlderThan" src/services/worker/worker-service.ts      → 0
```

**Integration test**: Kill the worker process with `kill -9 <worker_pid>` mid-claim (between the `UPDATE` and the `RETURNING` round-trip, or immediately after a row transitions to `status='processing'`). Start a new worker. Assert the new worker's `claimNextMessage` call succeeds and returns the same row with the new worker's `worker_pid` stamped, and that the row is subsequently processed to completion. This is the acceptance test for the self-healing claim — no background timer is permitted to intervene.

---

## Anti-pattern guards

Directly enforced for this plan (reproduced verbatim from the rewrite plan):

- **Do NOT keep `recoverStuckProcessing()` as a boot-once function.** Self-healing claim replaces it entirely. Any identifier matching `recover*`, `heal*`, or `repair*` that survives this plan must be in a DELETE context.
- **Do NOT add a new timer for Chroma backfill.** Backfill runs at boot-once OR on-demand when a downstream reader requests. No `setInterval`, no `setTimeout` loop.
- **Do NOT add "repair" CLI commands.** If schema corruption recurs after `repairMalformedSchema` is deleted, root-cause it. Do not add a `claude-mem repair-db` command.

---

## Known gaps / deferrals

1. **Chroma upsert fallback brittleness.** The `CHROMA_SYNC_FALLBACK_ON_CONFLICT` flag in Phase 7 matches on error-text ("already exist"). That match is brittle — a Chroma MCP version bump could change the phrase and silently break reconciliation. The flag exists as a bridge, not a permanent surface. When Chroma MCP ships native `upsert`, Phase 7's code and flag both delete in the same PR. This is carried forward from `_rewrite-plan.md` §Known gaps #1 and `_reference.md` Part 4 row 1.
