# Pathfinder Phase 6: Implementation Plan

**Date**: 2026-04-22
**Source**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md`
**Scope**: 15 execution phases to land the brutal-audit cleanup. Each phase is self-contained so it can be run in a fresh chat session.

> **Design authority**: `05-clean-flowcharts.md` is the canonical design doc. This plan references it by section number (e.g., "05: 3.2" = section 3.2 of the clean-flowcharts file). When the plan and audit disagree, the plan's *verified-findings* take precedence — those corrections are called out explicitly in Phase 0.

---

## Phase 0 — Documentation Discovery (ALREADY COMPLETED)

The design docs needed for this plan have been read and verified against the live codebase. **Do not re-do this phase**; cite its outputs from later phases.

### Sources consulted

1. `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — brutal audit + 12 clean flowcharts (Part 3), timer census (Part 4), deletion ledger (Part 5), execution order (Part 6), non-cull list (Part 7)
2. `PATHFINDER-2026-04-21/02-duplication-report.md` — 12 cross-feature duplication findings (background)
3. `PATHFINDER-2026-04-21/03-unified-proposal.md` — earlier consolidation targets (U1–U8)
4. Live codebase at `/Users/alexnewman/.superset/worktrees/claude-mem/vivacious-teeth/src/**/*.ts`

### Verified-findings corrections (supersede the audit where they disagree)

These were produced by four parallel discovery subagents. Use these numbers in every downstream phase.

| # | Audit claimed | Reality | Impact on plan |
|---|---|---|---|
| V1 | Summary path only strips `<system-reminder>` (`summarize.ts:66`, `SessionRoutes.ts:669`) | Summary paths strip **ZERO** tags. `handleSummarize` (`SessionRoutes.ts:491`) and `handleSummarizeByClaudeId` (`SessionRoutes.ts:669`) pass `last_assistant_message` straight to `queueSummarize` with no strip. | Privacy gap is **worse** than audit — fix must be added to `ingestSummary`, not a one-line patch. |
| V2 | Legacy `handleObservations` with no-strip at `SessionRoutes.ts:378` | `handleObservations` is at `SessionRoutes.ts:464`. It does **not** strip tags. `handleObservationsByClaudeId` at `SessionRoutes.ts:560` **does** strip (lines 629–633). | Delete/consolidate *both* into `ingestObservation` helper. |
| V3 | `stripMemoryTagsFromJson` + `stripMemoryTagsFromPrompt` wrappers exist | Confirmed. `src/utils/tag-stripping.ts:79` and `:89` both delegate to `stripTagsInternal` at line 48. Six sequential `.replace()` calls at lines 61–66. | U6 target is exact. |
| V4 | Only 3 files call any `stripMemoryTags*` variant | Confirmed. `SessionRoutes.ts:629`, `:633`, `:862`. **No call sites** in summary, legacy observation, or summarize hook. | After U6, verify call-site count equals number of new ingest helpers × text fields. |
| V5 | `startUnifiedReaper` at `process-registry.ts:492` | **Does not exist**. Supervisor registry (`src/supervisor/process-registry.ts`, 408 lines) has `ProcessRegistry` class + `reapSession()` (line 292) but no background timer. Both reapers live in the **worker layer**. | Phase 6 builds `ReaperTick` fresh in worker-service.ts; supervisor registry stays as-is. |
| V6 | Two reapers in worker | Confirmed. `startOrphanReaper` (`src/services/worker/ProcessRegistry.ts:508`, invoked from `worker-service.ts:537`, 30 s). `staleSessionReaperInterval` (inline `setInterval` at `worker-service.ts:547`, 2 min, calls `SessionManager.reapStaleSessions`). Orphan reaper does **not** call `reapStaleSessions`. | Phase 6 replaces both. |
| V7 | `coerceObservationToSummary` exists + non-XML early-fail + circuit breaker | Confirmed. Private fn at `src/sdk/parser.ts:222`. Non-XML fail at `ResponseProcessor.ts:87–108`. Circuit breaker at `ResponseProcessor.ts:176–200` using `session.consecutiveSummaryFailures`. | Phase 3 deletion set is exact. |
| V8 | 500 ms poll up to 110 s in summarize hook | Confirmed. `src/cli/handlers/summarize.ts:117–150`. Constants: `POLL_INTERVAL_MS = 500` (:24), `MAX_WAIT_FOR_SUMMARY_MS = 110_000` (:25). | Phase 11 replaces with blocking endpoint. |
| V9 | SessionRoutes has 8 endpoints | Actually **10**: six under `/sessions/:sessionDbId/*` (`:377–:382`) and five under `/api/sessions/*` (`:385–:389`). `/api/sessions/status` is the one summary-hook polls. | Phase 11 collapses to 4; deletes are larger than audit implied. |
| V10 | `ensureWorkerRunning` at every hook entry | Confirmed. Called in all 8 CLI handlers (`context.ts:19`, `user-message.ts:35`, `summarize.ts:44`, `observation.ts`, `file-context.ts`, `file-edit.ts`, `session-init.ts`, `session-complete.ts`). | Phase 1 hook-cache module lands before endpoint consolidation. |
| V11 | SearchManager thin facade | Confirmed for `@deprecated` methods (`queryChroma` at `:59`, `searchChromaForTimeline` at `:70`) — but `search()` at `:161–445` does *real* work (result combining, date filtering, grouping, markdown tables). File is 2069 lines. | Phase 4 keeps display-wrap, deletes deprecated + passthroughs only. |
| V12 | 27 migrations | 22 private methods in `MigrationRunner.runAllMigrations` (lines 22–41 of `src/services/sqlite/migrations/runner.ts`); legacy system adds ~5 more. `schema_versions` table created at `runner.ts:55`. | Phase 9 target is "22+legacy → schema.sql + N upgrade migrations". |
| V13 | Python `sqlite3` subprocess ~120 lines | Python script embedded; invoked via `execSync('python3 ...')` at `tests/services/sqlite/schema-repair.test.ts:62` (test file is 253 lines; production script similar). | Phase 9 deletion confirmed; move to user-facing `claude-mem repair` subcommand. |
| V14 | 30-s content-hash dedup window + `findDuplicateObservation` ~30 lines | Confirmed at `src/services/sqlite/observations/store.ts:13` (`DEDUP_WINDOW_MS = 30_000`). `findDuplicateObservation` is 11 lines at `:36–46`. Dedup key is SHA of `(memory_session_id, title, narrative)` — not `tool_use_id`. | Phase 9 adds `UNIQUE(session_id, tool_use_id)` constraint and removes window; this is a **new** constraint, not an existing one. |
| V15 | No `chroma_synced` column | Confirmed. Phase 10 must add it in a migration. | Blocks Phase 10's backfill simplification. |
| V16 | Granular per-field Chroma docs (3–5 per obs) | Confirmed. 7 observation fields + 6 summary fields (`ChromaSync.ts:125–256`). `formatObservationsAsDocs` and `formatSummariesAsDocs` produce separate docs. | Phase 10 concatenates into one doc per observation/summary. |
| V17 | `getExistingChromaIds` metadata scan + delete-then-add on conflict | Confirmed. `getExistingChromaIds` at `ChromaSync.ts:479–545` pages via `chroma_get_documents` with `include: ['metadatas']`. Delete-then-add at `:292–306`. | Phase 10 replaces with `upsert` using stable IDs. |
| V18 | 5-s rescan + `pendingTools` map + HTTP loopback | Confirmed. `src/services/transcripts/watcher.ts:124` (`rescanIntervalMs ?? 5000`). `pendingTools` in `SessionState` interface. `observation.ts:17` loops through `workerHttpRequest('/api/sessions/observations', …)`. Watcher calls handler directly; handler HTTPs back to worker. | Phase 7 replaces with `fs.watch(parentDir, {recursive})` and direct `ingestObservation(payload)` call. |
| V19 | 60-s stale reset in every `claimNextMessage` | Confirmed. `src/services/sqlite/PendingMessageStore.ts:99–145`. Constant `STALE_PROCESSING_THRESHOLD_MS = 60_000` at `:6`. | Phase 6 moves the reset to worker startup. |
| V20 | Rate limiter 300/min | Confirmed at `src/services/worker/http/middleware.ts:45–79`. Constants at `:49–50`. Keyed by IP, normalizes `::ffff:127.0.0.1`. | Phase 14 deletes. |

