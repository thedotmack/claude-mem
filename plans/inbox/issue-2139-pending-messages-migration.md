# Plan: Fix Issue #2139 — Missing migration for `pending_messages.tool_use_id` and `pending_messages.worker_pid`

## Root Cause (verified)

There are **two parallel migration code paths** in this repo:

1. `src/services/sqlite/migrations/runner.ts::MigrationRunner.runAllMigrations()` — the canonical runner. It includes `rebuildPendingMessagesForSelfHealingClaim()` (v28) which adds `tool_use_id` + `worker_pid` columns and the `idx_pending_messages_worker_pid` + `ux_pending_session_tool` indexes.
2. `src/services/sqlite/SessionStore.ts` constructor (lines 56–77) — a **duplicated** inline migration list. **It is missing migration 28 entirely** — it calls `addObservationSubagentColumns()` (v27) directly followed by `addObservationsUniqueContentHashIndex()` (v29).

The worker bypasses `Database.ts → MigrationRunner` and instantiates `SessionStore` directly via `src/services/worker/DatabaseManager.ts:34` (`this.sessionStore = new SessionStore(this.db);`). So in a fresh worker boot, the worker only runs SessionStore's incomplete list, leaves v28 unapplied, marks v29 as applied, and the bundled `plugin/scripts/worker-service.cjs` ships without v28's logic (verified: `grep -c "rebuildPendingMessagesForSelfHealingClaim" plugin/scripts/worker-service.cjs` returns 0; `.run(28,` is absent while `.run(27,` and `.run(29,` are present).

Result: `pending_messages` is created from `createPendingMessagesTable()` (v16) which has neither column, no later step adds them, and every queue claim and observation insert fails as the issue describes.

## Fix Strategy

Mirror `MigrationRunner.rebuildPendingMessagesForSelfHealingClaim` into `SessionStore.ts` following the **exact mirror precedent already established** in that file at `SessionStore.ts:1003-1039` (`addObservationSubagentColumns`) and `SessionStore.ts:1041-…` (`addObservationsUniqueContentHashIndex`). Each existing mirror's docstring explicitly says: "Mirrors `MigrationRunner.<name>` so bundled artifacts that embed SessionStore (e.g. worker-service.cjs, context-generator.cjs) stay schema-consistent."

We do **not** need a new schema_versions number. The existing migration is v28; we just need SessionStore to apply it. The mirror should be **column-existence driven** (not version-trust driven) per the SessionStore convention at line 952: *"Cannot trust schema_versions alone — the old MigrationRunner may have recorded version 26 without the ALTER TABLE actually succeeding. Always check column existence directly."* This matters because real-world affected DBs already have v29 recorded (per the issue) — checking version alone would skip the fix.

We should use the **simple `ALTER TABLE` approach** the issue suggests rather than the full table-rebuild from runner.ts, because:
- ALTER TABLE is safe to run on DBs that already reached v29 with rows present.
- The runner.ts rebuild's only extra work was dropping a legacy stale-reset epoch column that hasn't existed since v20 in DBs created by the SessionStore path.
- Idempotency is achieved by `PRAGMA table_info` + column-name guards.

## Phase 0: Documentation Discovery (already done inline above)

Sources consulted:
- `src/services/sqlite/SessionStore.ts:30-77` (constructor migration list)
- `src/services/sqlite/SessionStore.ts:949-1100` (existing mirror methods + docstrings)
- `src/services/sqlite/migrations/runner.ts:22-43` (canonical migration order)
- `src/services/sqlite/migrations/runner.ts:1005-1153` (canonical v28 logic)
- `src/services/sqlite/PendingMessageStore.ts:106-194` (consumer SQL using both columns)
- `src/services/sqlite/schema.sql:121-156` (canonical fresh-DB schema — already has both columns + indexes)
- `src/services/worker/DatabaseManager.ts:31-35` (worker uses SessionStore directly)
- `plugin/scripts/worker-service.cjs` — confirmed bundled artifact has `.run(27,` and `.run(29,` but no `.run(28,` and no `rebuildPendingMessagesForSelfHealingClaim` symbol.

Allowed APIs (verified to exist):
- `this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[]` — used at SessionStore.ts:1024.
- `this.db.run('ALTER TABLE pending_messages ADD COLUMN <col> <type>')` — used at SessionStore.ts:1029, 1032.
- `this.db.run('CREATE INDEX IF NOT EXISTS …')` — used throughout.
- `this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS …')` — used at runner.ts:1134.
- `this.db.prepare('INSERT OR IGNORE INTO schema_versions …').run(28, new Date().toISOString())` — same pattern as v27, v29 mirrors.
- `TableColumnInfo` is already imported at SessionStore.ts top.

