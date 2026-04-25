# 05 — Hook Surface

## Purpose

Consolidate worker HTTP plumbing across the eight hook handlers, cache settings once per hook process, delete the 20-iteration `curl` retry loops in `plugin/hooks/hooks.json`, delete the 120-second client-side polling loop in `src/cli/handlers/summarize.ts`, and escalate to exit code 2 after N consecutive `ensureWorkerRunning()` failures so the worker's death surfaces to Claude instead of being silently absorbed. The cure is nine moves: delete the shell retry loops; introduce one `executeWithWorkerFallback` helper with eight callers; replace the polling loop with a server-side blocking `/api/session/end` endpoint that awaits the `summaryStoredEvent` emitted by `03-ingestion-path.md` Phase 2; cache settings at module scope; collapse three duplicated exclusion checks into one `shouldTrackProject(cwd)` helper; move cwd validation to the adapter boundary so it runs once; delete the always-init conditional on the agent (init is idempotent); track consecutive failures in a state file and exit 2 after N; and consolidate the alive-heuristic cache into one `ensureWorkerAliveOnce()` call site.

---

## Principles invoked

This plan is measured against `00-principles.md`:

- **Principle 2 — Fail-fast over grace-degrade.** Consecutive hook failures do not degrade silently into "exit 0 and hope next time works." After N consecutive `ensureWorkerRunning == false` results, the hook exits code 2 so Claude Code's hook contract surfaces the problem. No retry inside the hook. No timeout-and-exit-0 papering.
- **Principle 4 — Event-driven over polling.** The 120-second client-side polling loop in `src/cli/handlers/summarize.ts:117-150` is replaced by a single POST to `/api/session/end` that the server holds open until the `summaryStoredEvent` (emitted by `03-ingestion-path.md` Phase 2) fires. One request, one response, no polling on either side.
- **Principle 6 — One helper, N callers.** The eight-handler copy of `ensureWorkerRunning → workerHttpRequest → if (!ok) return { continue: true }` collapses to one exported `executeWithWorkerFallback(url, method, body)`. Three duplicated `isProjectExcluded(cwd, …)` call sites collapse to one `shouldTrackProject(cwd)`. Four per-handler `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` calls collapse to one module-scope `loadFromFileOnce()`.

**Cross-references**:

- `03-ingestion-path.md` Phase 2 emits `summaryStoredEvent` with payload `{ sessionId: string; messageId: number }`. Phase 3 of this plan consumes that event inside the Express handler for `/api/session/end`. The emitter lives inside the worker (`src/services/worker/agents/ResponseProcessor.ts` after its rewrite); the consumer lives inside the HTTP route. Event-bus implementation is left to the implementer per `03-ingestion-path.md` §Known gaps #3.
- `02-process-lifecycle.md` Phase 8 defines the lazy-spawn wrapper (`ensureWorkerRunning` in `src/shared/worker-utils.ts:221-239`) that this plan's `executeWithWorkerFallback` calls as its first step. If the worker is not alive, lazy-spawn attempts to start it; if the port check still fails afterwards, the helper returns `{ continue: true }` and this plan's Phase 8 fail-loud counter increments. The two plans do not duplicate spawn logic — lazy-spawn is defined in 02, consumed here.
- `06-api-surface.md` defines the Zod `validateBody` middleware (Phase 2 of that plan). The blocking `/api/session/end` endpoint introduced in Phase 3 below uses the same middleware to validate its POST body before entering the event-wait loop; no hand-rolled validation lives in the hook-surface plumbing.

---

## Phase 1 — Delete shell retry loops

**Purpose**: Remove the 20-iteration `curl` retry loops wrapping three hook entries in `plugin/hooks/hooks.json`. Shell-level retry is a bash expression of the same anti-pattern principle 2 forbids at the TypeScript layer. `ensureWorkerRunning()` (`02-process-lifecycle.md` Phase 8) is the one check; it either succeeds or the fail-loud counter (Phase 8 below) escalates. A shell loop papers over that signal.

**Anchors** (`_reference.md` Part 1 §Hooks/CLI):
- `plugin/hooks/hooks.json:27` — `for i in 1 2 3 4 5 6 7 …` curl retry wrapper
- `plugin/hooks/hooks.json:32` — same pattern, second hook entry
- `plugin/hooks/hooks.json:43` — same pattern, third hook entry

