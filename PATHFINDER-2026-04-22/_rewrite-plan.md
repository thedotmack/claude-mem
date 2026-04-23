# PATHFINDER-2026-04-22 Rewrite Plan

**Purpose**: Execute a clean rewrite of the claude-mem refactor corpus, replacing `PATHFINDER-2026-04-21/` with a principle-driven 8-plan corpus. Each phase can be executed consecutively in a fresh chat context.

**Inputs** (already in this directory):
- `_reference.md` — verified current-code anchors + external API signatures
- `_mapping.md` — section-by-section migration map from old → new

**Outputs** (to be produced by executing this plan):
- `00-principles.md` — unifying criteria every plan is measured against
- `01-data-integrity.md` — UNIQUE constraints, idempotency, self-healing claim
- `02-process-lifecycle.md` — delete supervisor, lazy-spawn, process groups
- `03-ingestion-path.md` — fail-fast parser, direct ingest, recursive fs.watch
- `04-read-path.md` — 1 renderer, 1 search path, delete SearchManager.findBy*
- `05-hook-surface.md` — fail-loud hooks, blocking endpoint, cached alive
- `06-api-surface.md` — Zod middleware, delete diagnostic endpoints
- `07-dead-code.md` — TranscriptParser class, migration 19, @deprecated sweep
- `98-execution-order.md` — DAG + preflight gates + post-landing greps
- `99-verification.md` — grep targets, acceptance criteria, viewer lockdown

**Target lines deleted across the corpus**: ~3,800 LoC net, after double-count correction.

---

## Global principles (cite in every plan)

1. **No recovery code for fixable failures.** If the primary path is correct, recovery never runs. If it's broken, recovery hides the bug.
2. **Fail-fast over grace-degrade.** Local code does not circuit-break, coerce, or silently fall back. It throws and lets the caller decide.
3. **UNIQUE constraint over dedup window.** DB schema prevents duplicates; don't time-gate them.
4. **Event-driven over polling.** `fs.watch` over `setInterval` rescan. Server-side wait over client-side poll. `child.on('exit')` over periodic scan.
5. **OS-supervised process groups over hand-rolled reapers.** `detached: true` + `kill(-pgid)` replaces orphan sweeps.
6. **One helper, N callers.** Not N copies of a helper. Not a strategy class for each config.
7. **Delete code in the same PR it becomes unused.** No `@deprecated` fence, no "remove next release."

These are repeated verbatim in `00-principles.md`. Every other plan cites them.

---

## Anti-pattern guards (check in every plan)

- No new `setInterval` in `src/services/worker/` or the plan text (plan 99 greps for this)
- No new `coerce*`, `recover*`, `heal*`, `repair*`, `reap*`, `kill*Orphans*` function names
- No new try/catch that swallows errors and returns a fallback value
- No new schema column whose only purpose is to feed a recovery query
- No new strategy class when a config object would do
- No new HTTP endpoint for diagnostic / manual-repair purposes

---

## Phase 0 — Documentation discovery (DONE)

**Status**: Complete. See `_reference.md` (API + code anchors) and `_mapping.md` (old→new section mapping). Phase 0 subagents verified 12 old plans, every audit-cited file:line, every external API in use.

---

## Phase 1 — Write `00-principles.md`

**Task**: Draft the principles document that every other plan cites.

**Sections**:
1. The seven principles (copy verbatim from "Global principles" section above)
2. The six anti-pattern guards (copy verbatim from "Anti-pattern guards" above)
3. The unifying diagnosis (one paragraph): missing primary-path correctness gets papered over with defensive code; defensive code hides bugs in the primary path; hidden bugs spawn more defensive code. Same disease, five organs.
4. Five cures table: one row per subsystem (lifecycle, data, search, ingestion, hooks) stating the concrete cure from the principles.
5. Glossary: "second-system effect," "lease pattern," "self-healing claim," "fail-fast contract" — one-sentence definitions with the canonical example.

**Doc refs**: none outside this plan — `00-principles.md` is the anchor every other plan cites.

