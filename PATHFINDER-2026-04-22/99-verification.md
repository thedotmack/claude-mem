# 99 — Verification

## Purpose

This is the acceptance-criteria document for the entire PATHFINDER-2026-04-22 refactor. Every grep target, integration test, fuzz test, snapshot test, viewer-regression invariant, and prompt-caching cost smoke test for the refactor is consolidated here. Every plan's own Verification section cites this file as its canonical checklist — individual plans enumerate their local targets; `99-verification.md` is the union, grouped by pattern, with the acceptance gates the refactor ships against. No plan ships independently; the refactor lands when the checklist below is green.

## Timer census

The refactor replaces hand-rolled background supervision with OS-level primitives. The concrete count:

| Timer | File (before) | Status after refactor |
|---|---|---|
| `startOrphanReaper` (repeating `setInterval`) | `src/services/worker/worker-service.ts:537` | **DELETED** (`02-process-lifecycle.md` Phase 4) |
| `staleSessionReaperInterval` (repeating `setInterval`) | `src/services/worker/worker-service.ts:547` | **DELETED** (`02-process-lifecycle.md` Phase 4) |
| `clearFailedOlderThan` interval (repeating `setInterval`) | `src/services/worker/worker-service.ts:567` | **DELETED** (`01-data-integrity.md` Phase 5; `02-process-lifecycle.md` Phase 4) |

**Before**: 3 repeating background timers in `src/services/worker/`.
**After**: 0 repeating background timers in `src/services/worker/`.

**Acceptable exceptions** — the following are **not** counted as "repeating background timers" and are permitted:

- Per-operation one-shot `setTimeout` (e.g., the 5-second shutdown kill-escalation between SIGTERM and SIGKILL in `src/supervisor/shutdown.ts`). These are (a) non-repeating, (b) bound to the lifetime of a specific operation, (c) disposed in the same scope that created them, and (d) never monitored by health checks.
- The `transcripts/watcher.ts` `fs.watch` subscription (per `03-ingestion-path.md` Phase 5). `fs.watch` is event-driven, not a timer.

The acceptance grep `grep -rn "setInterval" src/services/worker/ → 0` enforces the census.

## Polling loops

The refactor replaces the client-side summary-storage poll with a server-side blocking endpoint.

| Polling loop | File (before) | Status after refactor |
|---|---|---|
| Summary-stored client poll | `src/cli/handlers/summarize.ts:117-150` | **DELETED**. Replaced by blocking `POST /api/session/end` that server-side-waits on `summaryStoredEvent` (`05-hook-surface.md` Phase 3; event emission in `03-ingestion-path.md` Phase 2). |

**Before**: 1 polling loop.
**After**: 0 polling loops.

The acceptance grep `grep -rn "MAX_WAIT_FOR_SUMMARY_MS\|POLL_INTERVAL_MS" src/cli/handlers/ → 0` enforces this.

## Full grep target list

Each line is runnable as-is. Expected count appears after `→`. Every target is sourced from the Verification section of the plan listed in the trailing comment.

### Process-lifecycle / timers

```
grep -rn "setInterval" src/services/worker/                                                             → 0   # 02-process-lifecycle Phase 4
grep -rn "startOrphanReaper" src/                                                                       → 0   # 02-process-lifecycle Phase 4
grep -rn "staleSessionReaperInterval" src/                                                              → 0   # 02-process-lifecycle Phase 4
grep -rn "recoverStuckProcessing\|killSystemOrphans\|reapStaleSessions\|reapOrphanedProcesses\|killIdleDaemonChildren" src/  → 0   # 01-data-integrity Phase 3 + 02-process-lifecycle Phase 4
grep -rn "killSystemOrphans" src/                                                                       → 0   # 02-process-lifecycle Phase 4
grep -rn "killIdleDaemonChildren" src/                                                                  → 0   # 02-process-lifecycle Phase 4
grep -rn "reapStaleSessions" src/                                                                       → 0   # 02-process-lifecycle Phase 4
grep -rn "reapOrphanedProcesses" src/                                                                   → 0   # 02-process-lifecycle Phase 4
grep -rn "evictIdlestSession" src/                                                                      → 0   # 02-process-lifecycle Phase 6
grep -rn "abandonedTimer\|evictIdlestSession" src/                                                      → 0   # 02-process-lifecycle Phase 5 + 6
grep -rn "abandonedTimer" src/                                                                          → 0   # 02-process-lifecycle Phase 5
grep -rn "fallbackAgent\|Gemini\|OpenRouter" src/services/worker/                                       → 0   # 02-process-lifecycle Phase 7
grep -rn "fallbackAgent\|Gemini\|OpenRouter" src/services/worker/SessionManager.ts                      → 0   # 02-process-lifecycle Phase 7
grep -rn "ProcessRegistry" src/services/worker/                                                         → 0   # 02-process-lifecycle Phase 1
```