Anti-patterns to avoid:
- Do NOT trust `schema_versions.version = 28` alone — check `PRAGMA table_info` for column existence first (real-world DBs from issue #2139 already have v29 recorded with no v28 logic ever applied).
- Do NOT do a full table rebuild in SessionStore — risky on populated DBs and unnecessary; use ALTER TABLE.
- Do NOT add a new version number (e.g. v30). The migration is v28 — we are completing what was already specified, not creating new schema.
- Do NOT modify `runner.ts` — its v28 is correct already; the bug is only that SessionStore doesn't mirror it.
- Do NOT remove the duplicated migration system. That's a larger refactor (see observation 71512). For this fix, just complete the mirror.

## Phase 1: Add the mirror method to SessionStore.ts

**File:** `src/services/sqlite/SessionStore.ts`

### 1A. Add the call site

In the constructor migration list, insert one line between line 75 (`this.addObservationSubagentColumns();`) and line 76 (`this.addObservationsUniqueContentHashIndex();`):

```ts
this.addObservationSubagentColumns();
this.addPendingMessagesToolUseIdAndWorkerPidColumns();   // ← new
this.addObservationsUniqueContentHashIndex();
```

This places the call in the same relative position as `rebuildPendingMessagesForSelfHealingClaim` in `runner.ts:41`.

### 1B. Add the method body

Insert immediately before `addObservationsUniqueContentHashIndex` (around SessionStore.ts:1041), following the docstring pattern of the two adjacent mirrors:

```ts
/**
 * Add tool_use_id and worker_pid columns + indexes to pending_messages (migration 28).
 *
 * Mirrors MigrationRunner.rebuildPendingMessagesForSelfHealingClaim so bundled
 * artifacts that embed SessionStore (e.g. worker-service.cjs, context-generator.cjs)
 * stay schema-consistent. Without this, every queue-claim cycle fails with
 * "no such column: worker_pid" and every observation insert fails with
 * "table pending_messages has no column named tool_use_id" (issue #2139).
 *
 * Uses ALTER TABLE rather than the full table rebuild from MigrationRunner because:
 *   - It's safe on populated DBs that already reached v29 without ever applying v28.
 *   - The legacy stale-reset epoch column the rebuild dropped never existed in
 *     pending_messages tables created by the SessionStore migration path.
 *
 * Column existence is checked directly — schema_versions cannot be trusted because
 * affected DBs may already have v29 recorded with neither column present (#2139).
 */
private addPendingMessagesToolUseIdAndWorkerPidColumns(): void {
  // pending_messages may not exist yet on freshly-created DBs at this point in
  // the migration order — createPendingMessagesTable (v16) has already run by
  // the time we get here, so this guard is defensive only.
  const tables = this.db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
  ).all() as TableNameRow[];
  if (tables.length === 0) {
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
    return;
  }

  const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
  const hasToolUseId = cols.some(c => c.name === 'tool_use_id');
  const hasWorkerPid = cols.some(c => c.name === 'worker_pid');

  if (!hasToolUseId) {
    this.db.run('ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT');
  }
  if (!hasWorkerPid) {
    this.db.run('ALTER TABLE pending_messages ADD COLUMN worker_pid INTEGER');
  }

  // Indexes are idempotent — match runner.ts:1117-1120 + 1134-1138.
  this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_worker_pid ON pending_messages(worker_pid)');

  // The UNIQUE partial index requires no duplicate (content_session_id, tool_use_id)
  // pairs. Dedup before creating it (matches runner.ts:1124-1132). Safe to run
  // unconditionally — if tool_use_id was just added, every row has it as NULL
  // and the WHERE filter excludes them.
  this.db.run(`
    DELETE FROM pending_messages
     WHERE tool_use_id IS NOT NULL
       AND id NOT IN (
         SELECT MIN(id) FROM pending_messages
          WHERE tool_use_id IS NOT NULL
          GROUP BY content_session_id, tool_use_id
       )
  `);
  this.db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
    ON pending_messages(content_session_id, tool_use_id)
    WHERE tool_use_id IS NOT NULL
  `);

  this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
}
```

`TableNameRow` is not currently imported in SessionStore.ts. **Check the existing imports**; if absent, either:
- Add `TableNameRow` to the existing `import { TableColumnInfo, … } from '../../types/database.js';` line, or
- Inline the cast as `as Array<{ name: string }>` (matches the inline pattern used elsewhere in the file).

### 1C. Anti-pattern guards

- ❌ Do **not** wrap in `BEGIN TRANSACTION` — the surrounding constructor doesn't, and `ALTER TABLE … ADD COLUMN` is auto-committed in SQLite.
- ❌ Do **not** call `PRAGMA foreign_keys = OFF` — only needed for table rebuilds, not ALTER TABLE.
- ❌ Do **not** key off `SELECT version FROM schema_versions WHERE version = 28` to early-return — affected DBs have v29 recorded without v28 columns. Always inspect `PRAGMA table_info` first.

### 1D. Verification (Phase 1)

```bash
# Source-side smoke checks
grep -n "addPendingMessagesToolUseIdAndWorkerPidColumns" src/services/sqlite/SessionStore.ts
# Should show 2 matches (call site + method definition)

