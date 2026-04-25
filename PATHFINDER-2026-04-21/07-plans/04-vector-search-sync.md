# Plan 04 — vector-search-sync

**Design authority**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` **section 3.4** (lines 197–229). Bullshit ledger items **#24, #25, #26** (lines 42–44 of `05-clean-flowcharts.md` Part 1). Implementation-plan anchor: `06-implementation-plan.md` **Phase 10** (lines 452–486) and Phase 0 verified findings **V15, V16, V17** (lines 42–44).

**Dependency — upstream (blocker)**: Plan `02-sqlite-persistence` **Phase 2** (`07-plans/02-sqlite-persistence.md:154–190`) adds `observations.chroma_synced INTEGER DEFAULT 0`, `session_summaries.chroma_synced INTEGER DEFAULT 0`, and partial indexes `idx_observations_chroma_synced` / `idx_summaries_chroma_synced`. This plan ASSUMES that column and indexes exist. Do not start Phase 1 here until Plan 02 Phase 2 is merged and migrated on dev.

**Dependency — downstream (consumer)**: Plan `06-hybrid-search-orchestration` consumes this plan's write-path contract "Chroma down at write time → row committed to SQLite with `chroma_synced=0`, logger.warn, no throw", and the read-path contract "search with Chroma disabled returns 503 `chroma_unavailable`, no silent drop" (see `05-clean-flowcharts.md` section 3.6, lines 270–272, bullshit item #32 line 50). Keep both contracts stable.

---

## Sources consulted

- `PATHFINDER-2026-04-21/05-clean-flowcharts.md:197–229` — section 3.4 clean flowchart + deletion ledger.
- `PATHFINDER-2026-04-21/05-clean-flowcharts.md:42–44` — bullshit items #24 #25 #26.
- `PATHFINDER-2026-04-21/05-clean-flowcharts.md:547–548` — Part 5 deletion totals for Chroma (−160 + −160 lines; +60 +40 added).
- `PATHFINDER-2026-04-21/06-implementation-plan.md:42–44` — verified findings V15, V16, V17.
- `PATHFINDER-2026-04-21/06-implementation-plan.md:452–486` — Phase 10 outcome, tasks, verification.
- `PATHFINDER-2026-04-21/01-flowcharts/vector-search-sync.md:1–102` — before-state flowchart.
- `PATHFINDER-2026-04-21/07-plans/02-sqlite-persistence.md:154–190` — chroma_synced migration (Phase 2).
- `src/services/sync/ChromaSync.ts:125–187` — `formatObservationDocs` (granular, multi-doc).
- `src/services/sync/ChromaSync.ts:193–256` — `formatSummaryDocs` (granular, multi-doc).
- `src/services/sync/ChromaSync.ts:262–333` — `addDocuments` + delete-then-add conflict handler.
- `src/services/sync/ChromaSync.ts:339–420` — `syncObservation` / `syncSummary`.
- `src/services/sync/ChromaSync.ts:479–545` — `getExistingChromaIds` metadata scan.
- `src/services/sync/ChromaSync.ts:554–592` — `ensureBackfilled` + `runBackfillPipeline`.
- `src/services/sync/ChromaSync.ts:864–890` — static `backfillAllProjects`.
- `src/services/sync/ChromaSync.ts:903–956` — `updateMergedIntoProject` (kept; uses `chroma_update_documents`).
- `src/services/worker/agents/ResponseProcessor.ts:286–308` — observation call site (fire-and-forget).
- `src/services/worker/agents/ResponseProcessor.ts:380–405` — summary call site (fire-and-forget).
- `src/services/worker-service.ts:470` — boot-time `ChromaSync.backfillAllProjects()` fire-and-forget.

## Concrete findings

- **CRITICAL — no `chroma_upsert_documents` tool exists in the codebase.** Grep of `ChromaSync.ts` for `upsert` returns zero hits. Available MCP tools used today: `chroma_add_documents` (line 284), `chroma_delete_documents` (line 297), `chroma_update_documents` (lines 899, 942, used only for metadata patching in `updateMergedIntoProject`), `chroma_get_documents` (lines 499, 918), `chroma_query_documents`. `chroma_update_documents` *silently ignores missing IDs* (confirmed by the comment at `ChromaSync.ts:293–294`). Therefore a single-call upsert is not available via the current MCP surface.
- **Fallback strategy (documented)**: Replace the write path with "try `chroma_add_documents` first; on `"already exists"` error, call `chroma_delete_documents` then `chroma_add_documents` for that single ID (not the whole batch)." Because the new ID scheme is stable (`obs:<rowid>`, `sum:<rowid>`), conflicts can only occur on legitimate resync — never on organic dedup as before. Keep the branch but collapse it into one helper. Flag: if chroma-mcp ever exposes `chroma_upsert_documents`, replace the add-or-delete+add branch with a single call. Track as a TODO in the code.
- **Write-path is already fire-and-forget** at `ResponseProcessor.ts:286–308` and `:380–405` (`.then().catch()` with `logger.error`, no await). Do not make it blocking. The `chroma_synced=1` UPDATE must run inside the `.then()` arm; the `logger.warn` + leave-flag-0 must run inside the `.catch()` arm.
- **Granularity today**: an observation with narrative + 3 facts = **4** Chroma docs (`narrative` + `text` + `fact_0..fact_N`). A summary with 6 fields populated = **6** docs. Target: 1 doc per row (2 collections, one per doc_type).
- **`getExistingChromaIds` scans *all* metadata for a project** via paged `chroma_get_documents`. On large corpora this is expensive and happens on every worker boot. Replace with `WHERE chroma_synced=0 LIMIT 1000` scan of SQLite.
- **`updateMergedIntoProject` (lines 903–956)** uses `chroma_update_documents` for metadata patching during worktree adoption. That code path is **unrelated** to this plan and must not be touched.
- **Boot-time backfill** is fire-and-forget at `worker-service.ts:470` via static `ChromaSync.backfillAllProjects()`. Swap with instance method `startupBackfillUnsynced()` but keep fire-and-forget.

## Copy-ready snippet locations

| What to copy / cut | From | To |
|---|---|---|
| Replace multi-doc formatter body | `ChromaSync.ts:125–187` (`formatObservationDocs`) | One `formatObservationAsDoc` returning single doc; id `obs:${id}`, text `title + "\n\n" + narrative + "\n\n" + facts.join("\n")`, metadata block kept from lines 134–157. |
| Replace multi-doc formatter body | `ChromaSync.ts:193–256` (`formatSummaryDocs`) | One `formatSummaryAsDoc` returning single doc; id `sum:${id}`, text = all six fields joined with `"\n\n"`, metadata from lines 196–204. |
| Rewrite write path | `ChromaSync.ts:262–333` (`addDocuments` body) | `upsertDoc(doc)` helper: try `chroma_add_documents` with single id; on `"already exist"` call `chroma_delete_documents` then `chroma_add_documents` for that one id. No batch branch; callers pass a single doc. |
| Replace `syncObservation` tail | `ChromaSync.ts:369–377` (`formatObservationDocs` → `addDocuments`) | `const doc = this.formatObservationAsDoc(stored); await this.upsertDoc(doc); await markObservationSynced(observationId);` |
| Replace `syncSummary` tail | `ChromaSync.ts:411–419` (`formatSummaryDocs` → `addDocuments`) | `const doc = this.formatSummaryAsDoc(stored); await this.upsertDoc(doc); await markSummarySynced(summaryId);` |
| Wrap call sites with flag update | `ResponseProcessor.ts:286–308` and `:380–405` | Move `UPDATE observations SET chroma_synced=1 WHERE id=?` inside the helper (Phase 3), not in the call site. Leave the call site's `.catch()` as-is; it already logs. |
| Delete — static full-project scanner | `ChromaSync.ts:864–890` (`backfillAllProjects`) | Replace with instance method `startupBackfillUnsynced()` that does one SELECT LIMIT 1000 and iterates. |
| Delete — metadata scanner | `ChromaSync.ts:479–545` (`getExistingChromaIds`) | Remove entirely after Phase 6 verification passes. |
| Delete — pipeline + per-type backfill | `ChromaSync.ts:554–592` (`ensureBackfilled`, `runBackfillPipeline`) + `backfillObservations/Summaries/Prompts` blocks | Remove after `startupBackfillUnsynced()` replaces them. |
| Boot-site swap | `worker-service.ts:470` (`ChromaSync.backfillAllProjects().then(...)`) | `const sync = this.dbManager.getChromaSync(); sync?.startupBackfillUnsynced().then(...)`. Keep fire-and-forget. |

## Confidence + gaps

- **High**: Flag column exists via Plan 02 Phase 2. Write path is fire-and-forget at call sites. Stable ID scheme is trivial. Granular formatter lines (125–256) can be excised cleanly. `updateMergedIntoProject` is decoupled from this refactor.
- **Medium**: The `"already exists"` string is the only signal of ID conflict today (lines 292–295). If chroma-mcp changes the error message, the delete-then-add branch will silently fall through to the generic error path. Mitigation: match on both `"already exist"` substring and error code if chroma-mcp exposes one (grep on landing day).
- **Gap — unverified MCP assumption**: No `chroma_upsert_documents` tool. Plan commits to delete-then-add fallback. If chroma-mcp adds native upsert post-landing, collapse `upsertDoc` into one call. Flag as TODO at the helper.
- **Gap — prompts**: `backfillPrompts` (`ChromaSync.ts:701`+) and `formatUserPromptDoc` (`:426–438`) already produce one doc per prompt. Keep them; this plan only restructures obs + summary. Verify in Phase 4 that prompt backfill is folded into `startupBackfillUnsynced()` using a `user_prompts.chroma_synced` column (add to Plan 02 Phase 2 or skip — see Phase 4 note below).

---

## Phase 1 — One doc per row: rewrite formatters

### (a) What to implement

- Copy metadata block from `src/services/sync/ChromaSync.ts:134–157` into a new `formatObservationAsDoc(stored): ChromaDocument` that returns exactly one document.
- Copy metadata block from `src/services/sync/ChromaSync.ts:196–204` into a new `formatSummaryAsDoc(stored): ChromaDocument` that returns exactly one document.
- Replace `private formatObservationDocs` (lines 125–187) and `private formatSummaryDocs` (lines 193–256) with these single-doc versions. Delete the `field_type`, per-fact, per-field, and `obs_${id}_narrative` / `obs_${id}_text` / `summary_${id}_request` ID variants.

Observation doc shape:
```ts
{
  id: `obs:${stored.id}`,
  document: [stored.title, stored.narrative, facts.join("\n")]
    .filter(Boolean)
    .join("\n\n"),
  metadata: /* existing baseMetadata block */
}
```

Summary doc shape: id `sum:${stored.id}`, document = `[request, investigated, learned, completed, next_steps, notes].filter(Boolean).join("\n\n")`.

### (b) Docs

- `05-clean-flowcharts.md` section 3.4 (line 203 `Format` node) and deletion ledger line 223.
- Bullshit item **#26** (`05-clean-flowcharts.md:44`).
- Verified finding **V16** (`06-implementation-plan.md:43`).
- Live code: `src/services/sync/ChromaSync.ts:125–256`.

### (c) Verification

- `grep -n "obs_\${" src/services/sync/ChromaSync.ts` → zero.
- `grep -n "summary_\${" src/services/sync/ChromaSync.ts` → zero.
- `grep -nE "field_type|fact_\\\$\\{" src/services/sync/ChromaSync.ts` → zero.
- Unit test: given an observation with narrative + 3 facts, `formatObservationAsDoc` returns 1 doc whose `document` string contains title, narrative, and each fact, separated by `\n\n`, and `id === "obs:<rowid>"`.

### (d) Anti-pattern guards

- **A (Inventing APIs)**: do not add a new class for the single-doc shape — reuse the existing `ChromaDocument` type (already defined at top of `ChromaSync.ts`).
- **C (Silent fallbacks)**: if title is empty AND narrative is empty AND facts is empty, throw — do not produce an empty vector.
- **E (Two code paths)**: delete the multi-doc branches, do not leave them behind a feature flag.

---

## Phase 2 — Replace delete-then-add with upsert-or-fallback

### (a) What to implement

- Cut `private async addDocuments(documents[])` at `src/services/sync/ChromaSync.ts:262–333`.
- Replace with `private async upsertDoc(doc: ChromaDocument): Promise<void>` that:
  1. `await this.ensureCollectionExists();`
  2. Sanitizes metadata (keep the `filter(([_, v]) => v !== null && v !== undefined && v !== '')` pattern from lines 277–281).
  3. Calls `chroma_add_documents` with a single-id payload.
  4. On thrown error whose message matches `/already exist/i`: call `chroma_delete_documents` with `[doc.id]`, then retry `chroma_add_documents`. Log at `info` level.
  5. On any other error: rethrow. The caller (the `.then()`/`.catch()` in Phase 3 or the `ResponseProcessor` fire-and-forget path) logs and sets the flag.
- TODO comment at top of `upsertDoc`: `// TODO: Replace delete+add fallback with chroma_upsert_documents when MCP exposes it.`