**Before** (conceptual):
```jsonc
// plugin/hooks/hooks.json:27 (current)
"command": "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do curl -sf http://localhost:37777/health && break; sleep 0.1; done && bun .../observation-hook.js"
```

**After**:
```jsonc
// plugin/hooks/hooks.json:27 (after this phase)
"command": "bun .../observation-hook.js"
```

The handler invokes `executeWithWorkerFallback` (Phase 2) on entry; that helper calls `ensureWorkerRunning()` (`02-process-lifecycle.md` Phase 8) which performs a single port check plus one lazy-spawn attempt. No shell loop.

**Reference**: `_reference.md` Part 1 §Hooks/CLI `plugin/hooks/hooks.json:27, 32, 43` (target call sites).

---

## Phase 2 — `executeWithWorkerFallback(url, method, body)` helper

**Purpose**: Consolidate the eight hook handlers' copy of `ensureWorkerRunning → workerHttpRequest → if (!ok) return { continue: true }` into one exported helper. The helper is added to `src/shared/worker-utils.ts` alongside `ensureWorkerRunning`; every handler imports and calls it instead of reproducing the sequence.

**Anchors**:
- `src/shared/worker-utils.ts:221-239` — `ensureWorkerRunning` (existing, consumed by the new helper)
- `src/cli/handlers/observation.ts:17` — one of eight call sites that reproduces the sequence
- `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/observation.ts:17, 53-54, 58-61` (current duplicated pattern)

**Contract** (required signature, see "`executeWithWorkerFallback` signature" section below for the canonical block).

**Behavior**:
1. Call `ensureWorkerRunning()`. If it returns `false`, increment the fail-loud counter (Phase 8) and return `{ continue: true, reason: 'worker_unreachable' }`.
2. If `true`, call `workerHttpRequest(url, method, body)` and return its parsed response typed as `T`.
3. Reset the fail-loud counter on the first success.

**Callers after this plan lands** (all eight):
- `src/cli/handlers/observation.ts`
- `src/cli/handlers/session-init.ts`
- `src/cli/handlers/context.ts`
- `src/cli/handlers/file-context.ts`
- `src/cli/handlers/file-edit.ts`
- `src/cli/handlers/summarize.ts`
- (two additional handlers in `src/cli/handlers/` that reproduce the pattern — see `_reference.md` Part 1 §Hooks/CLI for anchors)