### Allowed APIs (what the refactor may rely on)

Copy from these exact sources; do **not** invent.

- **bun:sqlite** — `Database`, `db.prepare(sql)`, `db.run`, `db.transaction(fn)`. Unique constraint: `CREATE TABLE x (... UNIQUE(a,b))`. Conflict clause: `INSERT ... ON CONFLICT DO NOTHING` or `ON CONFLICT (a,b) DO UPDATE SET ...`. (Used everywhere under `src/services/sqlite/`.)
- **Express 4** — `app.get/post`, `router.use(middleware)`, `req.body`, `res.json`, `res.sendFile`, SSE via `res.write('event: …\ndata: …\n\n')`. (See `BaseRouteHandler.ts`, `SSEBroadcaster.ts`.)
- **Zod** — `z.object({...})`, `schema.safeParse(body)`, `result.success ? result.data : result.error.flatten()`. (Not yet a dep; Phase 12 adds `zod` via npm; already shipped transitively via `@anthropic-ai/sdk` — confirm before landing.)
- **Node `fs.watch`** — `fs.watch(dir, { recursive: true }, (event, filename) => …)`. On macOS + Linux recursive is supported; Windows is too. New files in the watched directory fire `rename` events. (Replaces the 5-s rescan timer.)
- **Claude Agent SDK `@anthropic-ai/claude-agent-sdk`** — existing usage in `src/services/worker/SDKAgent.ts`. Agent contract requires `<summary>` OR `<skip_summary/>`; see `src/sdk/prompts.ts` for the exact instruction text.

### Anti-patterns to prohibit (cite in every phase)

A. **Inventing APIs** — never add a method to a class because it "should exist". Grep the class first.
B. **Polling where events exist** — `setInterval` + HTTP poll replaced by blocking endpoint or SSE.
C. **Silent fallbacks** — Chroma failure returns 503, not dropped-query-text search. Parser failure marks `pending_messages` FAILED, not coerced summary.
D. **Facades that pass through** — if a method body is `return this.other.method(args)`, delete it; call `this.other` directly.
E. **Two code paths for the same data** — if transcript watcher and CLI handler both ingest observations, they call the same helper. No duplicate tag-strip logic.

---

## Phase 1 — One `stripMemoryTags` + close summary privacy gap

**Outcome**: A single public `stripMemoryTags(text: string): string`. Every text-ingress call-site switches to it. Summary paths strip tags (closes P1 security bug).

### Context this phase needs

- `05-clean-flowcharts.md` section 3.2 (privacy-tag-filtering clean flowchart)
- Verified-findings V1, V2, V3, V4
- `src/utils/tag-stripping.ts:48–91` — existing wrappers

### Tasks