**Verification**:
- [ ] File exists at `PATHFINDER-2026-04-22/00-principles.md`
- [ ] Seven principles are numbered and quotable
- [ ] Five cures table has all five subsystems
- [ ] Glossary has one-sentence definitions for the four terms

**Anti-pattern guards for this phase**:
- Don't add principles that don't have a cure in the table
- Don't add cures for problems not in the audit
- Don't add a "see also" subsection — principles stand alone

---

## Phase 2 — Write `01-data-integrity.md` + `02-process-lifecycle.md`

These two plans define the tectonic primitives other plans depend on. Both run in the same phase because they're the foundation.

### 2A. `01-data-integrity.md`

**Task**: Draft the data-layer plan covering schema UNIQUE constraints, idempotency tokens, self-healing claim query, Chroma sync, migration cleanup.

**Phases inside this plan**:
1. **Fresh `schema.sql`** — regenerate from current migrations, remove `started_processing_at_epoch` column, add `worker_pid INTEGER`, add `UNIQUE(session_id, tool_use_id)` on `pending_messages`, add `UNIQUE(memory_session_id, content_hash)` on `observations`.
2. **Migrate existing databases** — ALTER TABLE for the new columns, backfill, create UNIQUE indexes.
3. **Self-healing claim query** — replace 60-s stale-reset-inside-claim with `UPDATE pending_messages SET worker_pid=?, status='processing' WHERE status='pending' OR (status='processing' AND worker_pid NOT IN live_worker_pids) ORDER BY created_at_epoch LIMIT 1`. Delete `STALE_PROCESSING_THRESHOLD_MS`, delete `started_processing_at_epoch` column.
4. **Delete dedup window** — remove `DEDUP_WINDOW_MS` + `findDuplicateObservation`; replace with `INSERT … ON CONFLICT DO NOTHING`.
5. **Delete `clearFailedOlderThan` interval** — failed rows are a retention policy question. Make them a query-time filter (`WHERE status != 'failed' OR updated_at > now-1h`) or just let them accumulate until a user explicitly purges.
6. **Delete `repairMalformedSchema` Python subprocess** — root-cause WAL corruption if it recurs; do not ship repair code.
7. **Chroma sync — upsert semantics** — document delete-then-add as a bridge pattern; gate behind `CHROMA_SYNC_FALLBACK_ON_CONFLICT=true` flag; remove once Chroma MCP adds upsert natively.
8. **Delete migration 19 no-op** — absorbed into the fresh `schema.sql`.

**Doc refs**: `_reference.md` Part 1 §Data layer + §Chroma sync; SQLite docs on `ON CONFLICT DO NOTHING` + UNIQUE on added columns; migration 22 precedent in `runner.ts:658-837`.

**Verification**:
- [ ] `grep -n STALE_PROCESSING_THRESHOLD_MS src/` → 0
- [ ] `grep -n started_processing_at_epoch src/` → 0
- [ ] `grep -n DEDUP_WINDOW_MS src/` → 0
- [ ] `grep -n findDuplicateObservation src/` → 0
- [ ] `grep -n repairMalformedSchema src/` → 0
- [ ] `grep -n clearFailedOlderThan src/services/worker-service.ts` → 0 (interval deletion)
- [ ] Integration test: kill worker mid-claim; next worker's claim succeeds and row is re-processed

**Anti-pattern guards**:
- Do NOT keep `recoverStuckProcessing()` as a boot-once function. Self-healing claim replaces it entirely.
- Do NOT add a new timer for Chroma backfill. Backfill runs at boot-once OR on-demand when a downstream reader requests.
- Do NOT add "repair" CLI commands.

### 2B. `02-process-lifecycle.md`

**Task**: Draft the lifecycle plan: delete `src/supervisor/`, lazy-spawn from hooks, process groups for SDK children, no reapers, no idle-shutdown.