### (b) Docs

- `05-clean-flowcharts.md` section 3.4 line 204 (`Upsert` node) and deletion ledger line 222.
- Bullshit item **#25** (`05-clean-flowcharts.md:43`).
- Verified finding **V17** (`06-implementation-plan.md:44`).
- Live code to cut: `src/services/sync/ChromaSync.ts:262–333`.

### (c) Verification

- `grep -nE "chroma_upsert_documents|upsertDoc" src/services/sync/ChromaSync.ts` → `upsertDoc` appears; `chroma_upsert_documents` absent unless chroma-mcp has shipped it.
- Behavioral test: call `upsertDoc({id:"obs:9999", ...})` twice in a row against a live Chroma. Expect: no error, `chroma_count_documents WHERE metadata.sqlite_id=9999` returns 1.
- Behavioral test: rename the collection to a read-only state, call `upsertDoc`. Expect: error propagates, caller's `.catch()` fires.

### (d) Anti-pattern guards

- **A**: do not add a `ChromaUpsertStrategy` class. One helper function.
- **C**: if delete succeeds but re-add fails, rethrow — do not swallow the error and return silently. The caller's `.catch()` path will leave `chroma_synced=0`, and the backfill will retry.
- **D (Facades that pass through)**: do not wrap `chromaMcp.callTool('chroma_add_documents', ...)` in a `ChromaClient.add()` method — call `callTool` directly inside `upsertDoc`.