1. **Rewrite `src/utils/tag-stripping.ts`** to export:
   ```ts
   const MEMORY_TAGS = ['private','claude-mem-context','system_instruction','system-instruction','persisted-output','system-reminder'] as const;
   const STRIP_REGEX = new RegExp(`<(${MEMORY_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'g');
   export function stripMemoryTags(text: string): string { /* one pass; ReDoS guard if match count > 100 */ }
   ```
   Delete `stripMemoryTagsFromPrompt`, `stripMemoryTagsFromJson`, `stripTagsInternal`, `SYSTEM_REMINDER_REGEX`. Keep the length/timing guards from the existing file if they're there today.
2. **Fix every call site** to use `stripMemoryTags`:
   - `SessionRoutes.ts:629,633` (was `stripMemoryTagsFromJson`): call on `JSON.stringify(tool_input)` and `JSON.stringify(tool_response)` — same shape, new name.
   - `SessionRoutes.ts:862` (was `stripMemoryTagsFromPrompt`): unchanged signature.
   - **Add** in `SessionRoutes.ts:464` (legacy `handleObservations`): strip `tool_input` and `tool_response` before `queueObservation`.
   - **Add** in `SessionRoutes.ts:491` (`handleSummarize`): strip `last_assistant_message` before `queueSummarize`.
   - **Add** in `SessionRoutes.ts:669` (`handleSummarizeByClaudeId`): same.
3. **Update the test** `tests/utils/tag-stripping.test.ts` (if present) to cover the merged function; delete tests for the removed wrappers.

### Verification

- [ ] `grep -r "stripMemoryTagsFromJson\|stripMemoryTagsFromPrompt\|stripTagsInternal" src/` → zero hits.
- [ ] `grep -c "stripMemoryTags(" src/` ≥ 5 (new call sites: 3 existing + 3 new summary/legacy paths).
- [ ] Regression test: insert `<private>secret</private>` into a summary via `/sessions/:id/summarize`; assert `session_summaries.last_assistant_message` contains no `<private>` or `secret`.
- [ ] `npm run build-and-sync` succeeds.

### Anti-pattern guards

- A: Don't add a `stripMemoryTagsV2` wrapper — rename in place.
- D: Don't leave the old function names as re-exports "for safety" — delete.

### Blast radius

Edits: 2 files (`tag-stripping.ts`, `SessionRoutes.ts`). No schema changes.

---

## Phase 2 — Unified ingest helpers

**Outcome**: Three helpers that every ingest point calls. No HTTP loopback inside the worker process.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.1 (lifecycle-hooks clean), Part 2 Decision D1
- Verified-findings V2, V18
- Phase 1 **MUST** be done first.

### Tasks

1. **Create `src/services/worker/ingest/index.ts`** exporting:
   ```ts
   export function ingestObservation(payload: IngestObservationPayload): Promise<IngestResult>;
   export function ingestPrompt(payload: IngestPromptPayload): Promise<IngestResult>;
   export function ingestSummary(payload: IngestSummaryPayload): Promise<IngestResult>;
   ```
   Each helper: (a) calls `stripMemoryTags` on user-facing text fields, (b) runs privacy / project-exclusion validation (move logic from `SessionRoutes.handleObservationsByClaudeId:614–621` and `PrivacyCheckValidator.ts`), (c) INSERTs into `pending_messages`. Returns `{ skipped: boolean, id?: number, reason?: string }`.
2. **Rewire** `SessionRoutes.ts:464` (`handleObservations`), `:560` (`handleObservationsByClaudeId`), `:491` + `:669` (summarize), `:862` (`handleSessionInitByClaudeId` → `ingestPrompt`) to call the helpers. Route handler's job shrinks to body parsing + response serialization.
3. **Rewire** `src/cli/handlers/observation.ts` to call `ingestObservation` directly when the worker is the current process — but since hooks run in CLI, they still HTTP to the worker. The key change: the worker side of the route talks to the helper, no more inline logic.
4. **Rewire** `src/services/transcripts/watcher.ts` to call `ingestObservation(payload)` directly (no `workerHttpRequest` from inside the worker). Delete the inner HTTP call from the transcript path.

### Verification

- [ ] `grep -n "stripMemoryTags" src/services/worker/` → only inside `ingest/index.ts`.
- [ ] `grep -n "queueObservation\|queueSummarize" src/services/worker/http/routes/SessionRoutes.ts` → zero (handlers use ingest helpers).
- [ ] Unit tests for each helper: tag stripping, privacy validation, project exclusion, INSERT behaviour, idempotent returns for dup.
- [ ] Integration: run full hook cycle via `npm run build-and-sync` + trigger `SessionStart` + `PostToolUse`; observe `pending_messages` row.

### Anti-pattern guards

- E: Don't leave behind `handleObservations` and `handleObservationsByClaudeId` with slightly different logic. One helper, both handlers call it.
- A: No `IngestService` class unless two existing classes already share state. A module with three functions is enough.

### Blast radius

Files touched: `SessionRoutes.ts`, new `ingest/*`, `watcher.ts`, `PrivacyCheckValidator.ts` (may collapse into helper). No schema changes.

---

## Phase 3 — Unify parser; delete coerce + circuit breaker

**Outcome**: One `parseAgentXml(text, {requireSummary})`. `coerceObservationToSummary`, consecutive-failure counter, and non-XML early-fail branch are gone. RestartGuard handles repeated failures.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.7, Part 2 Decision D5
- Verified-findings V7
- `src/sdk/parser.ts`, `src/services/worker/agents/ResponseProcessor.ts:87–200`, `src/services/worker/RestartGuard.ts`
- `src/sdk/prompts.ts` — agent instructions must already state "return `<summary>` or `<skip_summary/>`". If not, update the prompt in this phase.

### Tasks

1. **Replace `parser.ts`** with:
   ```ts
   export interface ParsedAgentOutput {
     observations: ParsedObservation[];
     summary: ParsedSummary | null;
     skipSummary: boolean;
   }
   export interface ParseResult {
     valid: boolean;
     data?: ParsedAgentOutput;
     reason?: 'no_xml' | 'missing_summary' | 'malformed';
   }
   export function parseAgentXml(text: string, opts: { requireSummary: boolean }): ParseResult;
   ```
   Delete `parseObservations` and `parseSummary` exports; keep them as private helpers only if the call sites merge into one. Delete `coerceObservationToSummary` outright.
2. **Update `ResponseProcessor.ts`**:
   - Replace the parse path with a single `parseAgentXml(text, {requireSummary: session.expectsSummary})`.
   - On `valid:false`: call `session.recordFailure(result.reason)` → mark `pending_messages` FAILED → let RestartGuard decide. Delete lines `:87–108` (non-XML early-fail), lines `:176–200` (`consecutiveSummaryFailures` counter + circuit).
   - Remove the `consecutiveSummaryFailures` field from `ActiveSession`.
3. **Update `sdk/prompts.ts`** if needed so the agent contract is explicit: on work → one or more `<observation>` then exactly one `<summary>`; on no work → `<skip_summary/>`.

### Verification

- [ ] `grep -n "coerceObservationToSummary\|consecutiveSummaryFailures" src/` → zero hits.
- [ ] `grep -n "parseObservations\|parseSummary" src/ | grep -v parser.ts` → zero (callers use `parseAgentXml`).
- [ ] Test: inject garbage-text agent output; assert `pending_messages.status = 'failed'` and no summary row written.
- [ ] Test: inject valid `<observation>` without `<summary>` when `requireSummary=true`; assert `valid:false, reason:'missing_summary'`.
- [ ] RestartGuard still trips after N consecutive failures (unchanged count).

### Anti-pattern guards

- C: Don't coerce "close enough" to `<summary>`. Fail fast.
- A: No new `ParserValidator` class. Pure function returns a result object.

### Blast radius

Files: `parser.ts`, `ResponseProcessor.ts`, possibly `prompts.ts`, `ActiveSession` (remove counter field). No schema changes.

---

## Phase 4 — Delete `SearchManager` pass-throughs

**Outcome**: HTTP route → `SearchOrchestrator` directly. `SearchManager` shrinks to the display-wrap only.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.6
- Verified-finding V11
- `src/services/worker/SearchManager.ts` (2069 lines) and `src/services/worker/http/routes/SearchRoutes.ts`

### Tasks

1. **Route rewire**: `SearchRoutes.ts` handlers call `SearchOrchestrator.search(params)` directly for structured results, then `renderSearchResults(results, format)` (new small helper extracted from current SearchManager) for markdown.
2. **Delete from `SearchManager.ts`**:
   - `queryChroma` (`:59`, `@deprecated`) — delete all call sites first (grep).
   - `searchChromaForTimeline` (`:70`) — delete.
   - Any method whose body is `return this.orchestrator.foo(...)` with no other work.
3. **Keep** the result-combining / grouping / markdown-table code in `SearchManager.search()` as a `renderSearchResults(results, opts)` module. This is real work (V11). Put it in `src/services/worker/search/ResultRenderer.ts` if not already there.
4. **Delete** `filterByRecency` default 90-day filter. Callers pass `dateRange` explicitly.

### Verification

- [ ] `grep -n "class SearchManager" src/` → file either deleted or reduced to < 200 lines of display logic.
- [ ] `grep -n "queryChroma\|searchChromaForTimeline" src/` → zero.
- [ ] `grep -n "filterByRecency" src/` → zero.
- [ ] Integration: `curl '/api/search?q=test&project=cm&format=markdown'` and `format=json` — both return expected shapes.

### Anti-pattern guards

- D: A method that forwards must die.
- C: If Chroma is disabled and `q` is set, return 503 with `error: 'chroma_unavailable'` — don't silently run a SQLite fallback.

### Blast radius

`SearchManager.ts`, `SearchRoutes.ts`, new `ResultRenderer.ts`. No schema changes.

---

## Phase 5 — Delete worker `ProcessRegistry` facade

**Outcome**: Worker talks to `src/supervisor/process-registry.ts` directly. `src/services/worker/ProcessRegistry.ts` becomes a small module of free functions for spawning and SIGTERM→SIGKILL escalation (not a registry).

### Context this phase needs

- `05-clean-flowcharts.md` section 3.8, Part 2 Decision D3
- Verified-findings V5, V6
- `src/services/worker/ProcessRegistry.ts` (527 lines), `src/supervisor/process-registry.ts` (408 lines), `src/services/worker-service.ts` (uses both)

### Tasks

1. **Audit `worker/ProcessRegistry.ts` exports** and rehome:
   - `registerProcess`, `unregisterProcess`, `getProcessBySession`, `getActiveCount`, `waitForSlot`, `getActiveProcesses`, `reapOrphanedProcesses` → these wrap the supervisor's registry. Delete the worker copies; callers switch to `getSupervisor().getRegistry().foo(…)` (already what they ultimately hit).
   - `ensureProcessExit` (`:185`, SIGTERM→SIGKILL escalation) → keep as a free function in a new `src/services/worker/process-control.ts`. Inline the 5-s wait + SIGKILL. Remove the ladder-framework packaging.
   - `createPidCapturingSpawn` (`:393`) → move to `process-control.ts`.
   - `startOrphanReaper` (`:508`) → **delete in Phase 6** (replaced by ReaperTick).
2. **Delete** `src/services/worker/ProcessRegistry.ts` when it's empty.
3. **Update all imports** (grep for `from.*worker/ProcessRegistry` and re-point).

### Verification

- [ ] `test -f src/services/worker/ProcessRegistry.ts` → false.
- [ ] `grep -rn "worker/ProcessRegistry" src/` → zero.
- [ ] All worker + tests still compile: `npx tsc --noEmit`.
- [ ] Manual test: start worker, spawn a summarize subprocess, SIGTERM it → observe SIGKILL after 5 s.

### Anti-pattern guards

- D: Do not add a "compatibility shim" that re-exports the deleted symbols.
- A: `ensureProcessExit` is five lines — don't build a class for it.

### Blast radius

Big import fan-out. Compile-time breakage until all imports are fixed. Runtime: identical behavior (supervisor registry was always the backing store).

---

## Phase 6 — `ReaperTick`: single 30-s timer with three checks

**Outcome**: One `setInterval(30_000)` in `worker-service.ts`. Three skippable checks: prune dead PIDs (every tick), kill hung generators (every 4 ticks), delete abandoned sessions (every 4 ticks). The per-claim 60-s stale reset runs once at boot instead.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.8 subgraph `OneReaper`, Part 4 timer census
- Verified-findings V6, V19
- Phase 5 **MUST** be done.

### Tasks

1. **Create `src/services/worker/reaper.ts`**:
   ```ts
   export function startReaperTick(deps: {
     processRegistry: ProcessRegistry;
     sessionManager: SessionManager;
     pendingStore: PendingMessageStore;
     thresholds?: { generatorIdleMs?: number; sessionIdleMs?: number };
   }): { stop(): void };
   ```
   Internally: tick counter, `reapDeadPids()` every tick, `reapHungGenerators()` + `reapAbandonedSessions()` every 4 ticks. Thresholds: `generatorIdleMs=5*60_000`, `sessionIdleMs=15*60_000`.
2. **Delete `startOrphanReaper`** (`ProcessRegistry.ts:508`) and `staleSessionReaperInterval` (`worker-service.ts:547`). Delete `reapOrphanedProcesses`, `killSystemOrphans`, `killIdleDaemonChildren` as separate functions; fold their bodies into `reapDeadPids`.
3. **Move `PendingMessageStore.claimNextMessage`** stale reset from inside the claim (lines `:99–145`) into a new `PendingMessageStore.recoverStuckProcessing()` method called once at worker boot in `worker-service.ts` after the DB is ready. The claim becomes a clean `SELECT ... LIMIT 1 FOR UPDATE`-equivalent transaction.
4. **Update `worker-service.ts`** shutdown path to `stop()` the ReaperTick before orphan reaper (it's the same thing now).

### Verification

- [ ] `grep -n "setInterval" src/services/worker*/` → exactly one call (inside `reaper.ts`).
- [ ] `grep -n "staleSessionReaperInterval\|startOrphanReaper" src/` → zero.
- [ ] `grep -A3 "STALE_PROCESSING_THRESHOLD_MS" src/services/sqlite/PendingMessageStore.ts` → threshold used only in `recoverStuckProcessing`.
- [ ] Integration test: kill the SDK subprocess for a running session; within 30 s the ProcessRegistry has unregistered and SessionManager entry is gone.
- [ ] Boot recovery test: insert `pending_messages` row with `status=processing, started_processing_at_epoch=epoch-2hr`; start worker; assert row flipped back to `pending` within boot.

### Anti-pattern guards

- B: No polling loops. `claimNextMessage` must not do self-healing on each call.
- A: No `Reaper` class unless a second state ever has to live there. Start as a function.

### Blast radius

Worker lifecycle + SQLite claim path. Risk: reaper timing regression. Mitigation: keep the three thresholds identical to today.

---

## Phase 7 — Transcript watcher cleanup

**Outcome**: `fs.watch(parent_dir, {recursive: true})` instead of 5-s rescan. No `pendingTools` state map (match by `tool_use_id` at line boundary). Direct `ingestObservation` call; no HTTP loopback from inside worker.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.12
- Verified-finding V18
- Phases 2, 5, 6 **MUST** be done.

### Tasks

1. **Rewrite `src/services/transcripts/watcher.ts`**:
   - Replace periodic rescan (`setInterval(… 5000)`) with `fs.watch(parentDir, { recursive: true }, onFileEvent)`. Handle `rename` events to add new files, `change` events to tail existing ones.
   - Delete `rescanIntervalMs` config option and the watcher-internal timer.
2. **Rewrite `src/services/transcripts/processor.ts`**:
   - Remove `pendingTools: Map<string, {name?, input?}>` from `SessionState`.
   - When a JSONL line is a `tool_use` → enqueue into a per-file map keyed by `tool_use_id`. When a later line is a `tool_result` with the same `tool_use_id`, emit one `IngestObservationPayload` and drop the entry. If a tool_use has no tool_result after N lines (say, 10 MB of JSONL read), timeout-log and drop.
3. **Replace HTTP loopback** with `import { ingestObservation } from '…/worker/ingest'` and direct call.
4. **Project-exclusion**: let `ingestObservation` handle it; remove the re-check in the transcript processor.

### Verification

- [ ] `grep -n "setInterval" src/services/transcripts/` → zero.
- [ ] `grep -n "pendingTools" src/` → zero.
- [ ] `grep -n "workerHttpRequest" src/services/transcripts/ src/cli/handlers/observation.ts` → count ≥ 0 (CLI handler can still HTTP the worker; only the *in-process* loopback is forbidden).
- [ ] Integration: drop a new Cursor transcript file into the watched dir; within 1 s a `pending_messages` row appears.

### Anti-pattern guards

- B: No fallback polling "in case fs.watch misses an event". Parent-recursive watch is the contract.
- E: The transcript ingest path and the hook ingest path both call `ingestObservation`. One function, two callers.

### Blast radius

Transcript watcher only. Kept user-facing: Cursor, OpenCode, Gemini-CLI JSONL ingest still works.

---

## Phase 8 — Unified `renderObservations(obs, strategy)`

**Outcome**: One traversal, four strategy configs. `AgentFormatter`, `HumanFormatter`, `ResultFormatter`, and `CorpusRenderer` become strategy definitions that plug into the single renderer.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.5 (context-injection) + Part 2 Decision D4
- Files: `src/services/context/formatters/{AgentFormatter,HumanFormatter}.ts`, `src/services/worker/search/ResultFormatter.ts`, `src/services/worker/knowledge/CorpusRenderer.ts`, all section renderers under `src/services/context/sections/`

### Tasks

1. **Design the renderer contract** in `src/services/rendering/renderObservations.ts`:
   ```ts
   export interface RenderStrategy {
     name: 'agent' | 'human' | 'search' | 'corpus';
     columns: Array<'title'|'narrative'|'facts'|'file'|'date'|'session'|'tokens'>;
     density: 'compact' | 'normal' | 'verbose';
     grouping?: 'none' | 'by-day' | 'by-file' | 'by-session';
     colorize?: boolean; // terminal ANSI
     tokenBudget?: number;
   }
   export function renderObservations(obs: Observation[], strategy: RenderStrategy): string;
   ```
2. **Replace** each of the four formatters with a `RenderStrategy` object (e.g., `AgentContextStrategy`, `HumanContextStrategy`, `SearchResultStrategy`, `CorpusDetailStrategy`). The strategies live in their respective feature folders; the renderer is shared.
3. **Move one-off logic** (ANSI coloring, token budgeting, day-grouping) from the four formatters into the renderer, gated by strategy flags.
4. **Keep** mode filtering + section ordering in the *builder* (`ContextBuilder`) — only the final render step unifies.

### Verification

- [ ] `grep -rn "formatObservation\|renderObservation" src/ | wc -l` — one shared renderer, four strategy files.
- [ ] Snapshot tests: for each strategy, feed the same fixture `Observation[]` and assert output is byte-equal to the old formatter's output.
- [ ] `npm run build-and-sync` + SessionStart injects a context block identical to pre-refactor bytes (modulo strategy-flagged differences).

### Anti-pattern guards

- E: No "almost the same" paths remain. All four formatters end up as thin `export const FooStrategy: RenderStrategy = …` files.
- A: No `RendererFactory`. The renderer is a pure function.

### Blast radius

Pure code reorganization, lowest risk. Snapshot tests are the safety net.

---

## Phase 9 — SQLite consolidation

**Outcome**: Fresh DBs use `schema.sql` (current state). Upgrade-only migrations run for old DBs. `UNIQUE(session_id, tool_use_id)` added. 30-s content-hash dedup window removed. Python repair script gone; user-facing `claude-mem repair` command added.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.3, Part 5 ledger rows for SQLite
- Verified-findings V12, V13, V14
- `src/services/sqlite/migrations/runner.ts`, `src/services/sqlite/observations/store.ts`, `tests/services/sqlite/schema-repair.test.ts`

### Tasks

1. **Add `observations.tool_use_id` column** in a new migration (if not already there — grep the schema). Add `UNIQUE(session_id, tool_use_id)` constraint. For observations without a `tool_use_id` (legacy rows), set a synthetic value like `legacy:<id>` so the UNIQUE doesn't collide.
2. **Rewrite `observations/store.ts`**:
   - Use `INSERT ... ON CONFLICT (session_id, tool_use_id) DO NOTHING RETURNING id`.
   - On conflict, re-SELECT the existing row and return its `id`. Idempotent.
   - Delete `DEDUP_WINDOW_MS`, `findDuplicateObservation`, and the content-hash dedup query. **Keep** the `content_hash` column — it's useful for cross-machine dedup analytics; just don't use it as a dedup gate.
3. **Create `src/services/sqlite/schema.sql`** with the current schema. On fresh DB, run `schema.sql` then write `schema_versions` row at current version. On existing DB, skip `schema.sql` and run only migrations with `version > max(schema_versions.version)`.
4. **Delete the Python repair path** (`execSync('python3 …')`). Add a new CLI subcommand `claude-mem repair` that runs the Python script on demand — this is for users who hit corruption from v<X. Document in a new `docs/public/troubleshooting/repair.mdx` page.
5. **Consolidate migration boilerplate**. 22+ migrations with `CREATE TABLE IF NOT EXISTS` patterns become: `schema.sql` covers everything; remaining upgrade migrations only do `ALTER TABLE` / `CREATE INDEX IF NOT EXISTS` / data migrations.

### Verification

- [ ] Fresh-install test: delete `~/.claude-mem/claude-mem.db`; start worker; assert `schema_versions.version = N` and all expected tables exist.
- [ ] Upgrade test: start worker on an old DB from v6.0; assert all migrations run and the final schema matches `schema.sql`.
- [ ] Dup test: insert two `observations` rows with the same `(session_id, tool_use_id)`; assert second INSERT returns the first row's id and no duplicate row exists.
- [ ] `grep -n "execSync.*python" src/` → zero.
- [ ] `claude-mem repair` command executes without error on a known-corrupt DB fixture.

### Anti-pattern guards

- A: No "schema migration framework". bun:sqlite + a `schema_versions` table + a list of migration functions is enough.
- E: Don't keep both content-hash dedup and UNIQUE(session_id, tool_use_id) as two gates. Pick one (the constraint).

### Blast radius

Highest-risk migration in the plan. Requires backfill of `tool_use_id` for rows that don't have it. Run in a staged release with the `claude-mem repair` fallback.

---

## Phase 10 — Chroma rewrite

**Outcome**: One doc per observation (title + narrative + facts concatenated). Stable ID `obs:<sqlite_rowid>`. Upsert instead of delete-then-add. `chroma_synced` boolean column on `observations`; backfill only rows where the flag is false. Full-project scan on boot deleted.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.4
- Verified-findings V15, V16, V17
- `src/services/sync/ChromaSync.ts:125–545`
- Phase 9 **MUST** be done (so `chroma_synced` migration can land alongside).

### Tasks

1. **Migration**: add `chroma_synced INTEGER DEFAULT 0` column to `observations` and `session_summaries`.
2. **Rewrite `ChromaSync.formatObservationAsDoc`**: one doc per observation. Text = `title + "\n\n" + narrative + "\n\n" + facts.join("\n")`. ID = `obs:${sqliteRowId}`. Metadata keeps project, session_id, timestamp, type. Same for summaries (one doc, stable ID).
3. **Replace `chromaSync.syncObservation`** write path: `chroma_mcp.upsert(id, text, metadata)`. On success: `UPDATE observations SET chroma_synced=1 WHERE id=?`. On failure: `logger.warn`, leave flag 0.
4. **Replace `ensureBackfilled` + `runBackfillPipeline` + `getExistingChromaIds`** with a simple `backfillUnsynced(limit=1000)` called **once at boot**. Query: `SELECT id FROM observations WHERE chroma_synced=0 LIMIT 1000`. For each: format → upsert → mark.
5. **Delete** `backfillAllProjects` (static), `ensureBackfilled`, `runBackfillPipeline`, `getExistingChromaIds`, `formatObservationsAsDocs`, `formatSummariesAsDocs` (multi-doc), and the delete-then-add conflict handler.

### Verification

- [ ] Chroma index contains one doc per observation (not 7). Query Chroma directly: `chroma_count_documents(collection)` = `SELECT COUNT(*) FROM observations WHERE chroma_synced=1`.
- [ ] Idempotent re-sync: call `syncObservation` twice with same ID; assert no conflict, one doc.
- [ ] Boot with Chroma down: observations sync'd to SQLite normally, `chroma_synced=0`. Start Chroma, restart worker: those rows upserted within boot.
- [ ] `grep -n "backfillAllProjects\|ensureBackfilled\|getExistingChromaIds" src/` → zero.

### Anti-pattern guards

- C: On Chroma failure at write time, do **not** throw — leave flag 0 and move on. The backfill path covers recovery.
- A: No `ChromaBackfillScheduler`. One function, called at boot, done.

### Blast radius

Chroma index regenerates under the new doc shape. Users see the old index until the first boot-time backfill completes (may take minutes on large corpora).

---

## Phase 11 — Endpoint consolidation

**Outcome**: 10 session endpoints → 4. `/api/session/start` returns context + semantic in one call. `/api/session/end` blocks until summary written or 110-s timeout (no hook-side polling). `/api/context/inject` + `/api/context/semantic` deleted or folded.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.1, section 3.9 (Routes inventory), Part 2 Decision D6
- Verified-findings V8, V9, V10
- `src/services/worker/http/routes/SessionRoutes.ts`, `src/services/worker/http/routes/SearchRoutes.ts`, `src/cli/handlers/{context,user-message,summarize,session-complete}.ts`

### Tasks

1. **New endpoints** (4 total):
   - `POST /api/session/start` — body: `{project, claudeSessionId}`. Returns `{sessionDbId, contextMarkdown, semanticMarkdown}`. Internally: calls `ContextBuilder.generateContext` + `SearchOrchestrator.search`.
   - `POST /api/session/prompt` — body: `{sessionDbId, prompt}`. Returns `{promptId}`.
   - `POST /api/session/observation` — body: `{sessionDbId, tool_use_id, name, input, output}`. Returns `{observationId|null, skipped}`.
   - `POST /api/session/end` — body: `{sessionDbId, last_assistant_message}`. **Blocks** until the queue is drained and the summary row is written (or 110-s timeout). Returns `{summaryId|null}`.
2. **Blocking `/api/session/end`**: implement via a per-session `Deferred<SummaryResult>`. When `ResponseProcessor` writes the summary row, resolve the deferred. Route handler `await`s the promise with a 110-s race.
3. **Delete the old 10 endpoints** under `/sessions/:sessionDbId/*` and `/api/sessions/*` after all hook-side callers are switched. Also delete `/api/context/inject` and `/api/context/semantic`.
4. **Rewrite hook handlers** (`context.ts`, `user-message.ts`, `summarize.ts`, `session-complete.ts`) to use the 4 new endpoints. Delete the 500-ms polling loop in `summarize.ts:117–150`.
5. **Hook-side `ensureWorkerRunning` cache**: create `src/hooks/worker-cache.ts` that caches `alive=true` in module scope for the hook process. First call spawns/HTTPs `/health`; subsequent calls skip. Switch all 8 handlers to import from this module.

### Verification

- [ ] `grep -n "router\.\(get\|post\|delete\)" src/services/worker/http/routes/SessionRoutes.ts` → 4 routes.
- [ ] `grep -n "/api/context/inject\|/api/context/semantic" src/` → zero.
- [ ] `grep -n "POLL_INTERVAL_MS\|MAX_WAIT_FOR_SUMMARY_MS" src/cli/handlers/` → zero.
- [ ] Integration: run a full session lifecycle; assert Stop hook returns within ~110 s (or earlier) with a `summaryId`, and no /status polling requests hit the worker.
- [ ] Perf: SessionStart latency ≤ previous latency (one request vs two).

### Anti-pattern guards

- B: No polling. Blocking + timeout replaces it.
- D: `/api/session/start` must not be a facade over `/api/context/inject`; the old endpoints are deleted.

### Blast radius

Hook ↔ worker HTTP contract changes. Needs coordinated plugin rebuild (`npm run build-and-sync`). Old hooks calling old endpoints will 404 — land after a version bump.

---

## Phase 12 — Zod validator middleware

**Outcome**: Per-route Zod schema + one `validateBody(schema)` middleware. Per-route hand-rolled validation gone.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.9
- `src/services/worker/http/routes/*.ts` (8 files with inline validation)

### Tasks

1. **Add `zod`** to `package.json` dependencies (confirm not already present; if it is, skip).
2. **Create `src/services/worker/http/middleware/validateBody.ts`**:
   ```ts
   export function validateBody<T>(schema: z.ZodType<T>): RequestHandler { … }
   ```
   On parse failure: `res.status(400).json({ error: 'validation_failed', fields: result.error.flatten() })`.
3. **Per-route schemas** in a parallel `schemas/` directory (or inline at top of each route file). One `z.object({…})` per endpoint.
4. **Delete** per-route boilerplate: manual `typeof x !== 'string'` checks, `if (!body.foo) return res.status(400)…`.

### Verification

- [ ] `grep -n "res.status(400)" src/services/worker/http/routes/ | wc -l` significantly reduced (only routes that return 400 for domain reasons, not shape validation).
- [ ] Error-shape tests: each endpoint, with invalid body, returns `{error, message, code, fields}`.
- [ ] No behavioral regression on happy path (snapshot test of responses).

### Anti-pattern guards

- A: Don't invent `ZodUtil.assertBody` — use `safeParse` directly.
- E: Single middleware, not one per route.

### Blast radius

HTTP error shape might change slightly (field names in 400s). Client (viewer UI) must tolerate `fields` key.

---

## Phase 13 — KnowledgeAgent simplification

**Outcome**: No `session_id` persistence in `corpus.json`. No `prime` endpoint. No auto-reprime regex. `build` IS prime; every `query` loads the corpus fresh as system prompt.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.11
- `src/services/worker/knowledge/KnowledgeAgent.ts`, `CorpusStore.ts`, `CorpusBuilder.ts`, corresponding routes in `CorpusRoutes.ts`

### Tasks

1. **Delete** `KnowledgeAgent.prime` and the `reprime` endpoint. Update the OpenAPI/route table to drop them.
2. **Simplify `CorpusStore`**: corpus JSON contains `{name, filters, renderedCorpus, generatedAt}`. No `session_id`.
3. **Rewrite `KnowledgeAgent.query`** to always pass `systemPrompt = renderedCorpus` to the SDK. Claude prompt-caching reduces cost when the same corpus is queried repeatedly within the 5-min TTL.
4. **Delete** the session-expiration regex match and auto-reprime path.

### Verification

- [ ] `grep -n "session_id" src/services/worker/knowledge/` → zero.
- [ ] `grep -n "reprime\|auto.*reprime" src/` → zero.
- [ ] Cost test: query the same corpus 3× within 5 min; assert cache hits (the SDK returns `cache_read_input_tokens > 0`).
- [ ] `POST /api/corpus/:name/rebuild` still works; `POST /api/corpus/:name/prime` returns 404.

### Anti-pattern guards

- C: Don't try to "detect session expiration". Always pass fresh system prompt; let the SDK cache decide.

### Blast radius

Corpus JSON format changes (drops `session_id`). Existing corpora still load (extra field ignored or migrated on read).

---

## Phase 14 — HTTP cleanup

**Outcome**: Rate limiter deleted. Static file reads cached at boot.

### Context this phase needs

- `05-clean-flowcharts.md` section 3.9
- Verified-finding V20
- `src/services/worker/http/middleware.ts:45–79`, `ViewerRoutes.ts`

### Tasks

1. **Delete `src/services/worker/http/middleware.ts:45–79`** (the rate limiter) and its registration in `Middleware.ts`.
2. **Cache `viewer.html`** and `/api/instructions` content in memory at boot; serve from `Buffer` instead of `fs.readFile`.
3. **Delete** the legacy `SessionRoutes.handleObservations` no-privacy-strip endpoint (already handled in Phase 2 if the route is rewired; this is the cleanup pass).

### Verification

- [ ] `grep -n "RATE_LIMIT_WINDOW_MS\|RATE_LIMIT_MAX_REQUESTS" src/` → zero.
- [ ] Boot time: `viewer.html` hits don't cause `fs.readFile` calls (measure with lsof or a log statement).

### Anti-pattern guards

- B: Don't re-introduce the rate limiter as a "config flag". Localhost trust model is explicit.

### Blast radius

Minimal. The rate limiter was theater on a localhost server.

---

## Phase 15 — Final verification

**Outcome**: Whole system behaves per the clean flowcharts. Timer census reads 1 repeating timer. No polling loops. No silent fallbacks. Deleted-lines counter ≥ 2500 net.

### Tasks

1. **Run the timer census**:
   ```
   grep -rn "setInterval\|setTimeout.*recursive\|setTimeout.*repeat" src/ | grep -v test
   ```
   Expected: one `setInterval` in `reaper.ts`; one per-session idle timeout; one EventSource reconnect (UI); no others. Compare against `05-clean-flowcharts.md` Part 4.
2. **Anti-pattern grep pass**:
   - `grep -rn "coerceObservationToSummary\|consecutiveSummaryFailures\|DEDUP_WINDOW_MS\|STALE_PROCESSING_THRESHOLD_MS.*claimNextMessage\|backfillAllProjects\|getExistingChromaIds\|stripMemoryTagsFromJson\|stripMemoryTagsFromPrompt\|POLL_INTERVAL_MS" src/` → zero matches.
   - `grep -rn "res.status(503)" src/` includes `chroma_unavailable` path (positive check).
3. **Deleted-lines count**: `git diff main --stat | tail -1` — compare against the audit's Part 5 estimate (~2500 net).
4. **Run full test suite**: `npm test`.
5. **Run plugin end-to-end**: `npm run build-and-sync` → trigger all 5 lifecycle hooks in a real Claude Code session → verify SSE events, viewer UI renders, search works, corpus builds + queries, transcript watcher picks up a synthetic Cursor log.
6. **Document**: update `docs/public/architecture.mdx` (or equivalent) to point at `05-clean-flowcharts.md` as the canonical architecture doc.

### Verification

- [ ] Timer census matches `05-clean-flowcharts.md` Part 4 "after" column.
- [ ] All grep anti-pattern checks return zero matches.
- [ ] Full test suite green.
- [ ] End-to-end plugin test passes.

---

## Phase dependency graph

```
P1 ─┐
    ├─> P2 ─┬─> P3
    │      ├─> P6 ─> P7
    │      └─> P11
    │
P4  (independent)
P5  ──> P6 (already sequenced above)
P8  (independent — can run anytime)
P9  ──> P10
P11 ──> P12 (Zod lands after endpoint shape is final)
P13 (independent)
P14 (after P11 so legacy route delete is clean)
P15 gates merge.
```

Parallelizable tracks: (P1→P2→P3), (P4), (P5→P6→P7), (P8), (P9→P10), (P13). Merge order: P1,P2,P3,P4,P5,P6,P7,P8,P9,P10,P11,P12,P13,P14,P15.

---

## Estimated effort

Per `05-clean-flowcharts.md` Part 6: ~18 engineer-days for full clean-through. Phase 1 alone closes the P1 security gap (<1 day).

## Success criteria

- One `setInterval` in the worker codebase.
- Zero polling loops on the hook side.
- 40 bullshit items from `05-clean-flowcharts.md` Part 1 all deleted (verified by grep).
- All 12 user-facing features from Pathfinder Phase 0 still work.
- Net LOC deleted ≥ 1800.
