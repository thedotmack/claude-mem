# Plan: Remove the entire duplicate SQLite stack + rewrite its tests against the shipping path

**Scope:** `src/services/sqlite/` — delete the dead duplicate DB/migration stack AND the parallel
free-function CRUD API it propped up. Delete every test coupled to that duplicate and write fresh tests
against `SessionStore` (the path the worker actually runs). Out of scope: installer unification,
SearchManager dedup (separate plans).

**Philosophy (per maintainer):** Do NOT adapt old tests written against the dead abstraction — that's
busywork. **Delete them, write new ones** against `SessionStore`. The old tests' value is their
*behavior checklist*, not their code; that checklist is captured in Phase 1.

**Goal:** Remove ~3,000+ src lines of duplication, zero production behavior change, and replace
~2,300 lines of misdirected tests with a smaller, focused suite that exercises the real worker path.

**Why this exists:** Two parallel SQLite systems live in `src/services/sqlite/`:
- **Shipping (KEEP):** `SessionStore` — the worker does `new Database(DB_PATH)` → `new SessionStore(db)`,
  and SessionStore's constructor runs its own inline imperative migrations. All production reads/writes
  go through `SessionStore` *methods*.
- **Dead duplicate (DELETE):** `ClaudeMemDatabase` → `MigrationRunner` (a second, drifted migration
  engine) **plus** a free-function CRUD API (`Sessions.ts`/`Observations.ts`/… barrels + submodules +
  `transactions.ts`) that re-implements the SessionStore methods. Reachable only from tests.

---

## Phase 0 — Ground Truth (verified by 6 discovery agents + direct grep; re-confirm gates as you go)

### Shipping path (KEEP, never touch)
- `src/services/worker/DatabaseManager.ts:17-32` → `new Database(DB_PATH)` then `new SessionStore(this.db)`.
- `SessionStore` ctor (`SessionStore.ts:34`, chain ~49-73) runs the inline migrations (schema_versions 4-32).
- CLI server: `worker-service.ts:855` opens `new Database(DB_PATH,…)` — also no `MigrationRunner`/`ClaudeMemDatabase`.
- **The worker never imports `ClaudeMemDatabase`, `MigrationRunner`, `getDatabase`, `initializeDatabase`,
  the `services/sqlite/index.ts` barrel, or the free-function CRUD API.** Production's only direct
  imports into the free-fn tree are 5 helper functions (see keep-set below).

### SessionStore API the new tests will call (verified signatures)
Constructor: `constructor(dbPathOrDb: string | Database = DB_PATH)` — accepts `':memory:'` AND a raw
bun:sqlite `Database` (adopts it, then migrates → use this to seed a legacy schema first). Public raw
handle: `store.db`. Has `close()`.

| Domain | Method (SessionStore.ts line) |
|---|---|
| Sessions | `createSDKSession(contentSessionId, project, userPrompt, customTitle?, platformSource?): number` (1692); `updateMemorySessionId(sessionDbId, memId\|null)` (1030); `markSessionCompleted(sessionDbId)` (1038); `ensureMemorySessionIdRegistered(sessionDbId, memId, workerPort?)` (1048); `getSessionById(id)` (1624) |
| Observations | `storeObservation(memId, project, observation{type,title,subtitle,facts[],narrative,concepts[],files_read[],files_modified[],agent_type?,agent_id?,metadata?}, promptNumber?, discoveryTokens?, overrideTimestampEpoch?, generatedByModel?): {id,createdAtEpoch}` (1781); `storeObservations(memId, project, observations[], summary\|null, promptNumber?, …): {observationIds[],summaryId,createdAtEpoch}` (1901); `getObservationById(id)` (1475) |
| Summaries | `storeSummary(memId, project, summary{request,investigated,learned,completed,next_steps,notes}, promptNumber?, …): {id,createdAtEpoch}` (1855); `getSummaryForSession(memId)` (1555) |
| Prompts | `saveUserPrompt(contentSessionId, promptNumber, promptText): number` (1754); `getPromptNumberFromUserPrompts(contentSessionId): number` (1685); `findRecentDuplicateUserPrompt(contentSessionId, promptText, windowMs)` (1406) |

3 old free-functions have **no** SessionStore method — new tests that need them import the leaf
function and pass `store.db`: `computeObservationContentHash` (`observations/store.ts:8`),
`getFirstObservationCreatedAt` (`observations/recent.ts:36`), `getObservationsByFilePath`
(`observations/get.ts:97`). All three are in the keep-set anyway.