**By principle 6 (one helper, N callers)**: the request/fallback sequence has one implementation; eight handlers import it. No handler reimplements the "worker missing → exit gracefully" path.

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/shared/worker-utils.ts:221-239` and `src/cli/handlers/observation.ts:17`. Cross-reference: `02-process-lifecycle.md` Phase 8 for the `ensureWorkerRunning` contract this helper depends on.

---

## Phase 3 — Blocking `/api/session/end` endpoint

**Purpose**: Replace the client-side 120-second polling loop in `src/cli/handlers/summarize.ts:117-150` with a single POST to `/api/session/end` that the server holds open until the summary-stored event fires. By principle 4 (event-driven over polling), the server already knows when the summary is persisted — it just emitted `summaryStoredEvent` in `03-ingestion-path.md` Phase 2 — so there is no reason for the hook to walk back in and ask repeatedly.

**Anchors**:
- `src/cli/handlers/summarize.ts:117-150` — 120-second polling loop (1 s tick, `MAX_WAIT_FOR_SUMMARY_MS`, `POLL_INTERVAL_MS`) — DELETE
- `03-ingestion-path.md` Phase 2 — emits `summaryStoredEvent` with payload `{ sessionId: string; messageId: number }`
- `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/summarize.ts:117-150` (current polling target)

**Server-side pattern** (Express-level; event bus + per-request timeout + single response):

```ts
// Express route registered in src/services/worker/http/routes/SessionRoutes.ts
// after 06-api-surface.md Phase 2 validateBody middleware runs.
router.post('/api/session/end', validateBody(sessionEndSchema), (req, res) => {
  const { sessionId } = req.body;

  // one-shot listener; cleared on either fulfillment or timeout
  const onStored = (evt: SummaryStoredEvent) => {
    if (evt.sessionId !== sessionId) return;
    cleanup();
    res.status(200).json({ ok: true, messageId: evt.messageId });
  };

  const timer = setTimeout(() => {
    cleanup();
    res.status(504).json({ ok: false, reason: 'summary_not_stored_in_time' });
  }, SERVER_SIDE_SUMMARY_TIMEOUT_MS);

  const cleanup = () => {
    clearTimeout(timer);
    eventBus.off('summaryStoredEvent', onStored);
  };

  eventBus.on('summaryStoredEvent', onStored);

  // request aborted by client (hook process died): drop the listener immediately
  req.on('close', cleanup);
});
```

Per-hook call site:

```ts
// src/cli/handlers/summarize.ts (after this phase)
const result = await executeWithWorkerFallback<SessionEndResponse>(
  '/api/session/end', 'POST', { sessionId },
);
// one POST, one response. No loop.
```

**Delete in the same PR**:
- `src/cli/handlers/summarize.ts:117-150` — polling loop body
- `MAX_WAIT_FOR_SUMMARY_MS` constant
- `POLL_INTERVAL_MS` constant
- Any helper that existed only to drive the loop (`pollUntilSummary`, `waitForSummarySync`, …)

**Cross-reference (load-bearing)**: `03-ingestion-path.md` Phase 2 is the emitter side of the contract. Its `summaryStoredEvent` payload `{ sessionId: string; messageId: number }` is consumed verbatim here. If Phase 2 changes the event name or shape, this phase's route handler changes with it. The event bus implementation (`EventEmitter` vs dedicated `src/services/infrastructure/eventBus.ts`) is per `03-ingestion-path.md` §Known gaps #3.

**Cross-reference (validation)**: `06-api-surface.md` Phase 2 defines `validateBody`. The `sessionEndSchema` Zod schema is declared at the top of `SessionRoutes.ts` per `06-api-surface.md` Phase 3.

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/summarize.ts:117-150`; `_reference.md` Part 2 row 7 (hook exit-code contract — a 504 returned to the hook flows through `executeWithWorkerFallback` and triggers the fail-loud counter like any other failure).

---

## Phase 4 — Cache settings once per hook process

**Purpose**: Each hook process is short-lived and reads `USER_SETTINGS_PATH` independently. Four handlers currently call `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` on every handler entry; since settings do not mutate during a single hook execution, module-scope caching eliminates three redundant disk reads per invocation across the eight handlers.

**Anchors**:
- `src/cli/handlers/context.ts:36` — per-handler `loadFromFile` call
- `src/cli/handlers/session-init.ts:57` — same
- `src/cli/handlers/observation.ts:58` — same
- `src/cli/handlers/file-context.ts:211` — same
- `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/session-init.ts:57-60` and `src/cli/handlers/observation.ts:17, 53-54, 58-61`
- `_reference.md` Part 3 row "Settings schema" — `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` pattern

**After**: a module-scope `loadFromFileOnce()` in (e.g.) `src/shared/hook-settings.ts` that memoizes the `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` result for the lifetime of the process. Every handler imports `loadFromFileOnce` instead of calling `loadFromFile` directly.

```ts
// src/shared/hook-settings.ts (after this phase)
let cachedSettings: Settings | null = null;
export function loadFromFileOnce(): Settings {
  if (cachedSettings !== null) return cachedSettings;
  cachedSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return cachedSettings;
}
```

**Delete in the same PR**: the per-handler `loadFromFile` calls at `context.ts:36`, `session-init.ts:57`, `observation.ts:58`, `file-context.ts:211`. After this phase, the only `SettingsDefaultsManager.loadFromFile` call in `src/cli/handlers/` is inside `loadFromFileOnce` (verification grep below).

**Reference**: `_reference.md` Part 1 §Hooks/CLI (call sites); Part 3 row "Settings schema" (current pattern).

---

## Phase 5 — `shouldTrackProject(cwd)` helper

**Purpose**: Three handlers duplicate the pattern `isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)` — each one reloads settings (fixed by Phase 4) and calls the same exclusion check. Consolidate to one `shouldTrackProject(cwd)` helper that is the single answer to "does this hook run for this cwd?"

**Anchors**:
- `src/cli/handlers/observation.ts:58-61` — exclusion check call site
- `src/cli/handlers/context.ts` — exclusion check call site
- `src/cli/handlers/file-context.ts:211` region — exclusion check call site
- `src/utils/project-name.ts` — `getProjectContext(cwd)` returning `{ primary, allProjects, excluded }` per `_reference.md` Part 3 row "Project scoping"