---

## Phase 3 — Write path sets `chroma_synced=1` on success

### (a) What to implement

- In `SessionStore` (or nearest matching store file — grep for `prepareStatement('UPDATE observations SET ')` to confirm location before editing), add two 1-line helpers: `markObservationSynced(id: number)` → `UPDATE observations SET chroma_synced=1 WHERE id=?`; and `markSummarySynced(id: number)` likewise against `session_summaries`. Use `db.prepare().run(id)` pattern already used by the store.
- In `ChromaSync.syncObservation` (`ChromaSync.ts:339–378`), replace the existing tail (`formatObservationDocs` + `addDocuments`) with:
  ```ts
  const doc = this.formatObservationAsDoc(stored);
  await this.upsertDoc(doc);
  markObservationSynced(observationId);
  ```
  Wrap the above in a `try`: on throw, `logger.warn('CHROMA_SYNC', 'obs sync failed, flag stays 0', {id: observationId}, err)` and **rethrow** so the `ResponseProcessor.ts:286–308` `.catch()` still fires (it logs at error level — do not lose that log).
- Same pattern for `syncSummary` (`ChromaSync.ts:384–420`) with `markSummarySynced`.
- Leave the `ResponseProcessor` call site alone — the existing `.then()/.catch()` is correct.

### (b) Docs