# Confirm relative ordering is correct
grep -n "addObservationSubagentColumns\|addPendingMessagesToolUseIdAndWorkerPid\|addObservationsUniqueContentHashIndex" src/services/sqlite/SessionStore.ts | head -3
# Should print three lines in order: subagent, pending-messages, unique-hash
```

## Phase 2: Build and verify the bundle

```bash
npm run build-and-sync
```

Verification:

```bash
# Bundled artifact must now contain v28 logic.
grep -c "addPendingMessagesToolUseIdAndWorkerPidColumns\|tool_use_id" plugin/scripts/worker-service.cjs
# tool_use_id count should rise from 6 to >=10 (CREATE INDEX strings + new ALTERs).

grep -on ".run(2[7-9]," plugin/scripts/worker-service.cjs
# Must now include .run(28, in addition to existing .run(27, and .run(29,
```

## Phase 3: End-to-end verification on a real worker

1. Move the existing DB aside to simulate a fresh install:
   ```bash
   mv ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.preissue2139
   mv ~/.claude-mem/claude-mem.db-wal ~/.claude-mem/claude-mem.db-wal.preissue2139 2>/dev/null
   mv ~/.claude-mem/claude-mem.db-shm ~/.claude-mem/claude-mem.db-shm.preissue2139 2>/dev/null
   ```
2. Restart the worker (kill PID from `~/.claude-mem/supervisor.json`; the supervisor respawns it).
3. Confirm the schema:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA table_info(pending_messages);" | grep -E 'tool_use_id|worker_pid'
   # Both rows must appear.
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT version FROM schema_versions ORDER BY version;"
   # Must include 28 and 29.
   sqlite3 ~/.claude-mem/claude-mem.db ".indexes pending_messages" | grep -E 'worker_pid|session_tool'
   # idx_pending_messages_worker_pid and ux_pending_session_tool must appear.
   ```
4. Run a tool call in Claude Code so PostToolUse fires.
5. `tail -n 200 ~/.claude-mem/logs/<latest>.log | grep -E 'no such column|has no column'` — must be empty.
6. `sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"` — must be > 0 after a real session.
7. Restore the original DB so the test isn't destructive:
   ```bash
   mv ~/.claude-mem/claude-mem.db.preissue2139 ~/.claude-mem/claude-mem.db
   # (and the -wal/-shm if they existed)
   ```

## Phase 4: Existing-DB upgrade verification

The user's reported scenario (v29 already applied, columns missing) must also self-heal once the bundle ships. To prove that without waiting for an external user:

1. Copy the current dev DB to a scratch path.
2. Force the broken state:
   ```bash
   cp ~/.claude-mem/claude-mem.db /tmp/issue2139-test.db
   sqlite3 /tmp/issue2139-test.db "
     ALTER TABLE pending_messages DROP COLUMN tool_use_id;
     ALTER TABLE pending_messages DROP COLUMN worker_pid;
     DROP INDEX IF EXISTS idx_pending_messages_worker_pid;
     DROP INDEX IF EXISTS ux_pending_session_tool;
     INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (29, datetime('now'));
   "
   # If DROP COLUMN errors on an older sqlite3 build, simulate via a fresh DB
   # at a 12.4.4-equivalent state instead.
   ```
3. Point a one-off SessionStore at it (a tiny `bun run` script invoking `new SessionStore('/tmp/issue2139-test.db')`).
4. Re-run `PRAGMA table_info(pending_messages)` — both columns must be present, and `schema_versions` must contain `28`.

## Phase 5: Issue follow-through

1. Reply on issue #2139:
   - Confirm the diagnosis (SessionStore mirror missing v28).
   - Note the fix is shipping — give the version number after `version-bump`.
   - Thank the reporter (offer was already in their post; we don't need a PR from them).
2. After the next claude-mem release, the affected user's worker will self-heal on next boot via the column-existence guards.

## Anti-Pattern Audit (final)

- [ ] No new schema_versions number invented (we use existing v28). ✅
- [ ] No version-trust early returns added — column-existence is the source of truth. ✅
- [ ] No table rebuild — straight `ALTER TABLE` to keep the existing rows safe. ✅
- [ ] No edits to `runner.ts` (already correct). ✅
- [ ] Mirror docstring follows the exact precedent at SessionStore.ts:1003 + :1041. ✅
- [ ] Bundle rebuilt and grep-verified to include `.run(28,`. ✅

## Risk Assessment

- **Low risk**: ALTER TABLE ADD COLUMN with a NULLable type cannot fail on a non-empty table; CREATE INDEX IF NOT EXISTS is no-op on subsequent boots; the dedup DELETE is bounded by `tool_use_id IS NOT NULL`, which is empty immediately after the first ALTER.
- **No data loss**: Adding columns and partial unique indexes is non-destructive. The dedup DELETE only fires if duplicate `(content_session_id, tool_use_id)` pairs already exist — an impossibility in the broken-DB scenario where `tool_use_id` was never persisted.
- **Idempotent**: Repeated boots are safe — `PRAGMA table_info` + `IF NOT EXISTS` + `INSERT OR IGNORE`.