**After**:
```ts
// src/shared/should-track-project.ts (after this phase)
export function shouldTrackProject(cwd: string): boolean {
  const settings = loadFromFileOnce();                             // Phase 4
  return !isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS);
}
```

**Callers**: every handler that currently reads `CLAUDE_MEM_EXCLUDED_PROJECTS` imports and calls `shouldTrackProject(cwd)` at the top of its handler body. No handler references the setting key directly after this phase.

**By principle 6 (one helper, N callers)**: three exclusion-check sites → one helper. The verification grep below asserts that `isProjectExcluded` is referenced exactly once in `src/cli/handlers/` (inside `shouldTrackProject`); every other caller routes through the helper.

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/observation.ts:58-61`; Part 3 row "Project scoping".

---

## Phase 6 — cwd validation at adapter boundary

**Purpose**: cwd validation currently runs twice on some paths — once after the adapter normalizes input and once inside the handler. Move validation into the adapter's `normalizeInput()` function so it runs exactly once, at the boundary.

**Anchors**:
- `src/cli/handlers/file-edit.ts:50-51` — cwd validation after adapter normalization (DELETE; move to adapter)
- `src/cli/handlers/observation.ts:53-54` — same pattern (DELETE; move to adapter)
- `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/observation.ts:17, 53-54, 58-61`

**Before**:
```ts
// src/cli/handlers/observation.ts:53-54 (current)
const payload = adapter.normalizeInput(raw);
if (!isValidCwd(payload.cwd)) return { continue: true };     // handler-level check
```

**After**:
```ts
// adapter body (conceptual)
normalizeInput(raw) {
  const payload = this.parse(raw);
  if (!isValidCwd(payload.cwd)) throw new AdapterRejectedInput('invalid_cwd');
  return payload;
}

// handler body — no cwd check remains
const payload = adapter.normalizeInput(raw);
```

**Delete in the same PR**: the two handler-level `isValidCwd` checks at `file-edit.ts:50-51` and `observation.ts:53-54`.

**Reference**: `_reference.md` Part 1 §Hooks/CLI anchors above.

---

## Phase 7 — Always-init agent

**Purpose**: `src/cli/handlers/session-init.ts:120-129` wraps agent initialization in `if (!initResult.contextInjected)`. The conditional exists to avoid re-initializing the agent when context was already injected; but agent init is idempotent (second call is a no-op), so the conditional adds branching without reducing work. Delete it.

**Anchors**:
- `src/cli/handlers/session-init.ts:120-129` — conditional guard around agent init
- `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/session-init.ts:57-60, 120-129`

**Before**:
```ts
// src/cli/handlers/session-init.ts:120-129 (current)
if (!initResult.contextInjected) {
  await initAgent(…);
}
```

**After**:
```ts
// src/cli/handlers/session-init.ts (after this phase)
await initAgent(…);                       // idempotent; safe to always call
```

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/cli/handlers/session-init.ts:120-129`.

---

## Phase 8 — Fail-loud after N consecutive failures

**Purpose**: Escalate silent failure to a surfaced failure. When `ensureWorkerRunning()` returns `false`, the hook still exits `0` (first time) to avoid breaking the user's Claude Code session; but the helper increments a counter in a state file, and after N (default 3) consecutive failures, the hook exits code 2. Per `_reference.md` Part 2 row 7, exit code 2 is a **blocking error** that Claude Code feeds back to Claude — it is the correct surface for "the worker has been unreachable 3 times in a row; something is actually broken."

**This counter is NOT a retry.** A retry would reinvoke the failed operation inside the hook to try again; this plan forbids that (see Anti-pattern guards below). The counter records how many consecutive hook invocations have seen the worker unreachable and escalates only the Nth invocation to exit 2 — the first (N−1) invocations still return the graceful-degradation response. Retry loops live work forward within one invocation; the fail-loud counter surfaces a persistent outage across invocations. They are disjoint mechanisms.

**Anchors**:
- `src/shared/worker-utils.ts:221-239` — `ensureWorkerRunning` (the call whose `false` return increments the counter)
- `_reference.md` Part 2 row 7 — Claude Code hook exit codes (0 success, 1 non-blocking, 2 blocking)
- `CLAUDE.md` §Exit Code Strategy — claude-mem's philosophy that worker-unreachable alone exits 0 to prevent Windows Terminal tab accumulation, overridden here by the N-th consecutive failure escalating to 2