- `05-clean-flowcharts.md` section 3.4 lines 205–209 (OK branch → `Mark`; fail branch → `LogFail`).
- Bullshit item **#24** (`05-clean-flowcharts.md:42`).
- Phase 10 task 3 (`06-implementation-plan.md:467`).
- Anti-pattern **C** (`06-implementation-plan.md:63`): "On Chroma failure at write time, do not throw — leave flag 0".
- Live call sites: `src/services/worker/agents/ResponseProcessor.ts:286–308` (obs) and `:380–405` (summary).

### (c) Verification

- Functional test: Chroma enabled, worker running, send one observation → after 1 s, `SELECT chroma_synced FROM observations WHERE id=<new>` returns `1`.
- Functional test: Stop Chroma subprocess (kill chroma-mcp), send one observation → SQLite row commits, `chroma_synced=0`, `logger.warn` line emitted. No 500 to the hook.
- Start Chroma again, restart worker. Phase 4's `startupBackfillUnsynced()` upserts the row; flag flips to `1`.
- `grep -n "chroma_synced=1\\|chroma_synced = 1" src/services/` → finds only the two new `mark*Synced` statements.

### (d) Anti-pattern guards

- **C (Silent fallbacks)**: the `logger.warn` call must include `obsId`, `project`, and the error message — never a bare "sync failed".
- **E**: do not set the flag inside the `.then()` arm at the call site. The store update lives in `ChromaSync`, one place.
- **A**: no `SyncStateMachine`, no `ChromaSyncResult` enum. Boolean column + throw-on-fail is enough.

