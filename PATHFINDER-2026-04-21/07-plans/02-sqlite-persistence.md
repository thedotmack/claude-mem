# Plan 02 — sqlite-persistence (clean)

**Target**: claude-mem v6.5.0 brutal-audit refactor, flowchart 3.3.
**Design authority**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` section **3.3**.
**Corrections authority**: `PATHFINDER-2026-04-21/06-implementation-plan.md` Phase 0 verified-findings **V12, V13, V14, V15, V19**.
**Date**: 2026-04-22.

---

## Dependencies

- **Upstream (must land before this plan):** none. This is a leaf plan.
- **Downstream (blocked on this plan):**
  - `03-response-parsing-storage` — depends on `UNIQUE(session_id, tool_use_id)` + `ON CONFLICT DO NOTHING` added in **Phase 1** below (dedup gate moves from content-hash window to DB constraint).
  - `04-vector-search-sync` — depends on the `chroma_synced INTEGER DEFAULT 0` column added in **Phase 2** below. 04's whole backfill simplification (`WHERE chroma_synced=0 LIMIT 1000`) cannot ship until that column exists.
  - `07-session-lifecycle-management` — depends on the boot-once `recoverStuckProcessing()` extracted in **Phase 4** below (07 wires it into the worker startup sequence).

---

## Reporting block 1 — Sources consulted

1. `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — full file (607 lines). **Section 3.3** is the canonical clean design for sqlite-persistence (lines 159–194). Part 1 items **#15** (30-s dedup window → UNIQUE constraint, line 33), **#16** (60-s claim stale-reset → boot recovery, line 34), **#27** (Python sqlite3 repair → `claude-mem repair`, line 45), **#28** (27 migrations → `schema.sql` + upgrade-only runner, line 46). Part 5 ledger rows for SQLite referenced in `06-implementation-plan.md` Phase 9.
2. `PATHFINDER-2026-04-21/06-implementation-plan.md` Phase 0 verified-findings:
   - **V12** (line 39): audit claimed 27 migrations; reality is **19 private methods** in `MigrationRunner.runAllMigrations()` at `runner.ts:22–41`; highest `schema_versions.version` written is **27** (legacy system from `DatabaseManager` contributed ~5 more numbers). Plan target: "19 methods + legacy → `schema.sql` + N upgrade-only migrations".
   - **V13** (line 40): Python sqlite3 subprocess **lives in production code** (`Database.ts:79–99`, not just tests). Test file exists at `tests/services/sqlite/schema-repair.test.ts` (253 lines). Phase 5 must delete from production; test file becomes a CLI test.
   - **V14** (line 41): `DEDUP_WINDOW_MS = 30_000` at `observations/store.ts:13`. Dedup key is SHA-256 of `(memory_session_id, title, narrative)` at `:21–29` — **NOT** `tool_use_id`. The new UNIQUE is an **additive** gate (different key space); it does not automatically subsume every path the content-hash hit.
   - **V15** (line 42): No `chroma_synced` column exists today; Phase 2 creates it.
   - **V19** (line 46): `STALE_PROCESSING_THRESHOLD_MS = 60_000` at `PendingMessageStore.ts:6`; stale reset happens inside every `claimNextMessage()` call (lines 99–145).
   - Phase 9 (lines 412–448) is prior scope draft — superseded where this plan differs.
3. `PATHFINDER-2026-04-21/01-flowcharts/sqlite-persistence.md` — "before" diagram (97 lines). Confirms: 27 migrations claim (V12 corrects), content-hash dedup with 30-s window, claim-confirm self-heal, Python schema repair at boot.
4. Live codebase:
   - `src/services/sqlite/Database.ts` (359 lines). Python repair at `:37–109`, reopen wrapper at `:115–132`, PRAGMA block at `:163–168`, `MigrationRunner` invocation at `:171–172`.
   - `src/services/sqlite/migrations/runner.ts` (1018 lines). 19 private methods listed at `:22–41`. Schema-version INSERTs write versions {4,5,6,7,8,9,10,11,16,17,19,20,21,22,23,24,25,27} — gaps (12–15, 18, 26) confirm the legacy `DatabaseManager` numbering V12 mentions.
   - `src/services/sqlite/observations/store.ts` (108 lines). `DEDUP_WINDOW_MS` at `:13`, `computeObservationContentHash` at `:21–30`, `findDuplicateObservation` at `:36–46`, `storeObservation` at `:53–108`.
   - `src/services/sqlite/PendingMessageStore.ts` (529 lines). `STALE_PROCESSING_THRESHOLD_MS` at `:6`, stale-reset block inside `claimNextMessage` transaction at `:99–145` (reset SQL at `:107–115`, peek at `:118–124`, mark-processing at `:129–134`).
   - `tests/services/sqlite/schema-repair.test.ts` (253 lines) — Python script invoked via `execSync`, per V13.
   - `tests/services/sqlite/migration-runner.test.ts` (361 lines) — existing migration regression tests; these must still pass after consolidation.
   - **No** `src/services/sqlite/schema.sql` exists today (grep confirms). Phase 3 must create it.
5. `PATHFINDER-2026-04-21/07-plans/` — empty of dependency plans (this is the first plan written).

---

## Reporting block 2 — Concrete findings