**Phases inside this plan**:
1. **Delete `src/services/worker/ProcessRegistry.ts`** (the worker-side parallel registry). Consolidate to `src/supervisor/process-registry.ts`.
2. **Change SDK spawn to use process groups** — `src/services/worker/ProcessRegistry.ts:452-465` (to be moved to supervisor): `spawn(cmd, args, { detached: true, stdio: ['ignore','pipe','pipe'] })`. Track `pgid = proc.pid`.
3. **Change shutdown cascade to kill groups** — `src/supervisor/shutdown.ts:116, 163`: `process.kill(-record.pgid, 'SIGTERM')` → wait 5s → `process.kill(-record.pgid, 'SIGKILL')`.
4. **Delete all reaper intervals** — `startOrphanReaper`, `staleSessionReaperInterval`, `clearFailedOlderThan` interval at `worker-service.ts:537, 547, 567`. Delete `killSystemOrphans`, `killIdleDaemonChildren`, `reapOrphanedProcesses`, `reapStaleSessions`.
5. **Delete the `abandonedTimer` per-session setTimeout** — replace with synchronous cleanup in `generatorPromise.finally` at the session itself.
6. **Delete idle-eviction** — `SessionManager.evictIdlestSession` at `:477-506`. Pool backpressure via queue depth instead.
7. **Delete fallback agent chain** (Gemini → OpenRouter) in SessionManager. Fail-fast on SDK failure; surface to hook via exit 2.
8. **Lazy-spawn wrapper** — every hook's `ensureWorkerRunning()` (`src/shared/worker-utils.ts:221-239`): check port → if dead, `spawn(bunPath, [workerPath], { detached: true, stdio: ['ignore','ignore','ignore'] })` → `proc.unref()` → return. Optional `respawn` dep for 3-attempt startup retry with backoff.
9. **Delete worker self-shutdown** — no idle timer. Worker runs until killed.

**Doc refs**: `_reference.md` Part 1 §Worker/lifecycle + Part 2 API verification rows 1-3 (Node detached, `kill(-pgid)`); commit 99060bac for PID-reuse pattern.

**Verification**:
- [ ] `grep -rn setInterval src/services/worker/` → 0
- [ ] `grep -rn startOrphanReaper src/` → 0
- [ ] `grep -rn staleSessionReaperInterval src/` → 0
- [ ] `grep -rn killSystemOrphans src/` → 0
- [ ] `grep -rn killIdleDaemonChildren src/` → 0
- [ ] `grep -rn reapStaleSessions src/` → 0
- [ ] `grep -rn reapOrphanedProcesses src/` → 0
- [ ] `grep -rn evictIdlestSession src/` → 0
- [ ] `grep -rn abandonedTimer src/` → 0
- [ ] `grep -rn "fallbackAgent\|Gemini\|OpenRouter" src/services/worker/SessionManager.ts` → 0
- [ ] `src/services/worker/ProcessRegistry.ts` file does NOT exist
- [ ] `src/supervisor/` directory DOES still exist (canonical registry + shutdown)
- [ ] Integration test: kill worker via `kill -9 <pid>`; next hook respawns worker; no orphan children remain
- [ ] Integration test: graceful SIGTERM to worker; all SDK children exit within 6s

**Anti-pattern guards**:
- Do NOT keep `killSystemOrphans` as a boot-once function — orphans are PREVENTED by process groups, not swept.
- Do NOT add idle-timer self-shutdown to the worker.
- Do NOT introduce a third process registry during the migration.

---

## Phase 3 — Write `03-ingestion-path.md` + `04-read-path.md`

### 3A. `03-ingestion-path.md`

**Task**: Draft the ingestion plan: fail-fast parser, direct `ingestObservation()` call, recursive `fs.watch`, DB-backed tool pairing, single-regex tag strip, delete `TranscriptParser` dead class.

