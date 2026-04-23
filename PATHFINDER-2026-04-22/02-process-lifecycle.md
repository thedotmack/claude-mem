# 02 — Process Lifecycle

## Purpose

Delete the worker-side parallel registry at `src/services/worker/ProcessRegistry.ts`, consolidate to the canonical `src/supervisor/process-registry.ts`, lazy-spawn the worker from hooks, spawn Claude SDK children into their own process groups with `detached: true`, and tear those groups down via `process.kill(-pgid, signal)`. No reapers. No idle-shutdown. No fallback agent chain. The worker runs until killed; orphans are PREVENTED by process groups, not swept. This plan replaces a hand-rolled supervisor (orphan scanners, idle-evictors, stale-session reapers, `ppid==1` sweeps) with OS mechanisms that already do the job correctly.

---

## Principles invoked

- **Principle 1 — No recovery code for fixable failures.** Orphan sweeps, idle-evictors, and stale-session reapers are recovery code papering over a spawn bug. Fix the spawn (process groups), delete the recovery.
- **Principle 2 — Fail-fast over grace-degrade.** SessionManager's Gemini → OpenRouter fallback chain hides SDK failures. Delete it; surface failures to the hook via exit code 2.
- **Principle 4 — Event-driven over polling.** `child.on('exit')` is authoritative. Delete the 30-second orphan-reaper interval, the stale-session reaper interval, the `clearFailedOlderThan` interval, and the per-session `abandonedTimer` `setTimeout`.
- **Principle 5 — OS-supervised process groups over hand-rolled reapers.** `spawn(cmd, args, { detached: true })` + `process.kill(-pgid, signal)` replaces `killSystemOrphans`, `killIdleDaemonChildren`, `reapOrphanedProcesses`, `reapStaleSessions`.

---

## Phase list

### Phase 1 — Delete `src/services/worker/ProcessRegistry.ts`

**Purpose**: Eliminate the worker-side parallel registry. The canonical registry at `src/supervisor/process-registry.ts` is the only one that survives.

**Anchors** (`_reference.md` Part 1 §Worker/lifecycle):
- `src/services/worker/ProcessRegistry.ts:244-309` — `killIdleDaemonChildren`
- `src/services/worker/ProcessRegistry.ts:315-344` — `killSystemOrphans`
- `src/services/worker/ProcessRegistry.ts:349-382` — `reapOrphanedProcesses`
- `src/services/worker/ProcessRegistry.ts:452-465` — SDK spawn site (MOVE to supervisor, then delete the file)
- `src/supervisor/process-registry.ts:85-173` — `captureProcessStartToken` (KEEP — primary-path PID-reuse detection)

**Before** (conceptual):
```ts
// src/services/worker/ProcessRegistry.ts (the shadow registry — DELETE)
export class ProcessRegistry {
  killIdleDaemonChildren(daemonPid: number) { /* ps -eo, ppid filter, kill */ }
  killSystemOrphans() { /* ppid==1 sweep, regex match */ }
  reapOrphanedProcesses() { /* three-layer sweep */ }
  spawnSdkChild(cmd, args) { return spawn(cmd, args, { stdio: 'pipe' }); }
}
```

**After**:
```ts
// The only registry that exists is src/supervisor/process-registry.ts.
// SDK spawn moves into a single helper there (see Phase 2).
// There is no ppid sweep, no orphan reaper, no "shadow" registry.
```

**Reference**: `_reference.md` Part 1 §Worker/lifecycle; `_mapping.md` Old Plan 07 rows labeled DELETE for Mechanism C (boot-once reconciliation block).

---

### Phase 2 — Spawn SDK children into their own process groups

**Purpose**: Every Claude SDK child gets its own process group at spawn time, so the parent can signal the whole subtree with one call. This is the OS primitive that makes orphan reaping unnecessary.

**Anchors**:
- `src/services/worker/ProcessRegistry.ts:452-465` — current spawn site (lifts to supervisor during Phase 1 consolidation)
- `_reference.md` Part 2 row 1 — Node `child_process.spawn({ detached: true })` signature
- `_reference.md` Part 2 row 3 — Bun.spawn does NOT support `detached`; we use Node's API