**Counter location**: the existing claude-mem state directory (the same directory that already holds other per-process state under `~/.claude-mem/`). Place the counter at `~/.claude-mem/state/hook-failures.json`. **Do NOT create a new top-level directory**; use the state directory that already exists. If the state directory does not yet exist (implementer discovers at landing time), the existing state-directory creation path creates it; this plan does not introduce a new creation path.

**File shape**:
```json
{ "consecutiveFailures": 2, "lastFailureAt": 1713830400000 }
```

**Atomic write**: write to `~/.claude-mem/state/hook-failures.json.tmp`, then `rename` over the destination. POSIX rename is atomic within a filesystem; no partial-write window. No `fs.watch` or lock is needed because each hook invocation reads-then-writes as a short sequence, and a race across two simultaneous hooks at most over- or under-counts by one — which is acceptable given the threshold is 3.

**Behavior (in `executeWithWorkerFallback`)**:
1. `ensureWorkerRunning()` returns `true` → reset counter to 0 (atomic write), proceed with request.
2. `ensureWorkerRunning()` returns `false` → read counter, increment by 1, atomic write:
   - If new value < N → exit the hook with code 0 and return `{ continue: true, reason: 'worker_unreachable' }` to the caller.
   - If new value ≥ N → exit the hook with code **2** so Claude Code surfaces the outage. stderr: "claude-mem worker unreachable for <N> consecutive hooks."

**N (threshold)**: default 3. Settings key `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD` (integer, optional; defaults to 3 if absent).

**Distinguishing from a retry**: the helper does NOT call `ensureWorkerRunning()` twice, does NOT sleep-and-retry the HTTP request, does NOT attempt the operation a second time inside the same hook. It runs the primary path once, records the result in the counter, and either returns or escalates. A retry reinvokes work; the counter records work. If an implementer is tempted to add a "just try once more before incrementing" line, refer to the Anti-pattern guards section and stop.

**Reset**: any successful `ensureWorkerRunning()` resets the counter to 0 in the same atomic write. This is not a retry either — it is a success-path acknowledgment that the outage ended.

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/shared/worker-utils.ts:221-239`; `_reference.md` Part 2 row 7 (exit-code contract); `CLAUDE.md` §Exit Code Strategy.

---

## Phase 9 — Delete cache alive heuristic duplication

**Purpose**: Multiple handlers re-derive "is the worker alive?" heuristics (port check, recent-success flag, …) each invocation. Collapse into one `ensureWorkerAliveOnce()` with module-scope caching, consumed by `executeWithWorkerFallback` from Phase 2.

**Anchors**:
- `src/shared/worker-utils.ts:221-239` — `ensureWorkerRunning` (the underlying port check; `ensureWorkerAliveOnce` wraps it with one per-process memoization)
- handlers that duplicate alive-heuristic checks — covered by the grep "SettingsDefaultsManager.loadFromFile" (Phase 4) and "isProjectExcluded" (Phase 5) verifications plus this phase's consolidation

**After**:
```ts
// src/shared/worker-utils.ts (after this phase)
let aliveCache: boolean | null = null;
export async function ensureWorkerAliveOnce(): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  aliveCache = await ensureWorkerRunning();
  return aliveCache;
}
```

`executeWithWorkerFallback` (Phase 2) calls `ensureWorkerAliveOnce()` instead of `ensureWorkerRunning()`. Within a single hook process, the first call hits the network; subsequent calls return the memoized value. This matters because a single hook invocation may issue multiple requests (e.g., session-init issues several), and the alive-state cannot change mid-invocation without the process exiting.

**By principle 6 (one helper, N callers)**: the memoization lives in one place; eight handlers call the memoized wrapper transparently.

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/shared/worker-utils.ts:221-239`.

---

## `executeWithWorkerFallback` signature (verbatim contract)

Phase 2 establishes the single helper consumed by all eight handlers. The discriminated return type makes the degrade-gracefully branch an explicit caller concern rather than an ad-hoc `{ continue: true }` literal scattered across handlers.

```ts
type WorkerFallback = { continue: true } | { continue: true, reason: string };
async function executeWithWorkerFallback<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T | WorkerFallback>;
```