**Phases inside this plan**:
0. **Ingest helpers** (prerequisite for plans 05, 06, 07) — `ingestObservation(payload)`, `ingestPrompt(payload)`, `ingestSummary(payload)` as direct functions on the worker. No HTTP loopback.
1. **`parseAgentXml`** — single entry point returning `{ valid: true, data } | { valid: false, reason }` discriminated union. Replaces `parseObservations` + `parseSummary` + `coerceObservationToSummary`.
2. **ResponseProcessor migration** — call `parseAgentXml` once; on invalid, `markFailed(messageId, reason)`. On valid summary, emit `summaryStoredEvent` (consumed by `05-hook-surface.md` blocking endpoint).
3. **Delete circuit breaker** — `consecutiveSummaryFailures`, `MAX_CONSECUTIVE_SUMMARY_FAILURES`, SessionManager guards on it.
4. **Delete coerce function** — `coerceObservationToSummary` in `src/sdk/parser.ts:222-259` removed entirely.
5. **Recursive `fs.watch`** — `src/services/transcripts/watcher.ts:124-132` replaces 5-s rescan `setInterval` with `fs.watch(transcriptsRoot, { recursive: true })`. Preflight: `engines.node >= 20.0.0`.
6. **DB-backed tool pairing** — delete `pendingTools` Map at `processor.ts:23`. Insert both `tool_use` and `tool_result` rows into `pending_messages` with `UNIQUE(session_id, tool_use_id)` constraint. Pair by JOIN at read time.
7. **Direct `ingestObservation`** — `processor.ts:252` calls the helper from Phase 0, not `observationHandler.execute()`.
8. **Single-regex tag strip** — consolidate `src/utils/tag-stripping.ts` `countTags`/`stripTagsInternal` to one regex with alternation.
9. **Delete dead `TranscriptParser` class** — `src/utils/transcript-parser.ts:28-90`.

**Doc refs**: `_reference.md` Part 1 §Ingestion; old Plan 01/03/08 for prior work; `fs.watch` Node 20+ release notes.

**Verification**:
- [ ] `grep -n coerceObservationToSummary src/` → 0
- [ ] `grep -n consecutiveSummaryFailures src/` → 0
- [ ] `grep -n "pendingTools" src/services/transcripts/` → 0
- [ ] `grep -n "setInterval" src/services/transcripts/watcher.ts` → 0
- [ ] `grep -n "observationHandler.execute" src/services/transcripts/` → 0
- [ ] `grep -n "TranscriptParser" src/utils/transcript-parser.ts` → file does not exist
- [ ] `package.json` engines.node ≥ 20.0.0
- [ ] Fuzz test: drop JSONL with `tool_use` but no `tool_result` → row stays pending, no pair emitted, no crash
- [ ] Fuzz test: drop JSONL with `tool_result` referencing unknown `tool_use_id` → debug log, no crash, no phantom observation

**Anti-pattern guards**:
- Do NOT keep coercion as a "lenient mode" flag.
- Do NOT ship a polling fallback for `fs.watch` — Node 20+ handles recursive Linux natively.
- Do NOT preserve the in-memory Map behind a feature flag.

### 3B. `04-read-path.md`

**Task**: Draft the read-path plan: one renderer with strategy config, one search path, delete `SearchManager.findBy*`, consolidate recency filter, throw 503 on Chroma failure.

**Phases inside this plan**:
1. **`renderObservations(obs, strategy: RenderStrategy)`** — single function replacing `AgentFormatter`, `HumanFormatter`, `ResultFormatter`, `CorpusRenderer`. `RenderStrategy` is a config object with knobs: `header`, `grouping`, `rowDensity`, `colors`, `columns`.
2. **Delete four formatter classes** — `src/services/context/formatters/*.ts` replaced by four configs passed to `renderObservations`.
3. **Delete SearchManager duplicated methods** — `findByConcept`, `findByFile`, `findByType` at `SearchManager.ts:1209-1310, 1277, 1399`. Route all calls through `SearchOrchestrator`.
4. **Consolidate recency filter** — import `RECENCY_WINDOW_MS` from `types.ts:16` into every call site. Delete all seven hand-rolled copies in SearchManager.
5. **Fail-fast Chroma** — `SearchOrchestrator.ts:85-110` throws 503 on Chroma error instead of stripping query and re-querying SQLite. `ChromaSearchStrategy.ts:76-86` returns `usedChroma: false` only when Chroma is explicitly uninitialized; propagates real errors.
6. **Delete hybrid silent fallbacks** — `HybridSearchStrategy.ts:82-95, 120-134, 161-173`: propagate errors instead of returning metadata-only.
7. **Delete `@deprecated getExistingChromaIds`** — dead code fence removed in same PR.
8. **Single `estimateTokens` utility** — `src/shared/estimate-tokens.ts`. Delete duplicates in `ResultFormatter.ts:264` and `CorpusRenderer.ts:90`.
9. **Knowledge-corpus simplification** — delete `session_id` persistence, `prime`/`reprime` operations, auto-reprime regex in KnowledgeAgent; rewrite `/query` to fresh SDK call with systemPrompt; rely on SDK prompt caching.