**Before**:
```ts
// src/services/worker/ProcessRegistry.ts:452-465 (current)
const proc = spawn(command, args, {
  stdio: 'pipe',
  // no detached, no process group
});
```

**After**:
```ts
// consolidated into src/supervisor/process-registry.ts
const proc = spawn(command, args, {
  detached: true,                        // Unix: setpgid, child becomes group leader
  stdio: ['ignore', 'pipe', 'pipe'],
});
const pgid = proc.pid;                   // group leader's PID == pgid on Unix
record.pgid = pgid;                      // track for teardown in Phase 3
```

**Reference**: `_reference.md` Part 2 row 1 (`spawn(cmd, args, { detached: true, stdio: ['ignore','pipe','pipe'] })` — creates new process group on Unix via `setpgid`); `_reference.md` Part 1 §Worker/lifecycle `src/services/worker/ProcessRegistry.ts:452-465`.

---

### Phase 3 — Shutdown cascade kills process groups, not single PIDs

**Purpose**: Teardown signals the group, not the leader. All descendants receive the signal; we never need to walk `ps` to find stragglers.

**Anchors**:
- `src/supervisor/shutdown.ts:22-99` — `runShutdownCascade` (5-phase)
- `src/supervisor/shutdown.ts:116` — current `process.kill(pid, 'SIGTERM')` call
- `src/supervisor/shutdown.ts:163` — current `process.kill(pid, 'SIGKILL')` call
- `_reference.md` Part 2 row 2 — `process.kill(-pgid, signal)` semantics

**Before**:
```ts
// src/supervisor/shutdown.ts:116, 163 (current — single PID only)
process.kill(record.pid, 'SIGTERM');
// wait 5s
process.kill(record.pid, 'SIGKILL');
```

**After**:
```ts
// src/supervisor/shutdown.ts:116, 163
// Negative PID signals the WHOLE process group on Unix (POSIX kill(2)).
// This tears down the SDK child and every descendant it spawned in one call.
process.kill(-record.pgid, 'SIGTERM');
// wait 5s for graceful exit (child.on('exit') resolves the cascade early)
process.kill(-record.pgid, 'SIGKILL');
```

**Reference**: `_reference.md` Part 2 row 2 (`process.kill(-pgid, signal)` — negative PID signals whole group on Unix; works in Bun via libuv); `_reference.md` Part 1 §Worker/lifecycle `src/supervisor/shutdown.ts:22-99, 116, 163`.

---

### Phase 4 — Delete all reaper intervals

**Purpose**: Zero repeating background timers in the worker. Orphans are prevented by Phase 2; stale sessions are an artifact of broken exit handling (fixed by Phase 5); failed rows are a retention policy question (handled at query time by `01-data-integrity.md`, not swept here).

**Anchors**:
- `src/services/worker-service.ts:537` — `startOrphanReaper` call (DELETE)
- `src/services/worker-service.ts:547` — `staleSessionReaperInterval = setInterval(...)` (DELETE)
- `src/services/worker-service.ts:567` — `clearFailedOlderThan` interval setup (DELETE)
- `src/services/worker/ProcessRegistry.ts:244-309` — `killIdleDaemonChildren` body (DELETE)
- `src/services/worker/ProcessRegistry.ts:315-344` — `killSystemOrphans` body (DELETE)
- `src/services/worker/ProcessRegistry.ts:349-382` — `reapOrphanedProcesses` body (DELETE)
- `src/services/worker/SessionManager.ts:516-568` — `reapStaleSessions` body (DELETE)

**Before**:
```ts
// src/services/worker-service.ts:537, 547, 567 (current)
this.startOrphanReaper();                               // 30s interval
this.staleSessionReaperInterval = setInterval(
  () => this.sessionManager.reapStaleSessions(), 60_000
);
this.clearFailedInterval = setInterval(
  () => this.pendingStore.clearFailedOlderThan(ms), 120_000
);
```