### Data integrity

```
grep -n  "STALE_PROCESSING_THRESHOLD_MS" src/                                                           → 0   # 01-data-integrity Phase 3
grep -n  "started_processing_at_epoch" src/                                                             → 0   # 01-data-integrity Phase 3
grep -rn "DEDUP_WINDOW_MS\|findDuplicateObservation" src/                                               → 0   # 01-data-integrity Phase 4
grep -n  "DEDUP_WINDOW_MS" src/                                                                         → 0   # 01-data-integrity Phase 4
grep -n  "findDuplicateObservation" src/                                                                → 0   # 01-data-integrity Phase 4
grep -n  "repairMalformedSchema" src/                                                                   → 0   # 01-data-integrity Phase 6
grep -n  "clearFailedOlderThan" src/services/worker/worker-service.ts                                   → 0   # 01-data-integrity Phase 5
```

### Ingestion path

```
grep -rn "coerceObservationToSummary\|consecutiveSummaryFailures" src/                                  → 0   # 03-ingestion-path Phase 3 + 4
grep -n  "coerceObservationToSummary" src/                                                              → 0   # 03-ingestion-path Phase 4
grep -n  "consecutiveSummaryFailures" src/                                                              → 0   # 03-ingestion-path Phase 3
grep -n  "pendingTools" src/services/transcripts/                                                       → 0   # 03-ingestion-path Phase 6
grep -n  "setInterval" src/services/transcripts/watcher.ts                                              → 0   # 03-ingestion-path Phase 5
grep -n  "observationHandler.execute" src/services/transcripts/                                         → 0   # 03-ingestion-path Phase 7
grep -n  "TranscriptParser" src/utils/transcript-parser.ts                                              → 0   # 03-ingestion-path Phase 9 (file deleted)
grep -n  "repairMalformedSchema\|TranscriptParser" src/                                                 → 0   # 03-ingestion-path Phase 9 + 01-data-integrity Phase 6
```

### Read path

```
grep -n  "SearchManager\.findBy" src/                                                                   → 0   # 04-read-path Phase 3
grep -rn "RECENCY_WINDOW_MS" src/services/worker/SearchManager.ts                                       → 0   # 04-read-path Phase 4
grep -n  "fellBack: true" src/                                                                          → 0   # 04-read-path Phase 6
grep -n  "getExistingChromaIds" src/                                                                    → 0   # 04-read-path Phase 7 + 07-dead-code
grep -n  "fellBack: true\|getExistingChromaIds" src/                                                    → 0   # 04-read-path Phase 6 + 7
```

### Hook surface

```
grep -rn "for i in 1 2 3 4 5 6 7" plugin/hooks/hooks.json                                               → 0   # 05-hook-surface Phase 1
grep -rn "SettingsDefaultsManager.loadFromFile" src/cli/handlers/                                       → 1   # 05-hook-surface Phase 4 (only inside loadFromFileOnce)
grep -rn "isProjectExcluded" src/cli/handlers/                                                          → 1   # 05-hook-surface Phase 5 (only inside shouldTrackProject)
grep -rn "MAX_WAIT_FOR_SUMMARY_MS\|POLL_INTERVAL_MS" src/cli/handlers/                                  → 0   # 05-hook-surface Phase 3
```

### API surface

```
grep -rn "validateRequired\|rateLimit" src/services/worker/http/                                        → 0   # 06-api-surface Phase 4 + 5
grep -rn "/api/pending-queue" src/                                                                      → 0   # 06-api-surface Phase 7
grep -rn "markSessionMessagesFailed\|markAllSessionMessagesAbandoned" src/                              → 0 or 1   # 06-api-surface Phase 9 — "1" only if inside transitionMessagesTo
grep -rn "WorkerService.prototype.shutdown\|runShutdownCascade\|stopSupervisor" src/                    → 0 or 1   # 06-api-surface Phase 8 — "1" only at canonical call site
```