**Doc refs**: `_reference.md` Part 1 §Search + §Context; old Plans 05, 06, 10.

**Verification**:
- [ ] `grep -n "SearchManager\.findBy" src/` → 0 (definitions deleted)
- [ ] `grep -rn "RECENCY_WINDOW_MS" src/services/worker/SearchManager.ts` → 0 (constants inlined in 7 places deleted)
- [ ] `grep -n "fellBack: true" src/` → 0 (silent fallback flag deleted)
- [ ] `grep -n "getExistingChromaIds" src/` → 0
- [ ] `ls src/services/context/formatters/` → empty or deleted
- [ ] Integration test: Chroma down → request fails with 503 (not empty result)
- [ ] Snapshot test: `renderObservations` with agent config produces byte-identical output to the old `AgentFormatter` on the same input

**Anti-pattern guards**:
- Do NOT create a `RenderStrategy` class hierarchy. Config object only.
- Do NOT add a feature flag to "disable fail-fast Chroma" — callers either handle 503 or they don't.

---

## Phase 4 — Write `05-hook-surface.md` + `06-api-surface.md`

### 4A. `05-hook-surface.md`

**Task**: Draft the hook plan: consolidate worker HTTP plumbing, cache settings, delete shell retry loops, delete polling in summarize, fail-loud after N consecutive failures.

**Phases inside this plan**:
1. **Delete shell retry loops** — `plugin/hooks/hooks.json:27, 32, 43` — remove the 20-iteration `curl` retry loops. `ensureWorkerRunning()` does the one check.
2. **`executeWithWorkerFallback(url, method, body)` helper** — consolidate the 8-handler copy of `ensureWorkerRunning → workerHttpRequest → if (!ok) return { continue: true }`. Move to `src/shared/worker-utils.ts` as a new export.
3. **Blocking `/api/session/end` endpoint** — server-side wait-for-`summaryStoredEvent` (emitted by `03-ingestion-path` Phase 2). Single POST, single response. Delete `src/cli/handlers/summarize.ts:117-150` polling loop.
4. **Cache settings once per hook process** — module-scope `loadFromFileOnce()` replaces per-handler `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` calls at `context.ts:36`, `session-init.ts:57`, `observation.ts:58`, `file-context.ts:211`.
5. **`shouldTrackProject(cwd)` helper** — consolidate the three duplicated `isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)` call sites.
6. **cwd validation at adapter boundary** — move from `file-edit.ts:50-51`, `observation.ts:53-54` to the adapter's `normalizeInput()` function. Validation happens once.
7. **Always-init agent** — delete conditional in `session-init.ts:120-129`. Agent init is idempotent.
8. **Fail-loud after N consecutive failures** — track consecutive `ensureWorkerRunning == false` in settings file; after N (e.g., 3), exit code 2 to surface to Claude. Reset on first success.
9. **Delete cache alive heuristic duplication** — single `ensureWorkerAliveOnce()` with module-scope cache.

**Doc refs**: `_reference.md` Part 1 §Hooks/CLI; old Plan 09 for endpoint consolidation (10 → 4).