**After**:
```ts
// src/services/worker-service.ts
// (nothing — no intervals, no reapers)
// child.on('exit') drives session teardown; Phase 2 process groups prevent orphans;
// 01-data-integrity handles failed-row retention via query-time filters.
```

**Reference**: `_reference.md` Part 1 §Worker/lifecycle `src/services/worker-service.ts:537, 547, 567`; Part 1 §Worker/lifecycle `ProcessRegistry.ts:244-309, 315-344, 349-382`; `SessionManager.ts:516-568`.

---

### Phase 5 — Delete the per-session `abandonedTimer` setTimeout

**Purpose**: `abandonedTimer` is a polling loop wearing a `setTimeout` disguise — it exists because the primary-path cleanup in `generatorPromise.finally` was unreliable. Fix the primary path, delete the defense.

**Anchors**:
- `src/services/worker/SessionManager.ts:631-670` — `getMessageIterator` + idle-timer callback
- `_mapping.md` Old Plan 07 Mechanism B row — DELETE verdict

**Before**:
```ts
// src/services/worker/SessionManager.ts (current, conceptual)
session.abandonedTimer = setTimeout(() => {
  this.cleanupSession(session.id);        // polling via timer
}, ABANDONED_MS);
```

**After**:
```ts
// cleanup runs synchronously when the generator settles — one path, no timer
generatorPromise.finally(() => {
  this.cleanupSession(session.id);
});
```

**Reference**: `_reference.md` Part 1 §Worker/lifecycle `SessionManager.ts:631-670`; `_mapping.md` Old Plan 07 row "Mechanism B: Per-session `abandonedTimer` setTimeout" — DELETE.

---

### Phase 6 — Delete idle-eviction from SessionManager

**Purpose**: Evicting the "idlest" session to make room for a new one is load-shedding implemented at the wrong layer. Backpressure belongs on the queue, not on the pool.

**Anchors**:
- `src/services/worker/SessionManager.ts:477-506` — `evictIdlestSession`

**Before**:
```ts
// src/services/worker/SessionManager.ts:477-506 (current)
evictIdlestSession() {
  // scan pool, find oldest lastActiveAt, kill it to free a slot
}
```

**After**:
```ts
// deleted. Pool admission is gated by queue depth at SessionQueueProcessor;
// a full pool applies backpressure upstream instead of kicking live sessions.
```

**Reference**: `_reference.md` Part 1 §Worker/lifecycle `SessionManager.ts:477-506`.

---

### Phase 7 — Delete fallback agent chain (Gemini → OpenRouter)

**Purpose**: A fallback-agent chain hides SDK failures behind "it kind of worked with a different model." Principle 2 (fail-fast): surface the failure to the hook via exit code 2, let the caller decide.

**Anchors**:
- `src/services/worker/SessionManager.ts` — `fallbackAgent` / Gemini / OpenRouter references
- `_reference.md` Part 2 row 7 — Claude Code hook exit codes (0/1/2)

**Before**:
```ts
// src/services/worker/SessionManager.ts (current, conceptual)
try {
  return await runClaudeSdk(payload);
} catch (err) {
  logger.warn('SDK failed, falling back to Gemini');
  return await runGemini(payload);         // silent degrade
}
```

**After**:
```ts
// SDK failure surfaces. Worker returns non-200; hook exits 2 so Claude Code sees it.
return await runClaudeSdk(payload);
```

**Reference**: `_reference.md` Part 2 row 7 (exit-code contract); principle 2 (no silent fallbacks).

---

### Phase 8 — Lazy-spawn wrapper in every hook

**Purpose**: Hooks start the worker when needed, detached from the hook process's lifetime. The wrapper is a few lines with no daemon-mode, no supervisor-in-a-box. Inherits PID-reuse safety from the supervisor start-guard (see Phase 9 and PID-reuse section).

**Anchors**:
- `src/shared/worker-utils.ts:221-239` — current `ensureWorkerRunning` (port health check)
- `src/services/infrastructure/ProcessManager.ts:1013-1032` — daemon spawn pattern reference (`setsid` on Unix, `detached: true` fallback)

