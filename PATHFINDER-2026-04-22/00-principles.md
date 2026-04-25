# 00 — Principles

**Purpose**: This document is the anchor that every other plan in the `PATHFINDER-2026-04-22` corpus cites. It names the seven principles, the six anti-pattern guards, the unifying diagnosis that ties the refactor together, and the five concrete cures mapped to subsystems. Every subsequent plan (`01-data-integrity.md` through `99-verification.md`) measures its changes against this file.

---

## The Seven Principles

1. **No recovery code for fixable failures.** If the primary path is correct, recovery never runs. If it's broken, recovery hides the bug.
2. **Fail-fast over grace-degrade.** Local code does not circuit-break, coerce, or silently fall back. It throws and lets the caller decide.
3. **UNIQUE constraint over dedup window.** DB schema prevents duplicates; don't time-gate them.
4. **Event-driven over polling.** `fs.watch` over `setInterval` rescan. Server-side wait over client-side poll. `child.on('exit')` over periodic scan.
5. **OS-supervised process groups over hand-rolled reapers.** `detached: true` + `kill(-pgid)` replaces orphan sweeps.
6. **One helper, N callers.** Not N copies of a helper. Not a strategy class for each config.
7. **Delete code in the same PR it becomes unused.** No `@deprecated` fence, no "remove next release."

---

## The Six Anti-pattern Guards

- No new `setInterval` in `src/services/worker/` or the plan text (plan 99 greps for this)
- No new `coerce*`, `recover*`, `heal*`, `repair*`, `reap*`, `kill*Orphans*` function names
- No new try/catch that swallows errors and returns a fallback value
- No new schema column whose only purpose is to feed a recovery query
- No new strategy class when a config object would do
- No new HTTP endpoint for diagnostic / manual-repair purposes

---

## The Unifying Diagnosis

claude-mem's accumulated complexity is not five unrelated bugs; it is one pattern repeated across five subsystems. When the primary path is not proven correct, defensive code accretes around it — dedup windows, stale-row resets, orphan reapers, coercion helpers, fallback agents. That defensive code then hides the bugs in the primary path, because every failure is silently absorbed before it becomes visible. The hidden bugs spawn more defensive code, because each new symptom looks novel. The cure is not more defense: it is to make the primary path correct, let it fail loudly when it cannot, and delete the defense in the same PR. Same disease, five organs.

---

## Five Cures

| Subsystem | Symptom | Cure | Principle # |
|---|---|---|---|
| lifecycle | Orphan reapers, idle-evictors, fallback agents | OS process groups via `detached: true` + `kill(-pgid)`; lazy-spawn from hooks; no reapers | 5, 1 |
| data | 60-s stale-reset, 30-s dedup window, `repairMalformedSchema` | `UNIQUE` constraints + `ON CONFLICT DO NOTHING`; self-healing claim via `worker_pid NOT IN live_pids` | 3, 1 |
| search | Four formatter classes, `findByConcept`/`findByFile`/`findByType`, seven recency copies | One `renderObservations(obs, strategy)`; route all queries through `SearchOrchestrator`; one `RECENCY_WINDOW_MS` | 6 |
| ingestion | `coerceObservationToSummary`, circuit breaker, `setInterval` rescan, in-memory `pendingTools` Map | Fail-fast `parseAgentXml` discriminated union; recursive `fs.watch`; DB-backed pairing via `UNIQUE(session_id, tool_use_id)` | 2, 4, 3 |
| hooks | Client-side polling, silent error swallow, `@deprecated` dead classes | Blocking endpoint for summary wait; hooks throw on worker-unreachable; delete `TranscriptParser`, migration 19, `repairMalformedSchema` | 4, 2, 7 |

---

## Glossary

- **second-system effect** — The tendency to over-engineer a rewrite with features the first system proved unnecessary; in claude-mem, the canonical example is the worker-side `src/services/worker/ProcessRegistry.ts` duplicating the already-working `src/supervisor/process-registry.ts`.
- **lease pattern** — A claim held by a live owner and invalidated by liveness of that owner, not by wall-clock timeout; in claude-mem, the canonical example is the self-healing claim query using `worker_pid NOT IN live_worker_pids` instead of `started_processing_at_epoch < now - 60s`.
- **self-healing claim** — A single `UPDATE … WHERE status='pending' OR (status='processing' AND worker_pid NOT IN live_pids)` that is correct even after a crash, because liveness is checked at claim time rather than reset by a background timer; canonical example is the replacement for `STALE_PROCESSING_THRESHOLD_MS` at `src/services/sqlite/PendingMessageStore.ts:99-145`.
- **fail-fast contract** — A function signature that returns a discriminated union `{ valid: true, data } | { valid: false, reason }` (or throws) instead of coercing, defaulting, or returning `undefined`; canonical example is `parseAgentXml` replacing `parseObservations` + `parseSummary` + `coerceObservationToSummary` at `src/sdk/parser.ts:222-259`.