**Verification**:
- [ ] `grep -rn "for i in 1 2 3 4 5 6 7" plugin/hooks/hooks.json` → 0
- [ ] `grep -rn "SettingsDefaultsManager.loadFromFile" src/cli/handlers/` → 1 (cached location only)
- [ ] `grep -rn "isProjectExcluded" src/cli/handlers/` → 1 (inside `shouldTrackProject` only)
- [ ] `grep -rn "MAX_WAIT_FOR_SUMMARY_MS\|POLL_INTERVAL_MS" src/cli/handlers/` → 0
- [ ] Integration test: block worker port → hook exits 0 first time, exits 2 after 3 consecutive failures
- [ ] Integration test: session end hook blocks until summary stored (single POST, no polling)

**Anti-pattern guards**:
- Do NOT add a retry loop inside the hook (any kind).
- Do NOT add a timeout-and-exit-0 pattern.
- Do NOT keep the shell retry loops behind a feature flag.

### 4B. `06-api-surface.md`

**Task**: Draft the API-surface plan: Zod middleware, delete rate limiter, delete diagnostic endpoints, cache static files, consolidate shutdown paths.

**Phases inside this plan**:
1. **Preflight: `npm install zod@^3.x`**.
2. **`validateBody` middleware** — single Express middleware using Zod `safeParse`. Returns 400 with field errors on failure.
3. **Per-route Zod schemas** — one per POST/PUT endpoint, defined at top of route file.
4. **Delete hand-rolled validation** — grep-and-delete `validateRequired`, inline `typeof` checks, coerce helpers across route files.
5. **Delete rate limiter** — worker is localhost-only; rate limiting is a second-system effect masking a real concurrency bug (if one exists, find it).
6. **Cache viewer.html + /api/instructions** — load at boot into Buffer, serve from memory. Per-process lifecycle.
7. **Delete diagnostic endpoints** — `/api/pending-queue` GET, `/api/pending-queue/process`, `/api/pending-queue/failed` DELETE, `/api/pending-queue/all` DELETE at `DataRoutes.ts:475, 510, 529, 548`. Keep `/api/processing-status` at `:305` and `/health` at `ViewerRoutes.ts:32`.
8. **Consolidate shutdown paths** — delete `WorkerService.shutdown`, `runShutdownCascade`, `stopSupervisor` wrappers. Single `performGracefulShutdown` at `GracefulShutdown.ts:52-86` is the only shutdown path.
9. **Consolidate failure-marking paths** — delete `markSessionMessagesFailed` at `SessionRoutes.ts:256` and `markAllSessionMessagesAbandoned` at `worker-service.ts:943`. Single `transitionMessagesTo(status)` method on `PendingMessageStore`.

**Doc refs**: `_reference.md` Part 1 §API surface; old Plan 11 for Zod strategy.

**Verification**:
- [ ] `grep -rn "validateRequired\|rateLimit" src/services/worker/http/` → 0
- [ ] `grep -rn "/api/pending-queue" src/` → 0
- [ ] `grep -rn "markSessionMessagesFailed\|markAllSessionMessagesAbandoned" src/` → 0 (or 1, only inside `transitionMessagesTo`)
- [ ] `grep -rn "WorkerService.prototype.shutdown\|runShutdownCascade\|stopSupervisor" src/` → 0 (or 1 at the canonical call site)
- [ ] Integration test: POST /api/observations with malformed body → 400 with field errors (not 500)
- [ ] Integration test: viewer.html served from memory (no disk read after boot)

**Anti-pattern guards**:
- Do NOT add per-route middleware stacks; one middleware for all validated POST/PUT.
- Do NOT add a diagnostic endpoint "for debugging only."
- Do NOT keep a shutdown wrapper "for backward compat."

---

## Phase 5 — Write `07-dead-code.md`

**Task**: Draft the sweep plan that catches everything the other plans don't explicitly delete.