### Dead-code sweep

```
grep -rn "// @deprecated\|// TODO remove\|// old$\|// legacy$" src/                                     → 0   # 07-dead-code
grep -rn "TranscriptParser" src/                                                                        → 0   # 07-dead-code (regression-verifies 03-ingestion-path Phase 9)
grep -rn "getExistingChromaIds" src/                                                                    → 0   # 07-dead-code (regression-verifies 04-read-path Phase 7)
```

**Total: 30 grep targets** (expected count varies from 0 to "0 or 1" where a canonical call site is permitted, as noted inline).

## Prompt-caching cost smoke test

The knowledge-corpus phases in `04-read-path.md` (Phase 9) rely on Anthropic prompt caching to amortize the system-prompt cost across consecutive queries against the same corpus. If caching is not actually hitting, the phase's cost model breaks and the simplification does not ship.

### Harness

Issue three **sequential** HTTP calls to `POST /api/corpus/:name/query` against the same `:name`, with three different query bodies that each invoke the same cached system prompt. Collect the `api_usage` object (or equivalent, e.g., `usage`) returned in each response body.

### Assertions

- Each response includes an `api_usage` (or equivalent) field with `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
- **Call 1** is a cache-write. `cache_creation_input_tokens > 0`. `cache_read_input_tokens` may be `0`.
- **Call 2** and **Call 3**: `cache_read_input_tokens > 0`.
- **Threshold (steady-state)**: on calls 2 and 3, `cache_read_input_tokens / input_tokens ≥ 0.5`.

### Failure mode

If either call 2 or call 3 misses the threshold, the knowledge-corpus phases in `04-read-path.md` (specifically Phase 9: knowledge-corpus simplification + reliance on SDK prompt caching) **do not ship**. Re-investigate the caching path before re-running.

## Viewer regression harness

The viewer UI (`plugin/ui/viewer.html`, served from `src/services/worker/http/ViewerRoutes.ts`) must not regress across the refactor. Since the refactor touches the HTTP surface (`06-api-surface.md`), the read path (`04-read-path.md`), and ingestion semantics (`03-ingestion-path.md`) — all upstream of the viewer — a lockdown harness runs at every plan's start and end.

### Baseline-capture schedule

`tests/viewer-lockdown/` is **captured at phase start**: on the first commit of any plan that modifies files imported by `ViewerRoutes.ts`, `DataRoutes.ts`, or the formatter layer, run the harness to produce a baseline screenshot + DOM snapshot + JSON payload snapshot per test. At phase end, re-run and diff. No DOM diff (modulo timestamps/IDs) ⇒ pass.

If `tests/viewer-lockdown/` does not exist when the refactor begins, it **will be captured at phase start** of the first plan touching viewer-relevant code (that is `03-ingestion-path.md` under the current DAG).

### 12 Invariants

- **I1**: Observation list renders without JavaScript console errors.
- **I2**: The filter pane respects the date-window filter — the rendered row count equals the server-reported filtered count.
- **I3**: Session grouping in the observation list matches server-side `session_id` grouping (no visual merge across sessions).
- **I4**: Tag filters (e.g., `<private>`, concept, file) render the same set of rows the API returns for the same query parameters.
- **I5**: `/health` endpoint returns `200` and the viewer's health indicator reflects it.
- **I6**: Static asset caching — `viewer.html` served from memory after boot (no disk re-read on subsequent GETs; see `06-api-surface.md` Phase 6).
- **I7**: `/api/processing-status` stream renders live counts matching SQLite state (the only non-deleted diagnostic endpoint, per `06-api-surface.md` Phase 7).
- **I8**: Deleted diagnostic endpoints (`/api/pending-queue*`) return `404`, not `200` with a fallback body.
- **I9**: Malformed `POST` bodies surface a `400` response with Zod field errors visible to the viewer's error toast, not a silent `500`.
- **I10**: Chroma-down search renders a `503` error state in the viewer (not an empty result list, not a "fell back" banner).
- **I11**: Observation detail pane renders byte-identical text to the `renderObservations(obs, humanConfig)` snapshot (ties to the `04-read-path.md` byte-equality snapshot test).
- **I12**: Privacy tags (`<private>...</private>`) are stripped at hook layer before reaching the viewer — no `<private>` text appears in any rendered row.

### 11 Tests

- **T1** — load `/` → assert I1 (no console errors) + I5 (health 200).
- **T2** — apply a 7-day date-window filter → assert I2.
- **T3** — load a session with 3 distinct child sessions → assert I3.
- **T4** — query by concept tag → assert I4.
- **T5** — kill Chroma, issue a search → assert I10 (503 rendered, no fallback).
- **T6** — GET `/api/pending-queue` → assert I8 (404).
- **T7** — GET `/api/pending-queue/process` → assert I8 (404).
- **T8** — POST malformed body to `/api/observations` → assert I9 (400 + Zod field errors).
- **T9** — boot worker, GET `viewer.html` twice; block disk read between GETs → assert I6 (second GET succeeds from memory).
- **T10** — render a fixture observation set with a known human-config snapshot → assert I11 (byte-identity).
- **T11** — ingest a transcript line containing `<private>secret</private>` → assert I12 (the substring "secret" is absent from any viewer response body).

`/api/processing-status` is exercised by T1 (load includes the status stream), covering I7 without an additional test.

## Integration tests

Consolidated across all plans. Each test cites the plan that introduces the behavior under test.

- **IT1** — Kill worker mid-claim → next worker picks up the row. Source: `01-data-integrity.md` Phase 3 (self-healing claim query).
- **IT2** — `kill -9 <worker-pid>` → next hook respawns worker; no orphan children remain. Source: `02-process-lifecycle.md` Phase 8 (lazy-spawn wrapper).
- **IT3** — Graceful `SIGTERM` to worker → all SDK children exit within 6s via process-group teardown. Source: `02-process-lifecycle.md` Phase 3 (process-group shutdown cascade).
- **IT4** — Drop JSONL with `tool_use` line and no matching `tool_result` → row stays pending, pairing JOIN returns zero pairs, no observation emitted, no crash. Source: `03-ingestion-path.md` Phase 6 (fuzz test 1).
- **IT5** — Drop JSONL with `tool_result` referencing an unknown `tool_use_id` → row inserted, debug log emitted, no phantom observation, no crash. Source: `03-ingestion-path.md` Phase 6 (fuzz test 2).
- **IT6** — Chroma down → search returns `503` with non-empty error body (not empty result, not `fellBack: true`). Source: `04-read-path.md` Phase 5 + 6.
- **IT7** — `renderObservations` byte-identity snapshot test against `AgentFormatter`/`HumanFormatter`/`ResultFormatter`/`CorpusRenderer` fixtures. Source: `04-read-path.md` Phase 1 + 2.
- **IT8** — Block worker port; hook exits `0` first time, exits `0` second time with `consecutiveFailures: 2` on disk, exits `2` on the third call; unblock and invoke once more → counter reset to `0`. Source: `05-hook-surface.md` Phase 8.
- **IT9** — Session end hook issues a single `POST /api/session/end` that blocks until `summaryStoredEvent` fires; request count == 1, no polling. Source: `05-hook-surface.md` Phase 3.
- **IT10** — Malformed `POST /api/observations` body → `400` with `{ error: 'ValidationError', issues: [...] }` (not 500, not silent pass). Source: `06-api-surface.md` Phase 2 + 3.
- **IT11** — First request for `viewer.html` after boot loads from disk; second request while disk-read is blocked still succeeds from memory. Source: `06-api-surface.md` Phase 6.

## Acceptance criteria

The refactor ships when **all** of the following pass:

1. Every grep target in §"Full grep target list" returns its expected count (0, 1, or "0 or 1" per the inline spec). No exceptions.
2. Every integration test in §"Integration tests" (IT1 through IT11) passes.
3. The prompt-caching cost smoke test in §"Prompt-caching cost smoke test" passes: `cache_read_input_tokens > 0` on calls 2 and 3, and `cache_read_input_tokens / input_tokens ≥ 0.5` on calls 2 and 3.
4. The viewer regression harness in §"Viewer regression harness" passes: all 12 invariants hold, all 11 tests green, DOM diff modulo timestamps/IDs is empty against the captured baseline.
5. `npm run build` succeeds.
6. The full unit test suite (`tests/`) passes.
7. **Net lines deleted ≥ ~3,800** across the new corpus compared to the pre-refactor baseline (target from `_rewrite-plan.md` line 21).

If any one criterion fails, the refactor does not ship. Plans whose verification greps or integration tests regress are sent back for revision per the DAG in `98-execution-order.md`.