---

## Phase 4 — Replace backfill trio with `startupBackfillUnsynced()`

### (a) What to implement

- Add instance method on `ChromaSync`:
  ```ts
  async startupBackfillUnsynced(limit = 1000): Promise<void> {
    const db = new SessionStore();
    try {
      const obsRows = db.db.prepare(
        'SELECT id FROM observations WHERE chroma_synced = 0 LIMIT ?'
      ).all(limit) as { id: number }[];
      for (const { id } of obsRows) { /* load, formatObservationAsDoc, upsertDoc, markObservationSynced — swallow per-row errors */ }
      const sumRows = db.db.prepare(
        'SELECT id FROM session_summaries WHERE chroma_synced = 0 LIMIT ?'
      ).all(limit) as { id: number }[];
      for (const { id } of sumRows) { /* same pattern */ }
    } finally {
      db.close();
    }
  }
  ```
- Per-row `try/catch`: a single failed upsert must not abort the whole backfill. Logger.warn per failure; leave flag 0.
- In `src/services/worker-service.ts:470`, replace `ChromaSync.backfillAllProjects().then(...)` with `this.dbManager.getChromaSync()?.startupBackfillUnsynced().then(...).catch(...)`. Keep fire-and-forget.
- Delete `static async backfillAllProjects()` (`ChromaSync.ts:864–890`), `ensureBackfilled` (`:554–573`), `runBackfillPipeline` (`:575–592`), `backfillObservations`, `backfillSummaries`, `backfillPrompts`.
- **Prompts note**: if `user_prompts.chroma_synced` column is not added by Plan 02 Phase 2, then either (a) extend Plan 02 Phase 2 to include it, or (b) keep `formatUserPromptDoc`-based one-shot backfill for prompts only and mark as a follow-up. Do not block Phase 4 on this — flag it and continue.

### (b) Docs

- `05-clean-flowcharts.md` section 3.4 lines 211–212 (`BootOnce` → `CheckUnsync` → `LoopBackfill`).
- Deletion ledger lines 220, 224.
- Phase 10 task 4 (`06-implementation-plan.md:468`).
- Live code to cut: `src/services/sync/ChromaSync.ts:554–592`, `:864–890`, and `backfillObservations/Summaries/Prompts` helper bodies (currently inside the 600–860 range).
- Boot call site: `src/services/worker-service.ts:470`.

### (c) Verification

- `grep -n "backfillAllProjects\|ensureBackfilled\|runBackfillPipeline" src/` → zero.
- Functional test: Insert 5 observations while Chroma is down. Restart worker. Within 10 s, all 5 rows have `chroma_synced=1` and Chroma collection shows 5 docs with ids `obs:<id>`.
- Functional test: Set 1001 rows to `chroma_synced=0`. Restart worker. Exactly 1000 rows flip to `1` after boot backfill; the 1001st stays `0` until next boot (LIMIT 1000 is intentional — document this).
- Log check: `CHROMA_SYNC` logger emits one `"startup backfill complete"` info line per boot with counts.

### (d) Anti-pattern guards

- **A**: no `BackfillScheduler`, no `cron`, no second setInterval. One boot call, fire-and-forget.
- **B (Polling where events exist)**: the existing 5-s rescan or per-startup metadata scan are the exact pollers being removed — do not add a retry timer here.
- **E**: `startupBackfillUnsynced` must use `upsertDoc` and `formatObservationAsDoc` from Phases 1–2. Do not write a parallel fast path.

---

## Phase 5 — Delete `getExistingChromaIds` metadata scan

### (a) What to implement

- Delete `private async getExistingChromaIds(projectOverride?: string)` at `src/services/sync/ChromaSync.ts:479–545` and every call site (only call today is from the now-deleted `ensureBackfilled`).
- **Precondition**: Phase 4 must be landed and its verification passing. This phase is the cleanup sweep.
- **Do NOT delete** in the same PR as Phase 4 unless the targeted `WHERE chroma_synced=0` backfill has been proven in staging to cover missing-doc recovery. Keep `getExistingChromaIds` dead-code-fenced with an `@deprecated` JSDoc for one release if there is any concern.