**Scope**:
- `TranscriptParser` class at `src/utils/transcript-parser.ts:28-90` (no active importers)
- Migration 19 no-op at `src/services/sqlite/migrations/runner.ts:621-628` (absorbed into fresh schema)
- `@deprecated getExistingChromaIds` (noted in `04-read-path` but deleted here if missed)
- Any `// removed` or `// old` or `// legacy` commented-out blocks
- Any unused exports (grep for exports never imported)
- Any `bun-resolver.ts`, `bun-path.ts`, `BranchManager.ts`, `runtime.ts` spawn sites that are unused
- Migration logic duplicated in `SessionStore.ts:52-70` (delegates to `MigrationRunner`)

**Phases**:
1. Run `ts-prune` or `knip` to identify unused exports.
2. Grep for commented-out code patterns.
3. Delete identified dead code with rationale in the commit message.
4. Re-run build + tests to verify no accidental removal.

**Doc refs**: `_reference.md` Part 1 §Data layer (SessionStore duplication), §Ingestion (TranscriptParser).

**Verification**:
- [ ] `npx ts-prune` or equivalent shows zero unused exports in `src/`
- [ ] Build passes
- [ ] Test suite passes
- [ ] `grep -rn "// @deprecated\|// TODO remove\|// old\|// legacy" src/` → 0

**Anti-pattern guards**:
- Do NOT delete anything still imported by a test.
- Do NOT delete types still referenced by exported interfaces.

---

## Phase 6 — Write `98-execution-order.md` + `99-verification.md`

### 6A. `98-execution-order.md`

**Task**: Produce the dependency DAG, preflight gates, critical path, parallel branches, and blocking issues.

**Contents**:
1. **DAG**: `00` is the root (no deps). `01` + `02` are foundational. `03` depends on `01` (UNIQUE constraint) + `02` (process groups implied in spawn refactor). `04` depends on `01` (Chroma table shape). `05` depends on `02` (lazy-spawn), `03` (`summaryStoredEvent`). `06` depends on `05` (Zod schemas for hook endpoints). `07` runs last (sweep after everything else deletes its code). `99` runs alongside each plan (acceptance checks).
2. **Preflight gates**:
   - `engines.node >= 20.0.0` bump
   - `npm install zod@^3.x`
   - Prompt-caching cost smoke test (for `04` knowledge-corpus phases)
   - Chroma MCP availability + error-text pattern documented
3. **Critical path**: `00 → 01 → 02 → 03 → 05 → 06 → 07` (seven sequential plans).
4. **Parallel branches**: `04` runs after `01` independently of `02`. `07` runs after everything.
5. **Blocking issues**: carried forward from old `08-reconciliation.md` Part 5.
6. **Post-landing verification**: grep chains from every plan's verification section.

**Doc refs**: `_mapping.md` Cross-plan coupling table; old `07-master-plan.md` + `08-reconciliation.md`.

### 6B. `99-verification.md`

**Task**: The acceptance-criteria document for the whole refactor.

**Contents**:
1. **Timer census**: 3 → 0 repeating background timers.
2. **Polling loops**: 1 → 0.
3. **Full grep target list**: consolidated from every plan's verification section, grouped by pattern:
   - `grep -rn "setInterval" src/services/worker/` → 0
   - `grep -rn "coerceObservationToSummary\|consecutiveSummaryFailures" src/` → 0
   - `grep -rn "recoverStuckProcessing\|killSystemOrphans\|reapStaleSessions\|reapOrphanedProcesses\|killIdleDaemonChildren" src/` → 0
   - `grep -rn "ProcessRegistry" src/services/worker/` → 0
   - `grep -rn "/api/pending-queue" src/` → 0
   - `grep -rn "DEDUP_WINDOW_MS\|findDuplicateObservation" src/` → 0
   - `grep -rn "abandonedTimer\|evictIdlestSession" src/` → 0
   - `grep -rn "fallbackAgent\|Gemini\|OpenRouter" src/services/worker/` → 0
