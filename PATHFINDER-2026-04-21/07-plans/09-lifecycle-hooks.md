# Phase Plan 09 — lifecycle-hooks (clean)

**Date**: 2026-04-22
**Target flowchart**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` §3.1 ("lifecycle-hooks (clean)")
**Before-state**: `PATHFINDER-2026-04-21/01-flowcharts/lifecycle-hooks.md`
**Scope**: Collapse the 10 current `SessionRoutes` endpoints + the 500-ms polling Stop hook + the 8 per-handler `ensureWorkerRunning` calls + the duplicate `/api/context/*` fetches into the clean 4-endpoint, no-polling, hook-cached design from §3.1. **Zero user-facing change. Exit codes preserved.**

---

## Header: Dependencies

**Upstream (must land first):**
- **Plan 01 — privacy-tag-filtering** (Phases 1–2 of the implementation plan — `stripMemoryTags` + `ingestObservation/ingestPrompt/ingestSummary` helpers). Required because the new `POST /api/session/observation`, `POST /api/session/prompt`, and `POST /api/session/end` endpoints call those ingest helpers rather than re-implementing tag stripping. Cite: `06-implementation-plan.md` Phase 1 + Phase 2 (plan authoring pipeline; `01-privacy-tag-filtering.md` when landed).
- **Plan 05 — context-injection-engine** — introduces `GET /api/session/start` returning `{sessionDbId, contextMarkdown, semanticMarkdown}`. Phase 1 of this plan depends on that endpoint existing on the worker side. Cite: `05-clean-flowcharts.md` §3.5 + §3.1 arrow `SS → SSR`.
- **Plan 07 — session-lifecycle-management** — introduces blocking `POST /api/session/end` (per-session `Deferred<SummaryResult>` resolved by `ResponseProcessor` when the summary row is written; 110 s hard timeout). Phase 3 of this plan switches the Stop hook to call that endpoint. Cite: `05-clean-flowcharts.md` §3.8 (`POST /api/session/end → queueSummarize → await summary_stored flag OR 110s timeout`), Part 2 decision **D6** (blocking endpoints over polling), `06-implementation-plan.md` Phase 11 step 2.

**Downstream:** none. This is a leaf cleanup in the dependency DAG — no other feature plan reads from the hook layer.

---

## Sources Consulted (what this plan is built from)

1. `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — full read. Authoritative §3.1 diagram (lines 89–123); §3.9 route inventory (lines 382–418); Part 1 bullshit-inventory items **#11** (500 ms poll), **#12** (double `/api/context/inject`), **#13** (`ensureWorkerRunning` every entry), **#14** (`/api/context/inject` + `/api/context/semantic` both at UserPromptSubmit); Part 2 decision **D6** (blocking endpoints over polling, line 79); Part 4 timer census (Summary poll 500 ms × 220 iter → endpoint blocks, line 520); Part 5 deletion ledger rows `Summarize 500-ms polling hook -60/+20` and `Double /api/context/* fetches → /api/session/start -120/+60` (lines 552–553).
2. `PATHFINDER-2026-04-21/06-implementation-plan.md` — Phase 0 verified-findings **V8** (500 ms poll @ `summarize.ts:117–150`, `POLL_INTERVAL_MS=500` @ `:24`, `MAX_WAIT_FOR_SUMMARY_MS=110_000` @ `:25`), **V9** (SessionRoutes is **actually 10 endpoints, not 8**: six `/sessions/:sessionDbId/*` at `:377–:382` + five `/api/sessions/*` at `:385–:389`; `/api/sessions/status` is the polled one), **V10** (`ensureWorkerRunning` in all 8 CLI handlers: `context.ts:19`, `user-message.ts:35`, `summarize.ts:44`, `observation.ts:34`, `file-context.ts:218`, `file-edit.ts:32`, `session-init.ts:41`, `session-complete.ts:35`). Phase 2 (unified ingest helpers) and Phase 11 (endpoint consolidation) define the shared contract.
3. `PATHFINDER-2026-04-21/01-flowcharts/lifecycle-hooks.md` — "before" diagram. 10 hook→worker HTTP edges enumerated (lines 84–92 — side effects). Two-phase Stop handling (`summarize` → poll → `session-complete`) at lines 68–73.
4. Live codebase (verified `Read`/`Grep` during authoring, 2026-04-22):
   - `src/cli/handlers/context.ts:19` — `await ensureWorkerRunning()` at SessionStart.
   - `src/cli/handlers/user-message.ts:35` — `await ensureWorkerRunning()` at SessionStart (parallel).
   - `src/cli/handlers/session-init.ts:41` — UserPromptSubmit.
   - `src/cli/handlers/observation.ts:34` — PostToolUse.
   - `src/cli/handlers/summarize.ts:17` (import), `:24` (`POLL_INTERVAL_MS = 500`), `:25` (`MAX_WAIT_FOR_SUMMARY_MS = 110_000`), `:44` (`ensureWorkerRunning`), `:89` (`POST /api/sessions/summarize`), `:117–150` (poll loop against `/api/sessions/status?contentSessionId=…`), `:156` (`POST /api/sessions/complete`).
   - `src/cli/handlers/session-complete.ts:18` (`POST /api/sessions/complete`), `:35` (`ensureWorkerRunning`).
   - `src/cli/handlers/file-context.ts:218` (`ensureWorkerRunning`), `:237` (`GET /api/observations/by-file`).
   - `src/cli/handlers/file-edit.ts:15` (`POST /api/sessions/observations`), `:32` (`ensureWorkerRunning`).
   - `src/services/worker/http/routes/SessionRoutes.ts:375–389` — `setupRoutes` registers **10** routes:
     - Legacy `/sessions/:sessionDbId/*` × **6** (`:377` init, `:378` observations, `:379` summarize, `:380` status, `:381` delete, `:382` complete).
     - `/api/sessions/*` × **5** (`:385` init, `:386` observations, `:387` summarize, `:388` complete, `:389` status).
     - (Earlier sections above register `:setupRoutes` itself on the Express app; the 11 `.get/.post/.delete(` tokens outside `setupRoutes` are internal maps, not routes — verified.)
   - `src/shared/hook-constants.ts:21–22` — `HOOK_EXIT_CODES.SUCCESS = 0`. Every handler returns it on the graceful-degradation path (required by CLAUDE.md exit-code strategy — Windows Terminal tab preservation depends on exit 0).
5. Dependency plans: **not yet written on disk**. Plans 01, 05, 07 will be authored in parallel to this one; citations above reference their planned phase numbers per `06-implementation-plan.md` (authoritative sequencing doc).

---

## Endpoint Reality Check (numbers — V9 vs §3.9 claim)

| Source | Claimed current count | Verified current count |
|---|---|---|
| `05-clean-flowcharts.md` §3.1 "Endpoint count: 8 → 4" (line 123) | 8 | — |
| `06-implementation-plan.md` Phase 0 **V9** | — | **10** (six `:377–:382` + five `:385–:389`) |
| Live `Grep router\.` / `.post/.get/.delete` on `SessionRoutes.ts` (2026-04-22) | — | **10** (confirms V9; §3.9 "8" is an undercount) |

**This plan uses 10 → 4** as the verified target. The §3.1 "8 → 4" claim is footnoted as an undercount of the legacy `/sessions/:sessionDbId/*` subtree.

---

## Hook → Endpoint Mapping (current vs clean)

| Claude Code event | Current hook handler | Current endpoints called | Clean endpoint (§3.1) |
|---|---|---|---|
| SessionStart | `context.ts` | `GET /api/context/inject?projects=…` (`:41`) + (conditionally) `GET /api/context/inject?colors=true` (`:42`) | **`GET /api/session/start?project=…`** — returns `{sessionDbId, contextMarkdown, semanticMarkdown}` |
| SessionStart (parallel) | `user-message.ts` | `GET /api/context/inject?project=…&colors=true` (`:14`) | (same) — reads from the cached `/api/session/start` response in `context.ts`; no second HTTP call |
| UserPromptSubmit | `session-init.ts` | `POST /api/sessions/init` (`:75`), `POST /sessions/{id}/init` (`:141`), `POST /api/context/semantic` (`:23`) | **`POST /api/session/prompt`** `{sessionDbId, prompt}` → returns `{promptId}` (SDK-start implicit inside prompt handler) |
| PostToolUse | `observation.ts` | `POST /api/sessions/observations` (`:17`) | **`POST /api/session/observation`** `{sessionDbId, tool_use_id, name, input, output}` → `{observationId}` |
| PostToolUse (Cursor file-edit) | `file-edit.ts` | `POST /api/sessions/observations` (`:15`) | **`POST /api/session/observation`** (same endpoint, same payload shape) |
| PreToolUse (file-context gate) | `file-context.ts` | `GET /api/observations/by-file` (`:237`) | Unchanged — this is a read endpoint outside the Session lifecycle; belongs to Plan 08 (DataRoutes), not this one |
| Stop | `summarize.ts` | `POST /api/sessions/summarize` (`:89`) + poll `GET /api/sessions/status` 500 ms × up to 220 iter (`:117–150`) + `POST /api/sessions/complete` (`:156`) | **`POST /api/session/end`** `{sessionDbId, last_assistant_message}` — blocks until summary written or 110 s timeout; returns `{summaryId|null}` |
| Stop (phase 2) | `session-complete.ts` | `POST /api/sessions/complete` (`:18`) | **Deleted.** Folded into `POST /api/session/end` (§3.1: "Two-phase Stop handling (summarize then session-complete) — one endpoint, one response"). |

**Endpoints before**: 10 on `SessionRoutes` + 2 on `SearchRoutes` (`/api/context/inject`, `/api/context/semantic`) = 12 lifecycle-touching endpoints.
**Endpoints after**: 4 on `SessionRoutes` (`start`, `prompt`, `observation`, `end`). `/api/context/*` removed (folded into `/api/session/start`).
**Net delete**: 10 − 4 = **6 from SessionRoutes**; **2 from SearchRoutes**; **8 total**.

---

## Phase Contract (applied to every phase below)

Each phase specifies:
- **(a) What to implement** — "Copy from §X.Y / V-finding / file:line" — no invention.
- **(b) Docs** — `05-clean-flowcharts.md` section + `V8/V9/V10` + live file:line.
- **(c) Verification** — grep counts, before/after.
- **(d) Anti-pattern guards** — **A** (invent hook event types), **B** (polling — replace 500 ms loop with blocking endpoint + SSE), **D** (two context fetches collapse to one `GET /api/session/start`), **E** (duplicate `/api/context/inject` at SessionStart + user-message — single cache).

---

## Phase 1 — Collapse double `/api/context/*` fetches into single `GET /api/session/start`

### (a) What to implement

Copy from `05-clean-flowcharts.md` §3.1 lines 95, 100 (`SS --> SSR["Returns {sessionDbId, contextMarkdown, semanticMarkdown}"]`) and §3.5 line 236 (`generateContext(projects, forHuman=false)` + `generateContext(projects, forHuman=true)` on one route handler).

Switch `context.ts` + `user-message.ts` to a **single** `GET /api/session/start` call. The worker route is produced by Plan 05 Phase 1; this phase only rewires the two hook handlers.

1. **Rewrite `src/cli/handlers/context.ts:41–74`**: replace the two-URL `Promise.all([workerHttpRequest(apiPath), showTerminalOutput ? workerHttpRequest(colorApiPath).catch(()=>null) : …])` with one `workerHttpRequest('/api/session/start?project=…&colors=…&semantic=…')`. Parse response as `{sessionDbId, contextMarkdown, humanMarkdown?, semanticMarkdown}`. `contextMarkdown` → `additionalContext`; `humanMarkdown` (present when `colors=true`) → `systemMessage` block.
2. **Delete `user-message.ts:fetchAndDisplayContext` (lines 13–30) entirely.** The parallel SessionStart display becomes a second consumer of `context.ts`'s cached `/api/session/start` result — see Phase 2 for the shared cache. In the interim (before Phase 2 lands), `user-message.ts` calls `/api/session/start?colors=true&display=true` with its own request — one HTTP call, still replaces the old `/api/context/inject` double-call. Remove the `fetchAndDisplayContext` helper + its usage at `:46`.
3. **Delete hook-side calls to `/api/context/inject`** anywhere they appear. Grep: only `context.ts:41,42` + `user-message.ts:14–16` touch it. After this phase: zero hook-side references to `/api/context/inject`.
4. `session-init.ts:23` (`POST /api/context/semantic`) moves to Phase 6 (consolidated with session-prompt); leave untouched here.

### (b) Docs

- §3.1 lines 95, 100 — `SS → SSR` edge.
- §3.5 line 236 — `generateContext(projects, forHuman=false)` + `generateContext(projects, forHuman=true)` (dual-strategy render).
- Part 1 items **#12** ("double `/api/context/inject` at SessionStart") and **#14** ("`/api/context/inject` + `/api/context/semantic` both at UserPromptSubmit — fold into `/api/session/start`").
- **V10** — both `context.ts:19` and `user-message.ts:35` currently bootstrap the worker then each fire a GET.
- Live: `src/cli/handlers/context.ts:41–74`, `src/cli/handlers/user-message.ts:13–30,46`.

### (c) Verification

```
grep -rn "/api/context/inject" src/cli/handlers/          → 0 matches
grep -rn "/api/session/start" src/cli/handlers/            → 2 matches (context.ts + user-message.ts)
grep -c "workerHttpRequest" src/cli/handlers/context.ts    → 1 (was 2 — the `apiPath` + `colorApiPath` pair collapses)
```

Snapshot test: capture `additionalContext` bytes from an existing SessionStart fixture and assert byte-equal after the rewire (strategy-driven rendering must be indistinguishable in `forHuman=false` mode).

### (d) Anti-pattern guards

- **D** — no two fetches for the same data. `/api/session/start` is one request returning both markdowns.
- **E** — the parallel SessionStart display in `user-message.ts` shares the response shape; Phase 2 collapses to one cache entry.
- **A** — no new `hookEventName` values. Still `'SessionStart'` at `context.ts:88`.

---

## Phase 2 — Cache `alive=true` in the hook process for the session lifetime

### (a) What to implement

Copy from `05-clean-flowcharts.md` §3.1 "Deleted from old flowchart" bullet 1 ("`ensureWorkerRunning` at every entry point (cache `alive` for the hook lifetime)") + Part 1 item **#13** ("Hook has no shared state. — Cache `alive=true` in the hook process for the session.").

1. **Create `src/hooks/worker-cache.ts`** (new file, ~25 lines):
   ```ts
   // One variable in the hook's process; lives as long as the hook process does.
   let alive: boolean | null = null;
   // Cached /api/session/start response, shared between context + user-message handlers
   // within the same hook process (invoked once per SessionStart fan-out).
   let sessionStartResponse: SessionStartResponse | null = null;

   export async function ensureWorkerAliveOnce(): Promise<boolean> {
     if (alive !== null) return alive;
     alive = await originalEnsureWorkerRunning();
     return alive;
   }

   export function cacheSessionStart(response: SessionStartResponse): void { sessionStartResponse = response; }
   export function getCachedSessionStart(): SessionStartResponse | null { return sessionStartResponse; }
   ```
   "Hook process" = one Node/Bun invocation per Claude Code hook event. Lifetime ~50 ms – ~120 s. Module-scope `let` is sufficient; no cross-process state needed.

2. **Switch all 8 CLI handlers** to import `ensureWorkerAliveOnce` instead of `ensureWorkerRunning`:
   - `context.ts:19`, `user-message.ts:35`, `summarize.ts:44`, `observation.ts:34`, `file-context.ts:218`, `file-edit.ts:32`, `session-init.ts:41`, `session-complete.ts:35`.
3. **First-call behaviour**: the first handler in a given hook process spawns/pings the worker (same code path as today's `ensureWorkerRunning` in `src/shared/worker-utils.ts`). Subsequent calls in the **same process** skip.
4. **Cross-handler coordination for SessionStart**: when `context.ts` receives the `/api/session/start` response it calls `cacheSessionStart(response)`. `user-message.ts` (running as a parallel handler in the same hook process when both are wired to SessionStart) calls `getCachedSessionStart()` first; falls back to its own fetch if null (separate hook-process invocations).

### (b) Docs

- §3.1 "Deleted from old flowchart" bullet 1.
- Part 1 item **#13**.
- **V10** — 8 live callsites today.
- Live: `src/shared/worker-utils.ts` (current `ensureWorkerRunning` implementation is the one `ensureWorkerAliveOnce` delegates to internally).

### (c) Verification

```
grep -rn "ensureWorkerRunning" src/cli/handlers/           → 0 matches (was 8 import lines + 8 callsites)
grep -rn "ensureWorkerAliveOnce" src/cli/handlers/         → 8 import + 8 callsite matches
grep -c "ensureWorkerRunning" src/cli/handlers/*.ts        → reduces from 8 to 0 (cached)
```

Instrumentation test: start a Claude Code session, trigger SessionStart → UserPromptSubmit → 2× PostToolUse → Stop. Assert the worker's `GET /health` (or equivalent startup ping) is called **once** per hook process, not once per handler. (Today it's 5 calls in the SessionStart fan-out alone.)

### (d) Anti-pattern guards

- **E** — one cache, two readers (`context.ts` + `user-message.ts`). No duplicate cache keys.
- **A** — no `WorkerCacheService` class. Module-scope `let` is sufficient; adding a class would be invention (CLAUDE.md: YAGNI, simple-first).

### Exit-code invariant

The caller still returns `HOOK_EXIT_CODES.SUCCESS` when `ensureWorkerAliveOnce()` returns `false` (worker unavailable → empty context → exit 0). CLAUDE.md exit-code strategy preserved: Windows Terminal tabs continue to close on exit 0 even when the worker is down.

---

## Phase 3 — Replace `summarize.ts` 500 ms poll loop with single blocking `POST /api/session/end`

### (a) What to implement

Copy from `05-clean-flowcharts.md` §3.1 lines 98, 107 (`STOP --> STOPR["Returns {summaryId or null}"]`) + §3.8 lines 346–349 (`POST /api/session/end → queueSummarize → await summary_stored flag OR 110s timeout → abortController.abort → Delete`) + Part 2 decision **D6**. The worker-side blocking endpoint is implemented by Plan 07 Phase 2 (per-session `Deferred<SummaryResult>` resolved by `ResponseProcessor` when the summary row is written).

1. **Rewrite `src/cli/handlers/summarize.ts:86–167`** (the queue + poll + complete block) into:
   ```ts
   const response = await workerHttpRequest('/api/session/end', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ contentSessionId: sessionId, last_assistant_message: lastAssistantMessage, platformSource }),
     timeoutMs: MAX_WAIT_FOR_SUMMARY_MS + 5_000  // 115s — hook times out slightly after server
   });
   // Response: { summaryId: number | null, timedOut?: boolean }
   ```
2. **Delete constants** `POLL_INTERVAL_MS = 500` (`:24`) and `POLL_INTERVAL_MS` references. `MAX_WAIT_FOR_SUMMARY_MS` stays — migrates from poll-duration cap to HTTP-client timeout (preserves the 110 s semantic).
3. **Delete the poll loop** (`summarize.ts:117–150`).
4. **Delete the explicit session-complete call** (`summarize.ts:155–161`) — folded into the worker's `/api/session/end` handler on the other side of the wire.
5. **Preserve the subagent guard** at `:34–41` (exits early before any HTTP).
6. **Preserve the transcript-extract guard** at `:60–78` (exits 0 when no assistant message).
7. **Preserve the exit-code contract**: successful completion, timeout, and worker-unreachable all return `HOOK_EXIT_CODES.SUCCESS` (exit 0). This matches today's `summarize.ts:47,56,67,77,103,107,167` — every return path exits 0. CLAUDE.md exit-code strategy: Windows Terminal closes tabs on exit 0, so the 110 s timeout path must also exit 0, not 2.

### (b) Docs

- §3.1 lines 98, 107 — STOP edge.
- §3.8 lines 346–349 — `End → Queue_Sum → WaitSum → Abort → Delete`.
- Part 2 **D6** (blocking endpoints over polling, line 79).
- Part 4 timer census line 520 (`Summary poll (500 ms × 220 iter)` ✓ before / ✗ after).
- **V8** — `summarize.ts:117–150` + `:24` + `:25`.
- **V9** — `/api/sessions/status` is deleted in Phase 5.
- Live: `src/cli/handlers/summarize.ts:24–25,86–167`.

### (c) Verification

```
grep -n "POLL_INTERVAL_MS" src/                            → 0 matches
grep -n "MAX_WAIT_FOR_SUMMARY_MS" src/cli/handlers/summarize.ts → 1 match (used as HTTP timeout)
grep -n "/api/sessions/status" src/                        → 0 matches in src/cli/
grep -n "/api/session/end" src/cli/handlers/summarize.ts   → 1 match
wc -l src/cli/handlers/summarize.ts                        → < 90 (was 169)
```

End-to-end: run a Claude Code session that produces a summary. Assert the Stop hook returns within ~(summary-processing time + 1 s), not ≥500 ms (the old minimum due to the first poll interval). Assert no `GET /api/sessions/status` requests hit the worker log.

Timeout path test: configure the SDK agent to hang past 110 s. Assert Stop hook returns exit 0 with `summaryId: null, timedOut: true`. **This is the exit-code invariant that CLAUDE.md's Windows Terminal note demands — confirm explicitly** (see "Confidence + Gaps" below).

### (d) Anti-pattern guards

- **B** — polling replaced by blocking endpoint + HTTP-client timeout. The hook-side client timeout is `MAX_WAIT_FOR_SUMMARY_MS + 5_000` to give the server side first claim on the 110 s budget.
- **A** — no new `SessionStopResult` type; reuse the existing `{summaryId, timedOut?}` shape Plan 07 Phase 2 defines.

---

## Phase 4 — Delete `/sessions/:sessionDbId/*` legacy endpoints (6)

### (a) What to implement

Copy from `06-implementation-plan.md` Phase 11 step 3 ("Delete the old 10 endpoints under `/sessions/:sessionDbId/*` and `/api/sessions/*` after all hook-side callers are switched"). Also §3.9 line 403 (SessionRoutes: "`/api/session/*` (4 endpoints — see 3.1)").

1. **Delete registrations** at `SessionRoutes.ts:377–382`:
   - `app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));`
   - `app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));`
   - `app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));`
   - `app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));`
   - `app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));`
   - `app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));`
2. **Delete handler methods** `handleSessionInit`, `handleObservations`, `handleSummarize`, `handleSessionStatus`, `handleSessionDelete`, `handleSessionComplete` (the legacy six) if no other code references them.
3. Keep the `handle*ByClaudeId` variants in place *for this phase* — Phase 5 deletes `/api/sessions/status` specifically; Phase 6 replaces the remaining four `/api/sessions/*` with the unified four `/api/session/*`.

### (b) Docs

- §3.1 line 123 ("Endpoint count: 8 → 4") — corrected to **10 → 4** per V9.
- §3.9 line 403 — final target `R3["SessionRoutes: /api/session/* (4 endpoints — see 3.1)"]`.
- **V9**.
- Live: `src/services/worker/http/routes/SessionRoutes.ts:377–382`.

### (c) Verification

```
grep -n "app\.\(post\|get\|delete\)\('/sessions/" src/services/worker/http/routes/SessionRoutes.ts → 0 matches
grep -n "app\.\(post\|get\|delete\)\('/api/sessions/" src/services/worker/http/routes/SessionRoutes.ts → 5 matches (Phase 5+6 reduce to 0)
wc -l src/services/worker/http/routes/SessionRoutes.ts   → drops by ~250 lines (legacy handlers removed)
```

Integration test: send `POST /sessions/1/init` to a running worker. Assert `404`. Send to `/api/session/prompt` (Phase 6's replacement). Assert `200`.

### (d) Anti-pattern guards

- **D** — pure deletion; no "forwarding shim" to the new endpoints.
- **A** — no "LegacySessionRoutes" compatibility module. Delete means delete. Users who pinned an old plugin version still have the old worker binary shipped with their install.

---

## Phase 5 — Delete `/api/sessions/status` (polling endpoint is obsolete)

### (a) What to implement

Copy from §3.1 "Deleted from old flowchart" bullet 5 ("500-ms poll loop on `/api/sessions/status` (replaced by blocking `/api/session/end`)"). Phase 3 removes the only consumer; this phase deletes the supply.

1. **Delete registration** at `SessionRoutes.ts:389` (`app.get('/api/sessions/status', this.handleStatusByClaudeId.bind(this));`).
2. **Delete handler method** `handleStatusByClaudeId` + any private helpers it uses (if no other code references them).
3. Sanity-grep for any residual polling client.

### (b) Docs

- §3.1 deletion bullet 5.
- Part 2 **D6**.
- **V9** (endpoint 10 of 10).
- Live: `src/services/worker/http/routes/SessionRoutes.ts:389`.

### (c) Verification

```
grep -rn "/api/sessions/status" src/                       → 0 matches (hook side removed in Phase 3)
grep -n "handleStatusByClaudeId" src/                       → 0 matches
```

### (d) Anti-pattern guards

- **B** — no polling endpoint means no one can be tempted to re-add a 500 ms loop against it later.

---

## Phase 6 — Consolidate `session-init` / `session-complete` handlers into unified session endpoints

### (a) What to implement

Copy from §3.1 diagram edges:
- `UPS["POST /api/session/prompt<br/>{sessionDbId, prompt}"] --> UPSR["Returns {promptId}"]` (lines 96, 103).
- `PTU["POST /api/session/observation<br/>{sessionDbId, tool_use_id, name, input, output}"] --> PTUR["Returns {observationId}"]` (lines 97, 105).
- "Deleted" bullet 3: "`POST /sessions/{id}/init` SDK-start endpoint (implicit inside `/api/session/prompt`)".
- "Deleted" bullet 6: "Two-phase Stop handling (summarize then session-complete) — one endpoint, one response".

1. **Rewrite `src/cli/handlers/session-init.ts:72–150`** as a single `POST /api/session/prompt` call:
   - Replace `/api/sessions/init` (`:75`) + `/sessions/{sessionDbId}/init` (`:141`) + `/api/context/semantic` (`:23`) with one `workerHttpRequest('/api/session/prompt', {body: JSON.stringify({sessionId, project, prompt, platformSource})})`.
   - The worker-side `/api/session/prompt` handler (implemented by Plan 07 Phase 3) does: (a) resolve/create `sessionDbId`, (b) `ingestPrompt` (Plan 01 Phase 2), (c) start the SDK agent if not already running for this session, (d) fetch semantic markdown via `SearchOrchestrator`, (e) return `{promptId, sessionDbId, semanticMarkdown?}`.
   - `session-init.ts` passes `semanticMarkdown` into `additionalContext` (preserves the user-facing semantic injection feature — §3.5 + §3.1 `SS → SSR`).
2. **Rewrite `src/cli/handlers/observation.ts:17`** to call `POST /api/session/observation` with the new `{sessionDbId, tool_use_id, name, input, output}` payload. `tool_use_id` is passed through from the Claude Code hook input (already captured in `NormalizedHookInput` — verify before landing; if not, Plan 01 Phase 2 adds it because the UNIQUE constraint in Phase 9 depends on it).
3. **Rewrite `src/cli/handlers/file-edit.ts:15`** similarly — same endpoint, Cursor flow generates a synthetic `tool_use_id` (`file-edit:<path>:<mtime>`) if none exists.
4. **Delete `src/cli/handlers/session-complete.ts` entirely.** Its only role (mark session inactive) moves server-side into `/api/session/end`.
5. **Delete hook wiring** for the Stop-phase-2 `sessionCompleteHandler` in the adapter layer (`src/cli/adapters/claude-code.ts` — verify dispatcher mapping; this handler was the second callsite for the Stop event, feeding the old two-phase flow).
6. **Delete the remaining four `/api/sessions/*` legacy endpoints** at `SessionRoutes.ts:385–388` (`init`, `observations`, `summarize`, `complete`) — Phase 5 already deleted `status`. Their handlers `handleSessionInitByClaudeId`, `handleObservationsByClaudeId`, `handleSummarizeByClaudeId`, `handleCompleteByClaudeId` are deleted.

### (b) Docs

- §3.1 lines 96, 97, 103, 105 + deletion bullets 3, 6.
- §3.8 lines 325–332 (A `POST /api/session/prompt` → `SessionManager.initializeSession → Create → ActiveSession → spawn SDK`) — implicit SDK start.
- **V9** endpoints `:385–:388`.
- Live: `src/cli/handlers/session-init.ts:75,141,23`; `src/cli/handlers/observation.ts:17`; `src/cli/handlers/file-edit.ts:15`; `src/cli/handlers/session-complete.ts` (entire file).

### (c) Verification

```
grep -rn "/api/sessions/" src/                              → 0 matches (all five legacy paths deleted)
grep -rn "/sessions/.*sessionDbId" src/                      → 0 matches (legacy six deleted in Phase 4)
grep -rn "/api/session/" src/                                → exactly 4 distinct paths: start, prompt, observation, end
grep -rn "/api/context/semantic" src/                        → 0 matches (folded into /api/session/prompt)
grep -rn "sessionCompleteHandler" src/                       → 0 matches (file deleted)
test -f src/cli/handlers/session-complete.ts                 → false
```

End-to-end: full SessionStart → UserPromptSubmit → PostToolUse × 3 → Stop cycle against a fresh worker. Assert exactly these HTTP calls (verified via worker access log):
1. `GET /api/session/start?project=…` (SessionStart, from `context.ts`)
2. (Maybe) `GET /api/session/start?project=…&colors=true` (SessionStart parallel, from `user-message.ts`) — **if Phase 2 cache misses because the two handlers run in separate hook processes; otherwise 0 calls.**
3. `POST /api/session/prompt` (UserPromptSubmit)
4. `POST /api/session/observation` × 3 (PostToolUse)
5. `POST /api/session/end` (Stop)

Total: 5 or 6 HTTP calls per session (was 10–14: one `ensureWorkerRunning` ping per handler + two `/api/context/inject` + `/api/sessions/init` + `/sessions/1/init` + `/api/context/semantic` + 3× `/api/sessions/observations` + `/api/sessions/summarize` + ~220× poll `/api/sessions/status` + `/api/sessions/complete` × 2).

### (d) Anti-pattern guards

- **A** — no new event type; `POST /api/session/prompt` maps 1:1 to the existing UserPromptSubmit hook. No `hookEventName` changes.
- **D** — `/api/session/prompt` is the single source of truth for "start processing this user prompt". No facade calling an internal `/api/sessions/init`.
- **E** — `session-init.ts` and `observation.ts` both land on the same backend `ingestObservation`/`ingestPrompt` helpers via their respective endpoints; no duplicate tag-strip / privacy check paths.

---

## Phase 7 — Verification (grep counts, exit codes, Windows Terminal)

### (a) What to verify

1. **Grep counts** (final "clean" state):
   ```
   grep -rn "ensureWorkerRunning" src/cli/handlers/           → 0
   grep -rn "ensureWorkerAliveOnce" src/cli/handlers/         → 8
   grep -n "POLL_INTERVAL_MS" src/                             → 0
   grep -n "MAX_WAIT_FOR_SUMMARY_MS" src/cli/handlers/summarize.ts → 1 (HTTP client timeout)
   grep -rn "/api/sessions/" src/                              → 0
   grep -rn "/sessions/.*sessionDbId" src/                      → 0
   grep -rn "/api/context/inject" src/                          → 0
   grep -rn "/api/context/semantic" src/                        → 0
   grep -rn "/api/session/" src/                                → exactly 4 paths
   grep -c "app\.\(post\|get\|delete\)" src/services/worker/http/routes/SessionRoutes.ts → 4
   ```
2. **Exit-code census** (preserves CLAUDE.md contract):
   - Every hook-handler return path uses `HOOK_EXIT_CODES.SUCCESS` (= 0) on the graceful-degradation branch. Run:
     ```
     grep -B1 "HOOK_EXIT_CODES" src/cli/handlers/*.ts
     ```
     Expected: exit 0 on (worker-unreachable, empty context, empty transcript, 110 s timeout, subagent, project excluded). No new exit 2 paths.
   - Windows Terminal tab behaviour: exit 0 closes the tab on successful completion. The blocking `/api/session/end` 110 s path MUST also return exit 0 (not exit 2), so tabs close on timeout. Ship a Windows-Terminal integration test: trigger a synthetic 110 s timeout; confirm tab closes.
3. **Timer census**:
   ```
   grep -n "setInterval\|setTimeout.*recursive" src/cli/        → 0 in CLI handlers
   grep -n "setTimeout.*POLL" src/cli/                           → 0
   ```
4. **Endpoint count** on `SessionRoutes.ts`: exactly **4** route registrations. Matches §3.1.

### (b) Docs

- Whole §3.1 diagram, Part 4 timer census, Part 5 deletion ledger rows for "Summarize 500-ms polling hook" and "Double `/api/context/*` fetches".
- **V8**, **V9**, **V10**.
- CLAUDE.md exit-code strategy section ("Exit 0: Success or graceful shutdown — Windows Terminal closes tabs").

### (c) Verification (running the phase)

The phase produces no new code; it runs the grep + integration tests above and fails the rollout if any gate trips. Land only when:
- all greps pass,
- synthetic 110 s timeout → exit 0 → tab closes (Windows),
- full session cycle reports 5–6 HTTP calls (was 10–14).

### (d) Anti-pattern guards

- **B/D/E** — verified by absence (grep). **A** — verified by "`hookEventName` value set unchanged" (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`).

---

## Copy-Ready Snippet Locations

**Hook-side session-alive cache (Phase 2)**:
Location: new file `src/hooks/worker-cache.ts` (create; this is the one file added by this plan).
Shape: one module-scope `let alive: boolean | null = null;` + one `let sessionStartResponse: SessionStartResponse | null = null;`. Lives as long as the hook process does (≤120 s). No persistence, no cross-process sharing — that's the point. Plan 07 owns the *server-side* session state; Plan 09 owns only the per-hook-process cache.

**Poll loop deletion target (Phase 3)**:
`src/cli/handlers/summarize.ts:117–150` — the entire `while ((Date.now() - waitStart) < MAX_WAIT_FOR_SUMMARY_MS) { await sleep(POLL_INTERVAL_MS); … }` block plus `summarize.ts:24` (`POLL_INTERVAL_MS = 500`).

**Double-fetch deletion target (Phase 1)**:
`src/cli/handlers/context.ts:41–57` (the `Promise.all([workerHttpRequest(apiPath), workerHttpRequest(colorApiPath)])`) + `src/cli/handlers/user-message.ts:13–30` (`fetchAndDisplayContext`).

**`ensureWorkerRunning` 8 callsites (Phase 2 rewires all 8)**:
```
src/cli/handlers/context.ts:19
src/cli/handlers/user-message.ts:35
src/cli/handlers/session-init.ts:41
src/cli/handlers/observation.ts:34
src/cli/handlers/summarize.ts:44
src/cli/handlers/session-complete.ts:35  (file deleted in Phase 6 — callsite deleted with it)
src/cli/handlers/file-context.ts:218
src/cli/handlers/file-edit.ts:32
```

---

## Confidence + Gaps

### High confidence

- Hook → endpoint mapping (enumerated against live code).
- V8/V9/V10 verified against `Grep` output this session (2026-04-22).
- Endpoint count **10 → 4** verified at `SessionRoutes.ts:377–389` — supersedes the §3.1 "8 → 4" claim.
- `HOOK_EXIT_CODES.SUCCESS = 0` is the sole value used in every return branch of every handler today. Every phase preserves exit-0 semantics.

### Gaps (call out before executing)

1. **Stop-hook exit codes on 110 s timeout path — NEEDS CONFIRMATION.** Current `summarize.ts` returns exit 0 on all branches (poll timeout falls through to `/api/sessions/complete` → `return { exitCode: undefined }` implicitly → adapter defaults to 0). The new blocking `/api/session/end` must explicitly return exit 0 when the server responds `{timedOut: true, summaryId: null}`. §3.1 ("Exit 0") and CLAUDE.md ("Exit 0: graceful shutdown — Windows Terminal closes tabs") agree. **Phase 3 verification step must include a synthetic-timeout Windows Terminal test** — otherwise the refactor could silently introduce an exit-2 path that blocks tab closure, which CLAUDE.md explicitly warns against.

2. **`tool_use_id` availability in CLI hook payloads.** `POST /api/session/observation` requires `tool_use_id` (§3.1 `PTU` edge). Current `NormalizedHookInput` may or may not already carry it — `src/shared/NormalizedHookInput` needs a verification pass in Phase 6 (deferred to Plan 01 Phase 2 if absent). This gates the UNIQUE constraint in Plan 09 Phase 9 (SQLite); out of scope here but a coupling to flag.

3. **`user-message.ts` + `context.ts` run as separate hook processes on some Claude Code versions.** Module-scope `let` in `worker-cache.ts` won't share state across processes. If the Claude Code hook runner invokes them sequentially in one process: 1 HTTP call. If in parallel processes: 2 HTTP calls (still one each, still ≤2 total — acceptable, same as today's `/api/context/inject` double-fetch but under the new endpoint). **Not a correctness issue; a minor perf claim in Phase 1 verification needs empirical confirmation, not a blocker.**

### Out-of-scope adjacencies (flagged)

- Worker-side implementation of `GET /api/session/start`, `POST /api/session/prompt`, `POST /api/session/end` → Plans 05 + 07.
- `ingestObservation`/`ingestPrompt`/`ingestSummary` helpers → Plan 01.
- `file-context.ts` `GET /api/observations/by-file` endpoint → Plan 08 (DataRoutes), not touched here.
- `pre-compact.ts` (delegates to `summarizeHandler`) inherits the Phase 3 rewrite automatically; no extra work.

---

## Summary

- **7 phases**, executed in order (1 → 7). Phases 1, 2, 3 are independent of each other on the **hook side** (different files) but all depend on worker-side Plans 01, 05, 07 Phase-N endpoints existing; Phases 4, 5, 6 delete worker-side code after hooks stop calling it.
- **Lines deleted (hook side)**: `summarize.ts` loses ~80 lines (lines 86–167 collapse to ~10); `user-message.ts` loses ~17 lines; `context.ts` loses ~15 lines; `session-complete.ts` deleted entirely (65 lines); `session-init.ts` loses ~60 lines. **~237 lines gone** from `src/cli/handlers/`.
- **Lines deleted (worker side, SessionRoutes.ts)**: ~250 lines (6 legacy handlers + 5 ByClaudeId handlers).
- **Lines added**: `src/hooks/worker-cache.ts` ~25 lines; 8 handler rewires net ~0. **Total net**: ~-460 lines in this plan's scope (consistent with Part 5 ledger rows `-60/+20` summarize + `-120/+60` context = **-100 net**, plus the Phase 4+5+6 SessionRoutes delete not counted in §5 because §5 lumped it into "session-lifecycle-management").
- **Top gaps**: (1) 110 s timeout exit code must be 0 (Windows Terminal contract); (2) `tool_use_id` presence in `NormalizedHookInput` needs verification before Phase 6.