### (b) Docs

- `05-clean-flowcharts.md:221` ("`getExistingChromaIds` metadata index scan (~80 lines)").
- Verified finding **V17** (`06-implementation-plan.md:44`).
- Live code to cut: `src/services/sync/ChromaSync.ts:479–545`.

### (c) Verification

- `grep -n "getExistingChromaIds" src/` → zero.
- No change in functional behavior vs. end of Phase 4 — this is a pure deletion.
- Re-run Phase 4 functional tests; all pass.

### (d) Anti-pattern guards

- **D (Facades that pass through)**: confirm no caller besides `ensureBackfilled` existed (grep both `ChromaSync.ts` and test files).
- **A**: do not replace with a `getSyncedIds` helper. The SQLite flag is source of truth now.

---

## Phase 6 — Verification gates

### (a) What to implement

Pure test/verification phase. No source edits.

1. **Chroma doc-count = one per obs row**:
   - Fresh DB + Chroma. Insert 20 observations. Wait for sync.
   - `SELECT COUNT(*) FROM observations WHERE chroma_synced=1` → 20.
   - `chroma_count_documents(cm__claude-mem)` → 20 (not 60–100 as before).

2. **Idempotent re-sync**:
   - For existing observation id 42 (`chroma_synced=1`): call `syncObservation(42, ...)` again (simulate worktree adoption touch-up).
   - Expect: no error, Chroma still has exactly one doc with id `obs:42`, SQLite flag still `1`.

3. **Chroma-down write path**:
   - Stop chroma-mcp subprocess. Insert 5 observations via hook.
   - SQLite rows commit, `chroma_synced=0` for all 5, `logger.warn` emitted 5 times.
   - Restart Chroma, restart worker. Within 10 s: 5 rows flip to `1`, Chroma has 5 docs with ids `obs:<id>`.

4. **Downstream contract smoke** (for Plan 06):
   - With Chroma disabled (`CLAUDE_MEM_CHROMA_ENABLED=false`), new observations commit with `chroma_synced=0` and no warn spam.
   - Search path (Plan 06's 503 contract): not tested here — plan 06 owns that test.

5. **Grep gates** (all must return zero):
   - `grep -nE "formatObservationDocs|formatSummaryDocs" src/`
   - `grep -nE "backfillAllProjects|ensureBackfilled|runBackfillPipeline|getExistingChromaIds" src/`
   - `grep -nE "obs_\\\$\\{|summary_\\\$\\{|field_type" src/services/sync/`
   - `grep -n "addDocuments" src/services/sync/` (should show only the new `upsertDoc` name).

### (b) Docs

- `06-implementation-plan.md:473–476` (Phase 10 verification list).
- `05-clean-flowcharts.md:228` (effect: ~70% index shrink).

### (c) Verification

- All grep gates green.
- All four functional tests pass in CI.
- Chroma on-disk size (`du -sh ~/.claude-mem/chroma`) drops vs. pre-landing baseline (expected ~70% reduction after a full reindex; partial if tests only rebuild a fraction).

### (d) Anti-pattern guards

- **C**: the idempotent re-sync test catches silent divergence (doc count != row count).
- **E**: the grep gates catch any stray code path left behind.

---

## Blast radius

- **Index regenerates under new doc shape**: users on an upgrade path see the old index until `startupBackfillUnsynced()` catches up. On a large corpus (10k+ observations) with a 1000-row limit per boot, full reindex takes ~10 worker restarts or a one-time `claude-mem reindex` CLI (out of scope for this plan — file follow-up).
- **Breaking ID change** (`obs_42_narrative` → `obs:42`): any caller that had hard-coded the old ID scheme (there are none in this repo — grep) would break. Third-party search tools reading Chroma directly would also break; document in changelog.
- **Metadata field removal**: `field_type` and `fact_index` disappear from Chroma metadata. If the viewer UI or search filters depend on these, Plan 06 must absorb the change. Grep `src/` for `field_type` and `fact_index` before merging.

## Estimated deletion

Matches the Part-5 ledger entry "Chroma silent-fallback + 90-day filter + granular docs + delete-then-add" (`-220 +60`) plus "Chroma backfill full-project scan" (`-200 +40`). Net for this plan alone: **~-320 lines** (not counting test churn).