| Claim | Verified? | Evidence |
|---|---|---|
| Migration method count is 22 (V12 audit) | **Partially** — actual is **19 private methods** enumerated in `runAllMigrations` at `runner.ts:22–41`. 27 is the highest `schema_versions.version` written (legacy `DatabaseManager` migrations 1–3, 12–15, 18, 26 contribute the gap). | `runner.ts:22–41` + grep of `schema_versions.*VALUES.*run(N)` lines. |
| Highest current schema version is 27 | **Yes** — last INSERT at `runner.ts:1015` writes version `27` for `addObservationSubagentColumns`. | `runner.ts:1015`. |
| `UNIQUE(session_id, tool_use_id)` exists today | **No** — zero references to `tool_use_id` anywhere under `src/services/sqlite/`. The identifier only appears in `src/types/transcript.ts` and `src/services/worker/SDKAgent.ts` (input payload shape). | Grep `tool_use_id` in `src/services/sqlite/` returns zero files. |
| Dedup is content-hash based, NOT `tool_use_id` | **Yes** — `computeObservationContentHash` hashes `(memory_session_id, title, narrative)` at `store.ts:21–29`. Subagent `agent_type`/`agent_id` intentionally excluded per the comment at `:18–19`. | `store.ts:13–46`. |
| `chroma_synced` column exists | **No** — no migration adds it; no reference in `runner.ts` or any store. | Grep confirms. |
| 60-s stale reset fires per-claim, not at boot | **Yes** — reset UPDATE lives **inside** the `claimTx` transaction at `PendingMessageStore.ts:107–115`, run every time `claimNextMessage()` is called. | `PendingMessageStore.ts:99–145`. |
| Python sqlite3 lives in production, not just tests | **Yes** — `execFileSync('python3', [scriptPath, dbPath, objectName], ...)` at `Database.ts:99` inside the production `repairMalformedSchema` function (`:37–109`). Test file at `tests/services/sqlite/schema-repair.test.ts` exercises that production code path. | `Database.ts:99`. |
| `schema.sql` file exists today | **No** — Phase 3 must create it. "HOW" is detailed below (dump current state from a clean fresh-install DB). | Glob `**/*.sql` under `src/` returns zero. |

**Net count correction propagated to every phase below:** "19 methods (not 22 or 27)" where migration count is cited.

---

## Reporting block 3 — Copy-ready snippet locations

| Destination | Source file:line | What to copy |
|---|---|---|
| `src/services/sqlite/migrations/2026-04-22_add_observations_tool_use_id.ts` (new upgrade migration) | Existing patterns from `runner.ts:658–842` (migration `addOnUpdateCascadeToForeignKeys`, idempotent ALTER) | The idempotent "check column via `PRAGMA table_info`, ALTER if missing, mark `schema_versions`" pattern. |
| `src/services/sqlite/observations/store.ts` (Phase 1 rewrite) | Existing INSERT shape at `store.ts:77–102` | Keep the 17-column INSERT layout; only change the body from "compute hash → check dup → INSERT" to "INSERT … ON CONFLICT (memory_session_id, tool_use_id) DO NOTHING RETURNING id". |
| `src/services/sqlite/migrations/2026-04-23_add_observations_chroma_synced.ts` (new upgrade migration) | Pattern from `addObservationContentHashColumn` at `runner.ts:844–864` | Exact template: `PRAGMA table_info` → `ALTER TABLE observations ADD COLUMN chroma_synced INTEGER DEFAULT 0` → record version. |
| `src/services/sqlite/schema.sql` (new — created in Phase 3) | `runner.ts:52–124` (initializeSchema block) + tables from migrations 5,6,8,9,10,11,16,17,19,20,21,22,23,24,25,27 | Run the current `MigrationRunner` end-to-end on a fresh `:memory:` DB, then dump via `SELECT sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY rootpage` — this is the authoritative generator. Detail in Phase 3 tasks. |
| `src/services/sqlite/PendingMessageStore.ts` (Phase 4) | Stale-reset block at `PendingMessageStore.ts:107–115` | Copy the SQL verbatim into a new `recoverStuckProcessing()` method; delete the copy from inside `claimTx`. `claimNextMessage` keeps only `peek` (`:118–124`) + `mark-processing` (`:129–134`) inside its transaction. |
| `src/cli/handlers/repair.ts` (new — Phase 5) | `Database.ts:79–107` (Python script body + `execFileSync` call) | Move the whole Python-script-written-to-tempfile + `execFileSync` pattern into a user-invoked CLI command handler; remove boot-time auto-call. |

---

## Reporting block 4 — Confidence + gaps

**Confidence: HIGH** on:
- Phases 1, 2, 4, 6 — all reference existing, stable code (V14/V15/V19 are pinned to single-file call sites).
- Phase 5 — Python block is small (~70 lines of wrapper + embedded script at `Database.ts:37–109`) and test coverage already exists at `tests/services/sqlite/schema-repair.test.ts`.