**Test gotchas (from source, save debugging time):**
- `getSessionSummaryById` class method (SessionStore.ts:2435) queries non-existent columns → **throws**; don't call it (it's deleted in Phase 5 regardless).
- `getRecentObservations` reads the legacy `text` column → NULL for rows written by `storeObservation`. Assert content via `getObservationById` (`title`/`subtitle`/`narrative`), not `text`.
- Empty-project guard (`project || cwd-derived`) exists only in leaf `observations/store.ts`, **not** in `SessionStore.storeObservation`/`.storeObservations`. The worker path stores empty project as-is. Test the leaf for the guard; don't assert it on SessionStore.
- `pending_messages` has no SessionStore store method — seed via raw `store.db.prepare(INSERT…)`. For the cleanup test, observer cascade needs `memory_session_id` set: `createSDKSession` inserts NULL, so call `updateMemorySessionId(id,'obs-memory-N')` before `storeObservation`.

### Dead duplicate — DELETE (all production-dead, grep-confirmed)
1. **DB/migration stack:** `Database.ts` (`ClaudeMemDatabase`, the sqlite `DatabaseManager` singleton —
   NOT the worker's, `getDatabase`, `initializeDatabase`, `Migration`), `migrations/runner.ts`
   (`MigrationRunner`, 1147 lines), `index.ts` (barrel, 0 importers), and `SchemaRepair`
   (`openWithSchemaRepair`, imported only by `Database.ts`).
2. **Free-function CRUD API:** all 6 barrels + submodule files + `transactions.ts` (see keep/delete map).
   `transactions.ts` confirmed dead: 0 direct prod importers; worker uses `sessionStore.storeObservations`.
3. **Dead SessionStore methods:** `getSessionSummaryById` (2435-2476, dead+broken),
   `storeObservationsAndMarkComplete` (2017-2143, 0 call sites — `.storeObservationsAndMarkComplete(` greps to zero).

### Free-function tree — KEEP/DELETE map
**KEEP (5 files, trimmed to ONLY the live export — production imports these directly):**

| File | Keep ONLY | Live importer |
|---|---|---|
| `observations/store.ts` | `computeObservationContentHash` | SessionStore.ts:15 |
| `observations/files.ts` | `parseFileList` | SessionStore.ts:16, ChromaSync.ts:7 |
| `observations/get.ts` | `getObservationsByFilePath` | DataRoutes.ts:17 |
| `observations/recent.ts` | `getFirstObservationCreatedAt` | DataRoutes.ts:18 |
| `prompts/get.ts` | `findRecentDuplicateUserPrompt` | SessionStore.ts:18 |

Each survivor's only in-tree dep is a type-only `./types.js` import; after trimming, those type imports
become removable (the survivors use types from `../../../types/database.js`, out of tree). Net: keep 5
function bodies, drop their `./types.js` import lines.

**DELETE ENTIRELY (18 files — only importers are the dead barrels/index/tests):**
```
Observations.ts Sessions.ts Summaries.ts Prompts.ts Timeline.ts Import.ts   # 6 barrels
transactions.ts
sessions/create.ts sessions/get.ts sessions/types.ts
summaries/store.ts summaries/get.ts summaries/recent.ts summaries/types.ts
prompts/store.ts prompts/types.ts
timeline/queries.ts
import/bulk.ts
```
`sessions/`, `summaries/`, `timeline/`, `import/` dirs become empty → remove.

### The one risk — CONFIRMED SAFE
Server tables (`projects`, `server_sessions`, `memory_items`, `teams`, `api_keys`, `audit_log`, …) are
created by `ensureServerStorageSchema` (`src/storage/sqlite/schema.ts:21-305`), called from 13 live
server-repo sites — **not** by `MigrationRunner`. Deleting the duplicate doesn't touch them.

### Anti-pattern guards (every phase)
- ❌ Never delete a `src/services/sqlite/` file before grepping its direct importers (excluding the dead `index.ts`).
- ❌ Don't touch `worker/DatabaseManager.ts`, SessionStore's migration chain, or `src/storage/sqlite/*`.
- ❌ Don't write new tests against the leaf free-functions where a SessionStore method exists — the worker uses methods; test the method. (Exceptions: the 3 leaf-only helpers above.)
- ❌ Don't port schema-repair or MigrationRunner-version-specific assertions — those test code the worker never runs.

---

## Phase 1 — Write NEW tests against `SessionStore` (FIRST, so coverage exists before any deletion)

These must pass against the **current** tree (SessionStore + the 5 survivor leaf functions all exist now).
They become the regression guard for Phases 2-5. New-file layout + behavior spec (KEEP items from the
old suites, retargeted):

**`tests/sqlite/session-store-observations.test.ts`** — `new SessionStore(':memory:')`
- store returns `{id>0, createdAtEpoch>0}`; all fields round-trip via `getObservationById`
- `overrideTimestampEpoch` honored (epoch + ISO); default = now when omitted
- null subtitle/narrative stored OK; `getObservationById` returns null for missing id
- subagent: `agent_type`/`agent_id` stored when provided; default NULL when omitted; `agent_type` alone OK
- `getFirstObservationCreatedAt(store.db)` → null when empty, earliest ISO otherwise (leaf import)

**`tests/sqlite/session-store-dedup.test.ts`**
- `computeObservationContentHash` (leaf import): deterministic, 16 chars, different content→different hash, null title/narrative OK, no field-boundary collision (`\x00` separator → 4 distinct hashes — keep verbatim)
- identical `(memId,title,narrative)` dedupes to same id regardless of time gap (collapse the old two "30s window" tests into ONE — dedup is the UNIQUE index, not time-based)
- different content at same timestamp → distinct ids; `content_hash` populated (16 chars) on new rows
- `storeObservations` batch: 3 identical inputs → 3 equal ids, 1 physical row (real worker hot path)
- dedup unaffected by agent fields: 2nd insert w/ different `agent_type` returns existing id, count stays 1, original agent fields preserved
- (optional, leaf) empty-project guard on `observations/store.ts` leaf only — note SessionStore stores empty as-is

**`tests/sqlite/session-store-sessions.test.ts`**
- `createSDKSession` → id>0; idempotent (same content_session_id→same id); different→different
- persisted `user_prompt` tag-stripped + bounded to `MAX_STORED_PROMPT_CHARS` ending `…`
- `getSessionById` round-trips fields; `memory_session_id` defaults null; null for missing
- `custom_title`: stored at creation; defaults null; backfilled on idempotent call if unset; not overwritten if set; empty→null
- `platform_source`: defaults `'claude'`; preserves non-default when legacy caller omits it; throws `/Platform source conflict/` on explicit conflict
- `updateMemorySessionId` sets + allows re-update to different value

**`tests/sqlite/session-store-prompts.test.ts`**
- `saveUserPrompt` → id>0, incrementing, distinct across sessions; prompt_text tag-stripped + bounded
- `findRecentDuplicateUserPrompt` finds dup in window (id/prompt_number/prompt_text)
- `getPromptNumberFromUserPrompts`: 0 when none; counts; session-isolated; handles 100 prompts

**`tests/sqlite/session-store-summaries.test.ts`**
- `storeSummary` → `{id>0,createdAtEpoch>0}`; all fields + `prompt_number` round-trip via `getSummaryForSession`
- `overrideTimestampEpoch` honored; default = now; null notes preserved
- `getSummaryForSession`: by memId; null when none; returns MOST RECENT when multiple

**`tests/sqlite/session-store-transactions.test.ts`** — target `sessionStore.storeObservations` (the real path)
- stores N atomically → ids + null summaryId when no summary; correct `createdAtEpoch`
- all observations in a batch share one timestamp
- observations + summary together → summaryId non-null, summary retrievable
- empty observations array → 0 ids, null summary; summary-only → 0 ids, summaryId set
- `promptNumber` applied to all in batch
- **DROP** the old `storeObservationsAndMarkComplete` queue-delete/rollback tests — that path is dead (worker completes via `SessionCompletionHandler`, not this function)

**`tests/sqlite/session-store-migrations.test.ts`** — seed legacy via `new Database(':memory:')` then `new SessionStore(rawDb)`
- legacy NULL `content_hash` rows → rewritten to `__null_migration_<id>__` (preserved), non-NULL dups deduped to one, `ux_observations_session_hash` UNIQUE index created (this is SessionStore's v29 `addObservationsUniqueContentHashIndex`; the existing data-integrity "Migration parity" test is the canonical source — port it here)
- idempotency: constructing SessionStore twice over the same db → no throw, identical schema/version set, data unchanged
- fresh-DB init creates SessionStore's core tables (`schema_versions, sdk_sessions, observations, session_summaries, user_prompts, pending_messages`) — assert SessionStore's tables, NOT MigrationRunner's server tables
- (optional) `PRAGMA foreign_key_list` shows `on_update=CASCADE,on_delete=CASCADE` on a fresh SessionStore db
- (optional) seed a legacy `pending_messages` with `retry_count`/`completed_at_epoch`/`worker_pid` → SessionStore drops them (v31/v32)
- **DROP:** MigrationRunner-only server tables (v33/34), specific cross-stack version-number lists, mig-24 drift, #979 old-DatabaseManager conflicts, crash-recovery `_new` temp tables

**`tests/infrastructure/cleanup-v12_4_3.test.ts`** — REWRITE in place: reseed `seedDatabase` via `new SessionStore(dbPath)` + methods (raw `store.db` INSERT for `pending_messages` only). All behaviors KEEP:
- missing DB → marker `skipped:'no-db'`, null backupPath, zero counts
- purges observer sessions (`OBSERVER_SESSIONS_PROJECT`) + cascade rows, purges stuck pending (`COUNT>=10`), wipes chroma dir + sync-state, writes backup; real-project rows survive
- pending preserved when stuck count < 10 (9 survives); idempotent (2nd run no-ops, no 2nd backup)
- proceeds on non-credible `statfsSync` (bsize=0) with WARN containing 'non-credible' `{bsize:0}` (keep the spy assertion)
- honors `CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1` (exits, no marker, observer intact)

**Verify Phase 1:** `bun test tests/sqlite/session-store-*.test.ts tests/infrastructure/cleanup-v12_4_3.test.ts` → all green against the current tree. New tests must import ONLY `SessionStore` + the 5 survivor leaf functions — grep them to confirm no import of a to-be-deleted barrel/`transactions.ts`.

---

## Phase 2 — Delete the old tests coupled to the dead stack
```
rm tests/sqlite/observations.test.ts tests/sqlite/transactions.test.ts \
   tests/sqlite/sessions.test.ts tests/sqlite/prompts.test.ts \
   tests/sqlite/summaries.test.ts tests/sqlite/data-integrity.test.ts \
   tests/services/sqlite/observations/store-subagent-label.test.ts \
   tests/services/sqlite/migration-runner.test.ts \
   tests/services/sqlite/schema-repair.test.ts
```
(`schema-repair.test.ts` has NO replacement — it tests `ClaudeMemDatabase.openWithSchemaRepair`, which the worker never uses.)
**Verify:** `grep -rn "ClaudeMemDatabase\|MigrationRunner\|runAllMigrations\|sqlite/transactions\|sqlite/Sessions\|sqlite/Observations" tests/` → ZERO. `bun test tests/` green (new suite carries the coverage).

---

## Phase 3 — Delete the dead DB/migration stack
**Gate:**
```
grep -rn "from .*services/sqlite/Database" src/ --include=*.ts | grep -v "Database.ts:"   # ZERO
grep -rn "services/sqlite/index" src/ tests/ --include=*.ts                                # ZERO
grep -rn "ensureServerStorageSchema" src/ --include=*.ts                                    # 13 callers, none in runner.ts
```
```
rm src/services/sqlite/Database.ts src/services/sqlite/migrations/runner.ts src/services/sqlite/index.ts
rmdir src/services/sqlite/migrations
grep -rn "SchemaRepair\|openWithSchemaRepair" src/ --include=*.ts   # expect ZERO after Database.ts gone
rm src/services/sqlite/SchemaRepair.ts   # use actual path from grep; only if zero importers
```
**Verify:** `bunx tsc --noEmit` — no dangling imports.

---

## Phase 4 — Delete the duplicate free-function CRUD API + trim survivors
**Gate (per group, must be zero non-barrel/non-test importers):**
```
grep -rn "sqlite/transactions\|sqlite/Sessions\|sqlite/Observations\|sqlite/Summaries\|sqlite/Prompts\|sqlite/Timeline\|sqlite/Import" src/ --include=*.ts
grep -rn "sessions/create\|sessions/get\|summaries/store\|summaries/get\|summaries/recent\|prompts/store\|timeline/queries\|import/bulk" src/ --include=*.ts
```
**Delete (18 files):**
```
rm src/services/sqlite/{Observations,Sessions,Summaries,Prompts,Timeline,Import}.ts
rm src/services/sqlite/transactions.ts
rm src/services/sqlite/sessions/{create,get,types}.ts
rm src/services/sqlite/summaries/{store,get,recent,types}.ts
rm src/services/sqlite/prompts/{store,types}.ts
rm src/services/sqlite/timeline/queries.ts src/services/sqlite/import/bulk.ts
rmdir src/services/sqlite/sessions src/services/sqlite/summaries src/services/sqlite/timeline src/services/sqlite/import
```
**Trim the 5 survivor files** to keep only the live export + remove their now-dead `./types.js` imports:
```
observations/store.ts  → keep computeObservationContentHash; delete storeObservation; drop ./types.js import
observations/files.ts  → keep parseFileList; delete getFilesForSession; drop ./types.js import
observations/get.ts    → keep getObservationsByFilePath; delete getObservationById/getObservationsByIds/getObservationsForSession; drop ./types.js import
observations/recent.ts → keep getFirstObservationCreatedAt; delete getRecentObservations/getAllRecentObservations; drop ./types.js import
prompts/get.ts         → keep findRecentDuplicateUserPrompt; delete the other 7 prompt getters; drop ./types.js import (it uses LatestPromptResult from ../../../types/database.js)
```
Then `observations/types.ts` and `prompts/types.ts` should have no remaining consumer → `grep` and delete if zero.
**Verify:** `bunx tsc --noEmit` clean; `bun test tests/sqlite/` green. Confirm the 5 live anchors still resolve (SessionStore.ts:15/16/18, ChromaSync.ts:7, DataRoutes.ts:17/18).

---

## Phase 5 — Delete the dead SessionStore methods
**Gate:** `grep -rn "\.getSessionSummaryById(\|\.storeObservationsAndMarkComplete(" src/ tests/ --include=*.ts` → ZERO
(the standalone `sessions/get.ts:getSessionSummaryById` is already deleted in Phase 4; the live one is gone with it — confirm nothing else references either name).
**Delete (higher range first to keep line numbers):**
1. `SessionStore.ts` lines **2435-2476** (`getSessionSummaryById`)
2. `SessionStore.ts` lines **2017-2143** (`storeObservationsAndMarkComplete`)
**Verify:** `bunx tsc --noEmit` clean; `bun test tests/` green.

---

## Phase 6 — Final verification gate
1. `npm run build-and-sync` — succeeds, worker restarts.
2. Worker boots + migrates a **fresh** DB (temp `~/.claude-mem` path) — no errors in worker log.
3. Worker migrates a **seeded legacy v22** DB without error (reuse the Phase 1 migrations-test seed helper).
4. `bun test` — full suite green.
5. `bunx tsc --noEmit` — no dangling imports of `ClaudeMemDatabase`, `MigrationRunner`, `getDatabase`, `initializeDatabase`, `Database.ts`, `SchemaRepair`, any deleted barrel/submodule, or the two SessionStore methods.
6. Dead-reference sweep: `grep -rn "ClaudeMemDatabase\|MigrationRunner\|sqlite/Database\|sqlite/index\|sqlite/transactions\|sqlite/migrations" src/ tests/ --include=*.ts` → ZERO.

**Done when:** all 6 pass; the only migration engine + CRUD API in the tree is `SessionStore`; the new
`session-store-*` suite covers the shipping behaviors; the 5 leaf helpers remain for their prod callers.

---

## Line accounting (approx)

| Delete (src) | Lines |
|---|---:|
| `migrations/runner.ts` | 1147 |
| `Database.ts` | 211 |
| `index.ts` | 22 |
| `SchemaRepair.ts` (orphaned) | ~? |
| free-fn CRUD API (18 files) | ~1,500 |
| survivor trims | ~150 |
| SessionStore dead methods | 169 |
| **src subtotal** | **~3,200** |

| Tests | Lines |
|---|---:|
| old suites deleted (9 files) | ~2,340 |
| new `session-store-*` suites added | ~+1,000 |
| **test net** | **~−1,340** |

**Net: ~−4,500 lines, zero production behavior change, real path now directly tested.**

## Execution order rationale
New tests first (Phase 1) → they pass on the current tree and guard every subsequent deletion. Old
tests next (Phase 2) → nothing then references the duplicate. Then peel the duplicate in dependency
order: DB stack (3) → free-fn API + survivor trim (4) → dead methods (5) → gate (6). The suite stays
green at every step.