4. **Prompt-caching cost smoke test**: three sequential `/api/corpus/:name/query` calls assert `cache_read_input_tokens > 0` on calls 2 and 3.
5. **Viewer regression harness**: 12 invariants (I1–I12), 11 tests (T1–T11), baseline capture + re-run schedule.
6. **Integration tests** (consolidated from per-plan verification):
   - Kill worker mid-claim → next worker picks up the row
   - SIGTERM worker → all SDK children exit within 6s (process-group teardown)
   - Chroma down → search returns 503 (no silent fallback)
   - Malformed POST → 400 with field errors (Zod)
   - Consecutive hook failures → exit 2 after N
7. **Acceptance criteria** — final net lines, full test pass, viewer regression pass, cost smoke pass.

**Doc refs**: Every other plan's verification section.

**Verification**:
- [ ] Every grep target is sourced from at least one plan
- [ ] Every integration test has a corresponding plan that introduces the behavior
- [ ] Viewer lockdown section cites `tests/viewer-lockdown/` artifacts

---

## Phase 7 — Principle cross-check

**Task**: Before the new corpus ships, verify each new plan passes its own principles. Run as a meta-review.

**Checks**:
1. `grep -rn "recover\|reap\|heal\|repair\|orphan\|coerce\|fallback" PATHFINDER-2026-04-22/*.md` — every hit must be in a "DELETE" or "NEVER add" context, never as an acceptable future pattern.
2. `grep -rn "setInterval\|setTimeout" PATHFINDER-2026-04-22/*.md` — every hit must be either a deletion target or a narrowly-justified per-operation timer.
3. `grep -rn "strategy\|factory\|builder" PATHFINDER-2026-04-22/*.md` — every hit must justify why a config object won't do.
4. `grep -rn "for backward compat\|for one release\|@deprecated" PATHFINDER-2026-04-22/*.md` — must be 0.
5. Verify every plan cites `_reference.md` Part 1 for its code anchors and Part 2 for its external APIs.
6. Verify `_mapping.md` accounts for every old section (no orphans).
7. Verify `98-execution-order.md` DAG is acyclic and covers all plans.

**Deliverable**: A short `_principle-crosscheck.md` in the new corpus directory logging the results. If ANY check fails, the corresponding plan gets sent back for revision before ship.

---

## Execution instructions

Each phase (1 through 7) can be executed in a fresh chat context. To execute phase N:

1. Open a new chat
2. Load `PATHFINDER-2026-04-22/_reference.md` and `_mapping.md` and this file
3. Scroll to "Phase N" and execute its tasks verbatim
4. Commit each new plan file as it's produced (`git add PATHFINDER-2026-04-22/<plan>.md`)
5. Run the verification checklist; if any check fails, revise the plan before moving on

**Total estimated effort**: 4 engineer-days for Phases 1–6 (plan authoring), 2 engineer-days for Phase 7 (cross-check + revisions), then the plans themselves execute the refactor over ~3 weeks.

---

## Confidence + known gaps

**Confidence: HIGH.** Phase 0 agents verified every anchor against live code. The principle list is derived from five independent audits that independently converged on the same diagnosis. The DAG is internally consistent (every new plan has exactly one owner for each cross-plan invariant — see `_mapping.md` coupling table).

**Known gaps**:
1. **Chroma upsert fallback is brittle** — document the error-text pattern in `01-data-integrity.md` §Chroma, gate behind a flag.
2. **Prompt-caching TTL assumption** — cost smoke test must pass before `04-read-path` knowledge-corpus phases ship.
3. **Windows process-group behavior** — `process.kill(-pgid)` is Unix-only; document Windows Job Objects as a gap-to-fix in `02-process-lifecycle.md`.
4. **`respawn` dep decision** — `02-process-lifecycle.md` must decide: adopt `respawn` or hand-roll a 3-attempt retry in the lazy-spawn wrapper.
5. **Snapshot tests for renderer collapse** — `04-read-path.md` §Phase 1 must freeze byte-equality snapshots BEFORE deleting the four formatters, otherwise regressions are undetectable.

---

**Status: READY FOR PHASE 1.** Next action: open a fresh chat, load this file + `_reference.md` + `_mapping.md`, execute Phase 1 to produce `00-principles.md`.