**Confidence: MEDIUM** on:
- Phase 3 (schema.sql generation). `schema.sql` does not exist today. The mechanical path is: (a) spin up `:memory:` DB, (b) run current `MigrationRunner.runAllMigrations()` unchanged, (c) dump `SELECT sql FROM sqlite_master` in a stable order, (d) check the dump into the repo. Risk: FTS5 virtual tables and their implicit rowid-shadow tables may need hand-tuning because `sqlite_master` includes internal `*_content`/`*_idx` tables that must NOT be in `schema.sql` (they're auto-created by the `CREATE VIRTUAL TABLE USING fts5` statement). **The schema.sql generator must filter `name NOT LIKE '%_content' AND name NOT LIKE '%_segments' AND name NOT LIKE '%_segdir' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_config'`** (all standard FTS5 shadow-table suffixes).
- Phase 1 ordering w.r.t. Phase 6. Dropping `DEDUP_WINDOW_MS` + `findDuplicateObservation` (Phase 6) ONLY after Phase 1 lands AND verification proves every observation-ingest path writes a `tool_use_id`. The **transcript-watcher ingest path** (`src/services/transcripts/watcher.ts`, referenced by downstream plan `07-session-lifecycle-management`) may emit observations where `tool_use_id` is derived from JSONL line parsing rather than the hook payload — if that path produces a non-unique or missing `tool_use_id`, the UNIQUE constraint will not cover it and the content-hash gate still provides value. **Phase 6 is gated by a concrete grep + runtime check that every call site into `storeObservation` supplies a real `tool_use_id`.**

**Top gaps:**
1. **`schema.sql` doesn't exist today — must be generated mechanically.** Phase 3 specifies the exact generator script so this is reproducible. The risk is that FTS5 shadow tables leak into the dump; the filter list above must be applied. If a future migration adds a `USING fts5` virtual table with a non-default suffix, the filter will need updating.
2. **Dedup semantics may differ across ingest paths.** V14 confirms the current dedup key (SHA of title+narrative) and V14's warning applies: the transcript watcher, `/api/sessions/observations` hook path, and `/sessions/:id/observations` legacy path may each derive `tool_use_id` differently. Phase 1 adds the UNIQUE constraint but Phase 6 (dedup-window removal) must verify all three paths supply a consistent `tool_use_id` BEFORE the content-hash fallback is deleted. If the transcript-watcher path uses synthetic IDs (e.g., `file:offset`) instead of the real Claude Code `tool_use_id`, that's a real gap to flag to the owner of plan `07-session-lifecycle-management` before both plans land.

---

## Phase contract — template applied below

Every phase specifies:
- **(a) What to implement** — framed as "Copy from `<file>:<line>` into `<dest>`".
- **(b) Documentation references** — 05 section + V-numbers + live file:line.
- **(c) Verification checklist** — concrete greps + tests.
- **(d) Anti-pattern guards** — A (invent migration methods), B (polling), C (silent fallback), E (two dedup paths).

---

## Phase 1 — Add `UNIQUE(session_id, tool_use_id)` and `ON CONFLICT DO NOTHING` INSERT

**Outcome**: Observations have a `tool_use_id` column; `(memory_session_id, tool_use_id)` is UNIQUE; `storeObservation` uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id` (idempotent, constraint-based). Content-hash dedup still runs underneath (removed in Phase 6 after verification).

### (a) Tasks

1. **Create new migration** `src/services/sqlite/migrations/` (add a method to `MigrationRunner.runAllMigrations` between `addObservationSubagentColumns` (line 41) and a new method `addObservationToolUseIdUnique`, assigning `schema_versions.version = 28`).
   - Copy the idempotent pattern from `addObservationContentHashColumn` at `runner.ts:844–864`: `PRAGMA table_info(observations)` → if `tool_use_id` column missing, `ALTER TABLE observations ADD COLUMN tool_use_id TEXT`.
   - Backfill legacy rows: `UPDATE observations SET tool_use_id = 'legacy:' || id WHERE tool_use_id IS NULL`. Legacy synthetic IDs must be unique across existing rows (row `id` is unique by PK) and prefixed so future real `tool_use_id` values never collide.
   - Create unique partial index: `CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_session_tool_use_id ON observations(memory_session_id, tool_use_id) WHERE tool_use_id IS NOT NULL`.
   - Register version 28.
2. **Rewrite `src/services/sqlite/observations/store.ts:53–108`** (`storeObservation`):
   - Add `tool_use_id: string` to `ObservationInput` (`src/services/sqlite/observations/types.ts`).
   - Replace the INSERT at `:77–102` with:
     ```sql
     INSERT INTO observations
       (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
        files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id,
        content_hash, tool_use_id, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_session_id, tool_use_id) DO NOTHING
     RETURNING id, created_at_epoch
     ```
   - If `RETURNING` returns a row → new insert, return it.
   - If no row returned → SELECT the existing row: `SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND tool_use_id = ?` and return.
   - **Keep** `computeObservationContentHash` and `findDuplicateObservation` and the pre-INSERT dedup check **intact** in this phase. Phase 6 removes them. (Rationale: additive gate first, drop old gate only after confirming coverage — anti-pattern E avoidance.)
3. **Wire `tool_use_id` through every call site that creates an observation**. Grep: every `storeObservation(` caller must now pass `tool_use_id`. The three known ingest paths are (i) `/api/sessions/observations` HTTP route, (ii) `/sessions/:id/observations` legacy route, (iii) transcript-watcher ingest. Each must read `tool_use_id` from the incoming payload (hook sends it; transcript JSONL lines contain it).

### (b) Documentation references

- `05-clean-flowcharts.md` **section 3.3**, line 172 (`INSERT observations UNIQUE(session_id, tool_use_id)`) and line 188 (deletion ledger entry). Part 1 item **#15** at line 33.
- Verified-finding **V14** (`06-implementation-plan.md:41`).
- Live code: `observations/store.ts:13–108`, `runner.ts:844–864` (copy-from template).

### (c) Verification checklist

- [ ] Grep: `grep -n "tool_use_id" src/services/sqlite/` returns at least 3 hits (types, store INSERT, migration).
- [ ] Grep: `grep -n "tool_use_id" src/services/worker/http/routes/SessionRoutes.ts` confirms both observation route handlers read it from body.
- [ ] New unit test `tests/services/sqlite/observations/unique-constraint.test.ts`: insert two observations with same `(memory_session_id, tool_use_id)`; assert second returns the first's `id`; assert `SELECT COUNT(*) FROM observations` incremented by exactly 1.
- [ ] Existing `tests/services/sqlite/migration-runner.test.ts` (361 lines) still passes — no regressions on migrations 4–27.
- [ ] Fresh-install smoke: delete DB, boot worker, confirm `PRAGMA index_list(observations)` includes `idx_observations_session_tool_use_id`.
- [ ] Upgrade smoke: copy a v6.5.0 DB into place, boot worker, confirm legacy rows got `tool_use_id = 'legacy:<id>'` and new index exists.

### (d) Anti-pattern guards

- **A (invent migration methods)**: do NOT add any migration method besides `addObservationToolUseIdUnique` in this phase. Enumerate before adding.
- **C (silent fallback)**: `ON CONFLICT DO NOTHING` is **idempotent, not silent** — conflicts are expected and return the existing id. The route handler must not treat "no new row inserted" as an error; the caller gets the existing id back.
- **E (two dedup paths)**: both dedup gates are present in this phase **intentionally**. The old one exits in Phase 6 after every path is verified.

### Blast radius

Schema change (one new column, one new index). Hook + route payload shapes gain `tool_use_id`. No runtime behavior change on happy path (first INSERT wins as before); conflict path now returns the existing id faster (no pre-check query, one INSERT round-trip).

---

## Phase 2 — Add `chroma_synced` column (blocks plan 04)

**Outcome**: `observations.chroma_synced INTEGER DEFAULT 0`, `session_summaries.chroma_synced INTEGER DEFAULT 0`, and `user_prompts.chroma_synced INTEGER DEFAULT 0` exist. Partial index on `chroma_synced = 0` for the backfill scan on all three tables. Plan `04-vector-search-sync` can now consume these.

> **Preflight edit 2026-04-22 (reconciliation C3)**: The original phase covered only `observations` + `session_summaries`. Reconciliation identified that plan 04 also backfills `user_prompts`, so this phase must add the column there too. Migration body below extends to all three tables.

### (a) Tasks

1. **Add migration method `addChromaSyncedColumns`** to `MigrationRunner.runAllMigrations` (between the new `addObservationToolUseIdUnique` from Phase 1 and end of list), assigning `schema_versions.version = 29`.
   - Template: `addObservationContentHashColumn` at `runner.ts:844–864`.
   - Body:
     ```ts
     const obsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
     if (!obsInfo.some(c => c.name === 'chroma_synced')) {
       this.db.run('ALTER TABLE observations ADD COLUMN chroma_synced INTEGER NOT NULL DEFAULT 0');
     }
     const sumInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
     if (!sumInfo.some(c => c.name === 'chroma_synced')) {
       this.db.run('ALTER TABLE session_summaries ADD COLUMN chroma_synced INTEGER NOT NULL DEFAULT 0');
     }
     const promptInfo = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
     if (!promptInfo.some(c => c.name === 'chroma_synced')) {
       this.db.run('ALTER TABLE user_prompts ADD COLUMN chroma_synced INTEGER NOT NULL DEFAULT 0');
     }
     this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_chroma_synced ON observations(chroma_synced) WHERE chroma_synced = 0');
     this.db.run('CREATE INDEX IF NOT EXISTS idx_summaries_chroma_synced ON session_summaries(chroma_synced) WHERE chroma_synced = 0');
     this.db.run('CREATE INDEX IF NOT EXISTS idx_prompts_chroma_synced ON user_prompts(chroma_synced) WHERE chroma_synced = 0');
     this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
     ```
2. **Do NOT** modify `ChromaSync.ts` in this phase — that is plan 04's responsibility. This phase only lands the schema.

### (b) Documentation references

- `05-clean-flowcharts.md` **section 3.4** line 226 ("Adds: `chroma_synced` boolean column on `observations`. Schema migration.").
- Verified-finding **V15** (`06-implementation-plan.md:42`).
- Live code: `runner.ts:844–864` (copy template).

### (c) Verification checklist

- [ ] `PRAGMA table_info(observations)` on a fresh-boot DB includes `chroma_synced`.
- [ ] `PRAGMA table_info(session_summaries)` includes `chroma_synced`.
- [ ] `PRAGMA table_info(user_prompts)` includes `chroma_synced`.
- [ ] Partial indexes exist: `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%chroma_synced%'` returns 3 rows.
- [ ] Upgrade smoke: on a pre-Phase-2 DB, both ALTERs run exactly once; second boot is a no-op (idempotency gate).
- [ ] `migration-runner.test.ts` extended with a case asserting `schema_versions.version = 29` after fresh install.

### (d) Anti-pattern guards

- **A**: one method, one version. Do not add a backfill-on-migration step here (that's plan 04).
- **E**: do NOT touch `ChromaSync.ts` write path in this phase; keep concerns isolated so plans can land independently.

### Blast radius

Pure additive schema. Zero runtime behavior change until plan 04 starts writing to the column.

---

## Phase 3 — Consolidate 19 migrations into `schema.sql` + slim upgrade-only runner

**Outcome**: Fresh DBs execute `src/services/sqlite/schema.sql` in one shot and write `schema_versions.version = <current>`. Existing DBs continue running only upgrade-step migrations whose version is `> max(schema_versions.version)`. The 19 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` idempotency bodies shrink dramatically since fresh-DB paths no longer traverse them.

### (a) Tasks

1. **Generate `src/services/sqlite/schema.sql`** by a reproducible script, not by hand:
   - Write a one-shot generator at `scripts/dump-schema.ts`:
     ```ts
     import { Database } from 'bun:sqlite';
     import { MigrationRunner } from '../src/services/sqlite/migrations/runner.js';
     import { writeFileSync } from 'fs';
     const db = new Database(':memory:');
     new MigrationRunner(db).runAllMigrations();
     // Filter out FTS5 shadow tables — they're created automatically by CREATE VIRTUAL TABLE.
     const rows = db.query(`
       SELECT sql FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_content'
         AND name NOT LIKE '%_segments'
         AND name NOT LIKE '%_segdir'
         AND name NOT LIKE '%_docsize'
         AND name NOT LIKE '%_config'
         AND name NOT LIKE '%_data'
         AND name NOT LIKE '%_idx'
       ORDER BY
         CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,
         name
     `).all() as { sql: string }[];
     writeFileSync('src/services/sqlite/schema.sql',
       rows.map(r => r.sql + ';').join('\n\n') + '\n');
     ```
   - Run `bun run scripts/dump-schema.ts`, commit the resulting `schema.sql`.
   - `schema.sql` must end with `INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (29, datetime('now'));` (where 29 = current max after Phases 1 and 2).
2. **Rewrite `Database.ts:171–172`** to check for fresh DB:
   - After PRAGMAs, query `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_versions'`.
   - If zero (true fresh DB): read `schema.sql` (bundled via `import.meta` or FS at a known path), execute via `db.exec(sql)`, done.
   - Else: run `MigrationRunner` as today (it's already idempotent per-migration via `PRAGMA table_info` checks).
3. **DO NOT delete the 19 migration methods.** They remain as upgrade paths for existing DBs from v6.4.x or earlier. What shrinks is the fresh-install path cost (19 idempotent ALTER checks → 1 `db.exec(schema.sql)`).
4. **Add a CI check** in `tests/services/sqlite/schema-consistency.test.ts`: runs the dump-schema generator in-memory, diffs against the checked-in `schema.sql`; fails if they drift. This is the only way to keep `schema.sql` honest as new migrations land.

### (b) Documentation references

- `05-clean-flowcharts.md` **section 3.3** lines 166–170 (Boot → Check → Fresh? → Execute `schema.sql` vs Migrate). Line 191 in the deletion ledger.
- Verified-finding **V12** (`06-implementation-plan.md:39`) — confirms 19 methods, not 27.
- Live code: `Database.ts:163–173` (boot sequence), `runner.ts:22–41` (method list).
- **Gap note from reporting block 4 (#1)**: the FTS5 shadow-table filter list in the generator is non-obvious; comment it inline with a link to the SQLite FTS5 docs section on shadow tables.

### (c) Verification checklist

- [ ] `ls src/services/sqlite/schema.sql` exists and is > 0 bytes.
- [ ] Fresh-install test: delete DB → boot → dump `sqlite_master` → byte-equal to `schema.sql` content (modulo the `schema_versions` INSERT).
- [ ] Upgrade test: copy a v6.4 fixture DB → boot → all 19 migration methods run → final schema matches `schema.sql`.
- [ ] `schema-consistency.test.ts` (new) passes on CI.
- [ ] `migration-runner.test.ts` (existing, 361 lines) still passes — upgrade path is unchanged.
- [ ] No FTS5 shadow table names appear in `schema.sql` (grep: `_content\|_segments\|_segdir\|_docsize\|_config\|_data\|_idx` returns zero).

### (d) Anti-pattern guards

- **A (invent migration methods)**: `schema.sql` is NOT a replacement for the runner's upgrade methods — it's a fresh-install fast-path. Don't invent a "migration framework". `db.exec()` + a list of functions is the whole system.
- **C (silent fallback)**: if `schema.sql` parsing throws on boot, **do not** fall back to running the runner from scratch — fail boot with a clear error. A fresh-DB schema failure is a shipped-bug bug; users should see it.

### Blast radius

Fresh-install boot drops from ~19 idempotency checks to one `db.exec`. Existing DBs: identical behavior. Risk: `schema.sql` drift from runner — mitigated by the consistency test.

**Lines deleted estimate for this phase alone: 0 net from runner (methods stay for upgrades). Lines added: ~200 for `schema.sql`, ~30 for consistency test, ~15 for boot branch.**

---

## Phase 4 — Move all SQLite housekeeping to boot-once (revised 2026-04-22)

**Outcome**: zero repeating SQLite-related `setInterval`s anywhere in the worker. `PendingMessageStore.claimNextMessage()` becomes pure SELECT+UPDATE (no self-healing per call). Three boot-once jobs exist on `PendingMessageStore` / `Database`, called exactly once at worker startup:

1. `recoverStuckProcessing()` — resets `status='processing'` rows left by a crashed prior worker.
2. `clearFailedOlderThan(1h)` — prunes old failed rows that accumulated before this boot (no schema constraint requires periodic execution; see Reporting block 2).
3. Deletion of the periodic `PRAGMA wal_checkpoint(PASSIVE)` call — replaced by SQLite's native `wal_autocheckpoint` default (1000 pages). `Database.ts:162-168` sets no override so the default is already active; no new code is required.

**Why zero-timer** (authoritative rationale, supersedes any older plan text): SQLite auto-checkpoints when the WAL reaches 1000 pages of writes, which is the correct contract for a long-running worker. An explicit 2-min `PRAGMA wal_checkpoint(PASSIVE)` call accelerates checkpoints beyond that default but is not required for correctness — it was a band-aid layered on top of the stale-reaper interval (`worker-service.ts:547-589`). Similarly, `clearFailedOlderThan(1h)` running every 2 min purges rows that realistically accumulate at single-digit-per-hour rates; once-per-boot is sufficient and no `pending_messages` query cares about row count or stale-row presence. See `08-reconciliation.md` Part 4 revised cross-check (Invariant 4).

### (a) Tasks

1. **Add new method** `PendingMessageStore.recoverStuckProcessing()`:
   - Copy the stale-reset SQL block from `PendingMessageStore.ts:106–115` **verbatim** into the new method:
     ```ts
     recoverStuckProcessing(): number {
       const staleCutoff = Date.now() - STALE_PROCESSING_THRESHOLD_MS;
       const resetStmt = this.db.prepare(`
         UPDATE pending_messages
         SET status = 'pending', started_processing_at_epoch = NULL
         WHERE status = 'processing' AND started_processing_at_epoch < ?
       `);
       const result = resetStmt.run(staleCutoff);
       if (result.changes > 0) {
         logger.info('QUEUE', `BOOT_RECOVERY | recovered ${result.changes} stale processing message(s)`);
       }
       return result.changes as number;
     }
     ```
   - Note the SQL changes one thing: no `session_db_id = ?` predicate — boot recovery is global across all sessions.
2. **Delete** `PendingMessageStore.ts:103–116` (the `staleCutoff` / `resetStmt` block inside `claimTx`). The transaction body shrinks to peek (lines 118–124) + mark-processing (lines 129–134).
3. **Confirm `clearFailedOlderThan()` is callable standalone.** Current signature at `PendingMessageStore.ts:486-495` accepts a `thresholdMs` number and runs a single-statement UPDATE/DELETE. No change to the method body; this phase only moves **where it is called from**. No new method is added for this — the existing one is sufficient.
4. **Delete the explicit `PRAGMA wal_checkpoint(PASSIVE)` call** from `worker-service.ts:~581` as part of plan 07 Phase 4's deletion of the stale-reaper block (`worker-service.ts:547-589`). This plan is the authority that it is safe to delete: `Database.ts:162-168` sets `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size`, `mmap_size`, and leaves `wal_autocheckpoint` at SQLite's default (1000 pages). No override was ever introduced. Verification in (c) confirms.
5. **Wire the three boot calls** in the downstream plan `07-session-lifecycle-management` Phase 3 Mechanism C (boot-once reconciliation block). That plan's responsibility to place `pendingStore.recoverStuckProcessing()` and `pendingStore.clearFailedOlderThan(60 * 60 * 1000)` in the worker startup sequence. This plan **adds/confirms the methods** but does not modify `worker-service.ts` directly (single-responsibility per plan).

### (b) Documentation references

- `05-clean-flowcharts.md` **section 3.3** lines 183–184 ("Worker startup ONCE (not on every claim) … crash recovery") and line 190 (deletion ledger).
- `05-clean-flowcharts.md` Part 2 **D3** (revised 2026-04-22 — zero repeating background timers).
- `05-clean-flowcharts.md` Part 4 timer census (revised — `clearFailedOlderThan` and `PRAGMA wal_checkpoint` explicit disposition).
- Part 1 item **#16** (line 34) and Part 2 decision on "Crash-recovery that solves a real OS-level problem … keep but consolidate".
- Verified-finding **V19** (`06-implementation-plan.md:46`).
- `08-reconciliation.md` Part 4 revised — Invariant 4 (SQLite auto-checkpoint default is active).
- Live code: `PendingMessageStore.ts:6` (threshold), `:99–145` (full `claimNextMessage`), `:486-495` (`clearFailedOlderThan`), `Database.ts:162-168` (PRAGMA block — confirms no `wal_autocheckpoint` override), `worker-service.ts:547-589` (stale-reaper block being deleted by plan 07 Phase 4).

### (c) Verification checklist

- [ ] Grep: `grep -n "STALE_PROCESSING_THRESHOLD_MS" src/services/sqlite/PendingMessageStore.ts` → 2 matches max (constant + `recoverStuckProcessing` body).
- [ ] Grep: `grep -n "status = 'processing'" src/services/sqlite/PendingMessageStore.ts` finds exactly one UPDATE that flips processing→pending (in `recoverStuckProcessing`), NOT in `claimNextMessage`.
- [ ] Inspect `claimNextMessage`: transaction body has no UPDATE-to-pending step.
- [ ] Grep: `grep -rn "clearFailedOlderThan" src/` → exactly 2 matches (the method definition in `PendingMessageStore.ts` and a single call site in the boot-once reconciliation block inside `worker-service.ts`). No call inside any `setInterval` or handler.
- [ ] Grep: `grep -rn "wal_checkpoint" src/services/worker/ src/services/worker-service.ts` → **0 matches** in `worker-service.ts`. If the codebase introduces an observability read of `PRAGMA wal_autocheckpoint` at boot for logging purposes, that is fine — but no explicit `PRAGMA wal_checkpoint(...)` execution anywhere.
- [ ] Grep: `grep -n "wal_autocheckpoint" src/services/sqlite/Database.ts` → 0 matches (confirms we are relying on SQLite's default of 1000 pages; any future non-zero override must be reviewed against this plan).
- [ ] Grep: `grep -rn "setInterval" src/services/sqlite/ src/services/worker-service.ts` → **0 matches** for SQLite-related intervals.
- [ ] New unit test `tests/services/sqlite/PendingMessageStore.boot-recovery.test.ts`:
  - Insert a row with `status='processing'`, `started_processing_at_epoch = Date.now() - 2*60_000`.
  - Call `recoverStuckProcessing()`; assert return = 1; assert `status='pending'` and `started_processing_at_epoch=NULL`.
- [ ] New unit test `tests/services/sqlite/PendingMessageStore.failed-purge.test.ts`:
  - Insert three `status='failed'` rows with `updated_at_epoch` values `now-2h`, `now-30min`, `now-5min`.
  - Call `clearFailedOlderThan(60 * 60 * 1000)`; assert exactly the `now-2h` row is removed; the other two remain.
- [ ] WAL-checkpoint regression test: with `wal_autocheckpoint` at SQLite default, write > 1000 pages to the DB in a loop; assert the WAL file size stabilizes (does not grow unbounded). Proves the default is sufficient without explicit `PRAGMA wal_checkpoint`.
- [ ] Existing `tests/services/sqlite/PendingMessageStore.test.ts` tests for `claimNextMessage` still pass, but the "self-healing" test case (if present) is rewritten against `recoverStuckProcessing` instead.

### (d) Anti-pattern guards

- **B (no polling, no new interval)**: none of the three boot-once jobs may run on a timer, inside `claimNextMessage`, or inside any request handler. Boot-once is the contract. The canonical check is `grep -rn "setInterval" src/services/sqlite/ src/services/worker-service.ts` → **0**.
- **A (no invented abstractions)**: no `SqliteHousekeepingService` class, no `BootRecoveryOrchestrator`. The three calls live as three plain method invocations inside plan 07's boot-once reconciliation block. If a fourth housekeeping job appears later, *then* extract.
- **D (no facade-over-facade)**: `clearFailedOlderThan` is called directly on `PendingMessageStore` — do not add a `housekeepFailed()` wrapper that just forwards.

### Blast radius

`PendingMessageStore` (new method + deletion of in-transaction self-heal) and — through plan 07's boot block — `worker-service.ts` (deletion of the periodic `wal_checkpoint` + `clearFailedOlderThan` calls inside the stale-reaper interval). Downstream `07-session-lifecycle-management` adds the call sites; until that plan lands, `recoverStuckProcessing()` is dead code (acceptable — additive, doesn't break anything). Deleting the explicit `wal_checkpoint` call has no user-visible effect; the WAL grows slightly larger between auto-checkpoints, which is within SQLite's designed behavior.

---

## Phase 5 — Delete Python sqlite3 schema-repair; replace with user-facing `claude-mem repair`

**Outcome**: `Database.ts:37–132` (`repairMalformedSchema` + `repairMalformedSchemaWithReopen`) gone. Production boot never shells out to Python. A new CLI subcommand `claude-mem repair` exists (or is stubbed with a documented follow-up plan) for users hitting pre-v6.5 corruption.

### (a) Tasks

1. **Delete** `Database.ts:2–5` (imports: `execFileSync`, `fs` helpers, `tmpdir`, `path.join`) and `Database.ts:37–132` (both `repairMalformedSchema` functions and their reopen wrapper).
2. **Delete** `Database.ts:160` (the call to `repairMalformedSchemaWithReopen`) in the `ClaudeMemDatabase` constructor. PRAGMAs now execute directly after `new Database()`.
3. **Create CLI subcommand** `src/cli/handlers/repair.ts`:
   - Copy the Python script body + `execFileSync` pattern from the deleted `Database.ts:81–99` verbatim.
   - Expose via `src/cli/index.ts` (or wherever subcommand dispatch lives) as `claude-mem repair`.
   - On success, print a human-readable summary: "Dropped N orphaned schema objects; reset migration versions. Restart the worker."
   - On failure: exit code 1 with the Python error surfaced.
   - **Acceptable alternative if CLI scaffolding is heavier than expected**: ship this phase as a **stub** handler that prints a "Feature scheduled — see follow-up plan [link]" message and register the follow-up plan explicitly. Do not leave the production Python path alive "until the CLI is ready" — the boot-time auto-repair must be deleted in this phase.
4. **Move the existing test** `tests/services/sqlite/schema-repair.test.ts` (253 lines) to exercise the CLI handler instead of the production boot path. If the stub route is taken, the test becomes a skipped/TODO stub with a reference to the follow-up plan.

### (b) Documentation references

- `05-clean-flowcharts.md` Part 1 item **#27** (line 45): "Users on malformed DBs from v<X run a one-shot `claude-mem repair` command manually."
- Section 3.3 deletion ledger line 187 (~120 lines estimate).
- Verified-finding **V13** (`06-implementation-plan.md:40`).
- Live code: `Database.ts:37–132` (delete), `tests/services/sqlite/schema-repair.test.ts` (repoint).

### (c) Verification checklist

- [ ] `grep -n "execFileSync\|execSync" src/services/sqlite/` → zero hits.
- [ ] `grep -n "python3" src/services/` → zero hits.
- [ ] `grep -rn "repairMalformedSchema" src/` → zero hits.
- [ ] `wc -l src/services/sqlite/Database.ts` shows ~100 fewer lines than today (359 → ~260).
- [ ] `claude-mem repair --help` prints usage (or stub message with follow-up-plan link).
- [ ] Fresh boot smoke: start worker with a healthy DB; confirm no Python process spawned (check `ps` or instrumentation log).
- [ ] Malformed-DB smoke: deliberately corrupt `sqlite_master`, boot worker → expect a clean error with instruction "run `claude-mem repair`" (not a silent auto-heal).

### (d) Anti-pattern guards

- **C (silent fallback)**: boot must not auto-recover from malformed schema. Surface the error. That's the whole point of V13's call-out.
- **A**: do not invent an `AutoRepairService`. One CLI handler, done.
- **E**: `claude-mem repair` is the ONE repair entry point. Delete everywhere else.

### Blast radius

Boot path simplifies. Users on corrupt DBs get a clear message instead of silent auto-fix. Risk: users accustomed to auto-repair will see hard failure — mitigated by the message pointing at `claude-mem repair`.

**Lines deleted estimate: ~100 from `Database.ts`.**

---

## Phase 6 — Delete `DEDUP_WINDOW_MS` + `findDuplicateObservation` (gated on Phase 1 verification)

**Outcome**: Content-hash dedup window removed. UNIQUE constraint is the sole dedup gate. `store.ts` drops to the single INSERT-with-conflict path.

**CRITICAL GATE**: this phase ONLY runs after the gap in reporting block 4 (#2) has been closed: every call site into `storeObservation` provably supplies a real, hook-or-transcript-sourced `tool_use_id`. Before running the `rm` commands below, execute the verification grep AND the integration test described.

### (a) Tasks

**Pre-phase gate (must pass before any deletion):**

- Run `grep -rn "storeObservation(" src/` → enumerate every caller.
- For each caller, trace the `tool_use_id` field back to its source. Must be either (i) the Claude Code hook payload (`tool_use_id` field from `PostToolUse`), (ii) a JSONL transcript line's `tool_use_id`, or (iii) a synthetic-but-stable identifier documented in the caller's comments.
- If any caller has no stable `tool_use_id`, **stop**. Flag to plan owner, keep content-hash fallback, exit this phase.

**If gate passes:**

1. **Delete from `observations/store.ts`**:
   - Line 13 (`DEDUP_WINDOW_MS`).
   - Lines 21–30 (`computeObservationContentHash` export) — **KEEP** the column and the value written into it for analytics, but the function itself is no longer a public export; inline the SHA computation inside `storeObservation` so the column still gets populated on INSERT. Alternative: keep `computeObservationContentHash` as a utility if any caller outside this file uses it (grep first; V14 implies it's only used here).
   - Lines 36–46 (`findDuplicateObservation`).
   - Lines 69–75 (the pre-INSERT dup check block).
2. **Simplify `storeObservation` body** to a single INSERT path (the one added in Phase 1).

### (b) Documentation references

- `05-clean-flowcharts.md` section 3.3 lines 188–189 (deletion ledger).
- Verified-finding **V14** (`06-implementation-plan.md:41`).
- Gap #2 in reporting block 4 above — this phase's gate is the closure mechanism for that gap.

### (c) Verification checklist

- [ ] Grep: `grep -rn "DEDUP_WINDOW_MS\|findDuplicateObservation" src/` → zero hits.
- [ ] Grep: `grep -n "computeObservationContentHash" src/services/sqlite/observations/` → limited to `store.ts` (inline) OR zero external callers.
- [ ] New integration test: simulate two PostToolUse hook payloads with the same content (title+narrative) but different `tool_use_id` → assert **both** observations are persisted (UNIQUE doesn't trigger, content-hash no longer blocks). This validates the coverage shift is correct behavior.
- [ ] New integration test: simulate two PostToolUse hook payloads with the same `(session, tool_use_id)` → assert only one row persists, both return the same id.
- [ ] End-to-end: run the full hook cycle; confirm observations land in DB and no dedup log lines from the deleted path appear.

### (d) Anti-pattern guards

- **E (two dedup paths)**: the WHOLE POINT of this phase. Grep must prove the old path is gone before merge.
- **C**: the UNIQUE constraint raises a conflict, which `ON CONFLICT DO NOTHING` converts to a no-op + SELECT-existing. That's **idempotent**, not silent — the caller gets the existing id. Do not introduce any `try/catch` that swallows the conflict differently.

### Blast radius

`observations/store.ts` shrinks to ~40 lines. If the gate fails and this phase is skipped, content-hash dedup survives harmlessly alongside the UNIQUE constraint (extra work per INSERT, no correctness loss).

**Lines deleted estimate: ~40 from `store.ts` (file goes from 108 → ~65 lines).**

---

## Phase 7 — Final verification

**Outcome**: All six phases above land; regression suite green; anti-pattern greps zero.

### (a) Tasks

1. **Run anti-pattern grep pass** (cite these exact patterns):
   - `grep -rn "DEDUP_WINDOW_MS" src/` → zero (Phase 6).
   - `grep -rn "findDuplicateObservation" src/` → zero (Phase 6).
   - `grep -rn "repairMalformedSchema\|execFileSync.*python" src/services/` → zero (Phase 5).
   - `grep -rn "STALE_PROCESSING_THRESHOLD_MS" src/` → 2 hits max: constant definition + `recoverStuckProcessing` body (Phase 4).
   - `grep -n "status = 'processing'" src/services/sqlite/PendingMessageStore.ts` finds exactly one pending-flip UPDATE, inside `recoverStuckProcessing` (Phase 4).
   - `grep -n "tool_use_id" src/services/sqlite/observations/store.ts` ≥ 2 hits (type + INSERT) (Phase 1).
   - `grep -n "chroma_synced" src/services/sqlite/migrations/runner.ts` finds the Phase 2 migration (Phase 2).
   - `ls src/services/sqlite/schema.sql` exists (Phase 3).
2. **Run tests**:
   - `bun test tests/services/sqlite/` — all existing + new tests green.
   - Specifically: `migration-runner.test.ts` (361 lines, unchanged test set must still pass), `PendingMessageStore.test.ts`, `schema-repair.test.ts` (retargeted to CLI), plus new: `unique-constraint.test.ts`, `boot-recovery.test.ts`, `schema-consistency.test.ts`.
3. **Run fresh-install smoke**:
   - Delete `~/.claude-mem/claude-mem.db`.
   - Boot worker via `npm run build-and-sync`.
   - Assert: `schema.sql` path taken (no Python process, no 19 migration logs on fresh install).
   - Assert: `schema_versions.version = 29` (or whatever the final version is after Phase 2's migration 29 lands).
4. **Run upgrade smoke**:
   - Copy a v6.4.x fixture DB to the live path.
   - Boot worker.
   - Assert: all upgrade migrations through version 29 run; final schema matches `schema.sql`.
5. **Count deleted lines**: `git diff main -- src/services/sqlite/ | grep -c "^-"` should show:
   - ~40 lines from `store.ts` (Phase 6).
   - ~100 lines from `Database.ts` (Phase 5).
   - ~15 lines from `PendingMessageStore.ts` (Phase 4 — net ~0 because `recoverStuckProcessing` is added).
   - Net deletions: **~140 lines** (before counting Phase 3's `schema.sql` which is additive).

### (b) Documentation references

- `05-clean-flowcharts.md` section 3.3 (full).
- `06-implementation-plan.md` Phase 9 (lines 412–448) — superseded-but-aligned.
- `06-implementation-plan.md` Phase 15 (lines 631–655) — final-verification template.

### (c) Verification checklist

- [ ] All anti-pattern greps pass.
- [ ] All tests green.
- [ ] Fresh + upgrade smoke tests pass.
- [ ] Deleted-line count ≥ 140.
- [ ] Downstream plan owners (03, 04, 07) notified that their prerequisites (UNIQUE constraint, `chroma_synced` column, `recoverStuckProcessing`) are available.

### (d) Anti-pattern guards

- **A/B/C/E**: final grep pass is the enforcement.

---

## Summary

- **Phase count**: 7 (matches minimum expected set).
- **Net lines deleted** (estimate, source-only, excluding `schema.sql` which is added): **~140**, split:
  - Phase 5: ~100 lines from `Database.ts` (Python repair).
  - Phase 6: ~40 lines from `observations/store.ts` (dedup window + helper + call block).
  - Phase 4: ~0 net (delete ~13, add ~15 for `recoverStuckProcessing`).
  - Phase 3: 0 from source (migrations stay for upgrade path; `schema.sql` is new).
  - Phases 1, 2: additive only (new migration methods + column + constraint).
- **Top gaps** (see reporting block 4):
  1. `schema.sql` generator must filter FTS5 shadow tables; Phase 3 includes the exact NOT-LIKE filter list, but a new FTS5 virtual table with a non-default suffix in a future migration would break this — needs a convention-lock or a more general regex.
  2. Phase 6 is **gated** by cross-path `tool_use_id` verification (Phase 1's UNIQUE must provably cover the transcript-watcher ingest path, owned by plan `07-session-lifecycle-management`). If transcript-watcher produces synthetic `tool_use_id`s (e.g., `file:offset`) that don't match hook-path IDs, the content-hash gate cannot be removed safely and Phase 6 must be deferred to a follow-up plan.