**Before**:
```ts
// src/shared/worker-utils.ts:221-239 (current)
export async function ensureWorkerRunning(): Promise<boolean> {
  // ping port; return true/false — caller degrades on false
}
```

**After**:
```ts
// src/shared/worker-utils.ts — lazy-spawn wrapper skeleton (~10 lines)
export async function ensureWorkerRunning(): Promise<boolean> {
  if (await isWorkerPortAlive()) return true;       // inherits PID-reuse check (99060bac)
  const proc = spawn(bunPath, [workerPath], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();                                     // hook exit doesn't kill worker
  return await waitForWorkerPort({ attempts: 3, backoffMs: 250 });
}
```

**Reference**: `_reference.md` Part 1 §Hooks/CLI `src/shared/worker-utils.ts:221-239`; Part 1 §Worker/lifecycle `ProcessManager.ts:1013-1032`; Part 2 row 1 (spawn signature) and row 3 (Bun.spawn lacks `detached` — we use Node's API).

**Decision point — `respawn` dep vs hand-rolled retry**: see dedicated subsection below. Chosen path: **(b) hand-rolled 3-attempt retry with exponential backoff.**

---

### Phase 9 — Delete worker self-shutdown

**Purpose**: The worker has no business deciding to exit on idle. If no work arrives, the worker sits idle; `proc.unref()` already ensures it does not keep the launching hook alive. The worker runs until killed (SIGTERM from installer, SIGKILL from crash, or OS reboot).

**Anchors**:
- `src/services/worker-service.ts:1094-1120` — shutdown sequence (KEEP the sequence for explicit SIGTERM; DELETE any idle-triggered self-shutdown path)

**Before**:
```ts
// conceptual — any idleCheck / idleTimeout that calls performGracefulShutdown on its own
if (Date.now() - lastActivity > IDLE_MAX_MS) this.shutdown();
```

**After**:
```ts
// no idle timer. Worker exits only on external signal or crash.
// performGracefulShutdown (GracefulShutdown.ts:52-86) remains for external SIGTERM.
```

**Reference**: `_reference.md` Part 1 §Worker/lifecycle `src/services/worker-service.ts:1094-1120`; Part 1 §Worker/lifecycle `GracefulShutdown.ts:52-86`.

---

## Required code snippets

### Process-group spawn (Unix)

```ts
// Node child_process.spawn — detached: true creates a new process group (setpgid).
// The child survives parent death; parent signals the whole subtree via negative PID.
const proc = spawn(command, args, {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const pgid = proc.pid;   // on Unix, group leader's PID is the pgid
```

### Kill the whole process group

```ts
// Negative PID signals the whole process group on Unix (POSIX kill(2)).
// Tears down the SDK child AND every descendant it spawned in one syscall.
// UNIX ONLY — on Windows, process.kill(-pgid, …) is not supported; see Platform caveat.
process.kill(-pgid, 'SIGTERM');
// wait up to 5s for graceful exit; child.on('exit') may short-circuit the wait
process.kill(-pgid, 'SIGKILL');
```

### Lazy-spawn wrapper (hook-side)

```ts
// src/shared/worker-utils.ts
export async function ensureWorkerRunning(): Promise<boolean> {
  if (await isWorkerPortAlive()) return true;  // port check inherits PID-reuse guard
  const proc = spawn(bunPath, [workerPath], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();                                 // hook exit doesn't keep worker linked
  return await waitForWorkerPort({ attempts: 3, backoffMs: 250 });
}
```

---

## Verification grep targets

```
grep -rn "setInterval" src/services/worker/                    → 0
grep -rn "startOrphanReaper" src/                              → 0
grep -rn "staleSessionReaperInterval" src/                     → 0
grep -rn "killSystemOrphans" src/                              → 0
grep -rn "killIdleDaemonChildren" src/                         → 0
grep -rn "reapStaleSessions" src/                              → 0
grep -rn "reapOrphanedProcesses" src/                          → 0
grep -rn "evictIdlestSession" src/                             → 0
grep -rn "abandonedTimer" src/                                 → 0
grep -rn "fallbackAgent\|Gemini\|OpenRouter" src/services/worker/SessionManager.ts  → 0
test ! -e src/services/worker/ProcessRegistry.ts               → file does NOT exist
test -d src/supervisor/                                        → directory DOES exist
Integration test: kill -9 <worker-pid> → next hook respawns worker; no orphan children
Integration test: graceful SIGTERM → all SDK children exit within 6s
```

---

## Anti-pattern guards

- Do NOT keep `killSystemOrphans` as a boot-once function — orphans are PREVENTED by process groups, not swept.
- Do NOT add idle-timer self-shutdown to the worker.
- Do NOT introduce a third process registry during the migration.

---

## Platform caveat — Windows

`process.kill(-pgid, signal)` is **Unix-only**. On Windows, negative PIDs are not a valid signal target; the Node API surface differs (no POSIX process groups, no `setpgid`). The Windows equivalent is a **Job Object**: a child is assigned to a Job, and `TerminateJobObject` tears down the whole Job. Node does not expose Job Objects directly; a native addon (`node-windows-killtree`, `taskkill /T /F /PID`, or Windows-specific `child_process` flags) is required.

This is a documented gap-to-fix, carried forward from `_rewrite-plan.md` Known gaps #3. **This plan does not commit to a Windows implementation.** Current claude-mem users on Windows are served via WSL (which exposes Unix process-group semantics). A native Windows port is future work and belongs in its own plan.

---

## `respawn` dep decision

**Options**:
- **(a)** Adopt the [`respawn` npm package](https://github.com/mafintosh/respawn) (~200 LOC pure JS; by `mafintosh`; NOT currently a dependency per `_reference.md` Part 2 row "`respawn` npm package").
- **(b)** Hand-roll a 3-attempt retry with exponential backoff inside the lazy-spawn wrapper.

**Chosen: (b) — hand-roll 3-attempt retry with exponential backoff.**

**Rationale**:
1. **Fewer deps.** `respawn` would be a new top-level runtime dependency for behaviour that fits in ~10 lines (`waitForWorkerPort({ attempts: 3, backoffMs: 250 })`). Principle 6 (one helper, N callers) prefers the narrow local helper over a general-purpose supervisor library.
2. **The retry is trivial.** Three attempts, 250ms → 500ms → 1000ms backoff. No supervision semantics beyond "start one child and wait for its port to open."
3. **Supervision is already handled by the OS.** `respawn` shines when you want auto-restart-on-crash while the parent keeps running. We explicitly do NOT want that: the hook is short-lived and detaches via `proc.unref()`; long-running supervision is the OS's job (launchd / systemd user unit — documented in `_reference.md` Part 2 rows 8-9 as future installer work, NOT adopted here).
4. **We control the failure mode.** If all three attempts fail, the hook reports via exit code 2 (Phase 7 contract), which surfaces to Claude. A library would add an opinion layer we don't need.

If a future phase demands auto-restart-while-parent-lives semantics (e.g., a persistent hook that wants to keep the worker alive inside its own process tree), revisit (a). Not this plan.

---

## PID-reuse safety

The lazy-spawn wrapper's port-check fast path (`if (await isWorkerPortAlive()) return true`) must NOT be fooled by a stale PID-file pointing at a recycled PID. This is the exact failure mode fixed by commit **`99060bac`** ("fix: detect PID reuse in worker start-guard (container restarts)"), which introduced `captureProcessStartToken` at `src/supervisor/process-registry.ts:85-173` (reads `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS; returns `null` on Windows).

**Requirement for Phase 8**: the `isWorkerPortAlive()` helper — or the layer above it — must compare the current process start-token against the recorded token before treating "port open at recorded PID" as "our worker is alive." If the tokens differ, treat the port as dead (a different process is squatting on it) and fall through to the spawn path. This inherits the primary-path correctness of commit `99060bac` rather than reimplementing it. No new PID-reuse logic lives in `worker-utils.ts`; it calls the supervisor's start-token check.

**Reference**: `_reference.md` Part 1 §Worker/lifecycle `src/supervisor/process-registry.ts:85-173` — `captureProcessStartToken` (KEEP, legitimate primary-path correctness); commit `99060bac`.