---

## Fail-loud counter location callout

The fail-loud counter (Phase 8) lives at `~/.claude-mem/state/hook-failures.json` — inside the **existing** state directory under `~/.claude-mem/`. This plan does not create a new directory; it writes to the directory that already holds claude-mem's per-process state. Atomic write via the temp-file + rename pattern (`write hook-failures.json.tmp → rename hook-failures.json.tmp hook-failures.json`). POSIX rename within one filesystem is atomic; no partial-file window.

Reminder: this counter is **not** a retry. See Phase 8's "Distinguishing from a retry" subsection and the Anti-pattern guards below.

---

## Verification grep targets

Each command must return the indicated count after this plan lands.

```
grep -rn "for i in 1 2 3 4 5 6 7" plugin/hooks/hooks.json                  → 0
grep -rn "SettingsDefaultsManager.loadFromFile" src/cli/handlers/           → 1   # cached location only (loadFromFileOnce)
grep -rn "isProjectExcluded" src/cli/handlers/                              → 1   # inside shouldTrackProject only
grep -rn "MAX_WAIT_FOR_SUMMARY_MS\|POLL_INTERVAL_MS" src/cli/handlers/      → 0
```

**Integration test 1** (fail-loud counter): block the worker port (e.g., kill the worker with a firewall rule or a `iptables`/`pfctl` reject on 37777). Invoke any hook; assert it exits **0** and writes `{ "consecutiveFailures": 1 }` to `~/.claude-mem/state/hook-failures.json`. Invoke again; assert exit 0 and counter at 2. Invoke a third time; assert exit **2** with stderr naming the outage. Unblock the port and invoke once more; assert exit 0 and counter reset to 0.

**Integration test 2** (session end blocks without polling): start a session end hook while a session is in flight. Assert a single POST to `/api/session/end` is issued from the hook (tcpdump/strace count or application-level log asserts request count == 1). The request hangs until the worker stores the summary (triggering `summaryStoredEvent`), then returns 200 in one response. No tick-loop, no repeated requests.

**Six verification targets total**: four greps + two integration tests.

---

## Anti-pattern guards

Reproduced verbatim from `_rewrite-plan.md` §4A:

- Do NOT add a retry loop inside the hook (any kind).
- Do NOT add a timeout-and-exit-0 pattern.
- Do NOT keep the shell retry loops behind a feature flag.

Additional hard rules enforced by this plan:

- Do NOT add polling anywhere in the hook. The session-end summary wait is server-side, single POST, single response.
- Do NOT add a shell-level retry loop in `plugin/hooks/hooks.json`. Phase 1 deletes the existing ones; none may be reintroduced.
- Do NOT treat the fail-loud counter as a retry. It does not reinvoke work; it records work. If tempted to add "one more attempt before incrementing," see Phase 8's distinguishing subsection and stop.
- Do NOT migrate the fail-loud counter to a new directory. It lives at `~/.claude-mem/state/hook-failures.json` inside the existing state directory.
- Do NOT introduce a second `ensureWorkerRunning`-like helper; consumers go through `executeWithWorkerFallback` (Phase 2) or `ensureWorkerAliveOnce` (Phase 9). Both wrap the single primitive from `02-process-lifecycle.md` Phase 8.

---

## Known gaps / deferrals

1. **Event-bus choice.** Phase 3's `/api/session/end` endpoint listens for `summaryStoredEvent` from `03-ingestion-path.md` Phase 2. The event-bus implementation (`node:events` `EventEmitter` vs a dedicated `src/services/infrastructure/eventBus.ts` module) is left to the implementer per `03-ingestion-path.md` §Known gaps #3. This plan specifies only the consumer contract.
2. **Server-side timeout default.** `SERVER_SIDE_SUMMARY_TIMEOUT_MS` for the blocking endpoint is not fixed by this plan; the implementer picks a value bounded by the SDK's worst-case summary latency. A 30-s default is a reasonable starting point; revisit once Phase 2 (ingestion) is in place and we have measured latency distribution.
3. **Windows counter path.** `~/.claude-mem/state/hook-failures.json` resolves via the existing `~/.claude-mem/` base path logic. On Windows under WSL the path is Unix-shaped; native-Windows behavior inherits the platform caveat from `02-process-lifecycle.md` §Platform caveat — Windows.
