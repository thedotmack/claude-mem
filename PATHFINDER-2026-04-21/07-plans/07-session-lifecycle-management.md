# Implementation Plan: session-lifecycle-management

**Flowchart**: PATHFINDER-2026-04-21/05-clean-flowcharts.md § 3.8 ("session-lifecycle-management (clean) — BIGGEST CULL")
**Before-state**: PATHFINDER-2026-04-21/01-flowcharts/session-lifecycle-management.md
**Scope** (revised 2026-04-22: zero-timer model): delete all three repeating background timers in the worker layer — no `ReaperTick` replacement, no `sqliteHousekeepingInterval`. Replace each recurring check with one of: (a) the `child.on('exit')` handlers already wired at `ProcessRegistry.ts:479` (SDK) and `worker-service.ts:530` (MCP), (b) the per-iterator 3-min idle `setTimeout` already wired at `SessionQueueProcessor.ts:6` (covers hung-generator case on its own), (c) a per-session `setTimeout(deleteSession, 15min)` scheduled on last-generator-completion and cleared on new activity (covers abandoned-session case), (d) a boot-once reconciliation block that calls the existing `killSystemOrphans()` + `supervisor.pruneDeadEntries()` + `recoverStuckProcessing()` + `clearFailedOlderThan(1h)` once at worker startup. Delete the worker-level `ProcessRegistry` facade (528 LoC). Inline the SIGTERM→SIGKILL ladder. Implement blocking `POST /api/session/end`.

**Target LoC**: process-lifecycle ~900 → ~400.
**Target repeating-timer count in `src/services/worker/` + `worker-service.ts`**: 3 → **0**. (The only `setTimeout` calls that remain are the per-operation escalation ladder, per-session idle, per-session abandonment, and the generator-exit race — all non-repeating, all correct.)

---

## Dependencies

### Upstream (must land first)

- **01-privacy-tag-filtering** — defines shared `stripMemoryTags(text)` in `src/utils/tag-stripping.ts`. Phase 1 of THIS plan introduces `ingestObservation` / `ingestPrompt` / `ingestSummary` helpers that call that function. If 01 has not landed, Phase 1 here imports the existing wrappers, but the ingest-helper location (`src/services/ingest/`) is authoritative and 01 rewires its call-sites into these helpers.
- **02-sqlite-persistence** — owns the boot-recovery section of `sqlite-persistence (clean)` (§ 3.3 bottom box `BootOnce`). V19 per-claim 60-s reset (`PendingMessageStore.ts:99-145`) is deleted by Phase 5 of THIS plan and replaced with a single `PendingMessageStore.recoverStuckProcessing()` called once in worker boot. 02 codifies the broader schema-recovery ordering; Phase 5 slots `recoverStuckProcessing()` into that boot sequence.
- **03-response-parsing-storage** — defines `ResponseProcessor` + `session.recordFailure()` contract. Phase 7 (blocking `/api/session/end`) awaits the `summary_stored` flag that `ResponseProcessor` sets after a successful summary commit. The "summary_stored OR 110s timeout" integration point lives inside this plan (Phase 7) but depends on 03 wiring the flag.

### Downstream (this plan enables)

- **09-lifecycle-hooks** — hook layer consumes the blocking `POST /api/session/end` built in Phase 7 (replaces the current 500-ms polling loop in `src/cli/handlers/summarize.ts:117-150`). That plan's hook simplification is blocked until Phase 7 ships.

---

## Concrete findings from live code

### `src/services/worker/ProcessRegistry.ts` (527 lines — entire file slated for deletion)

Exposed surface (every export → supervisor-registry method it should hit directly):

| Worker export | File:line | Replacement |
|---|---|---|
| `registerProcess(pid, sessionDbId, process)` | `:57-65` | `getSupervisor().registerProcess(id, info, procRef)` — already the body of this function |
| `unregisterProcess(pid)` | `:70-79` | `getSupervisor().getRegistry().getByPid(pid)` + `getSupervisor().unregisterProcess(record.id)` — already the body |
| `getProcessBySession(sessionDbId)` | `:85-94` | Move to free helper `findSessionProcess(id)` in `src/services/worker/process-spawning.ts`; body iterates `getRegistry().getAll()` + filters by `type==='sdk'` (same as `getTrackedProcesses` helper at `:34-52`) |
| `getActiveCount()` | `:99-101` | Direct: `getSupervisor().getRegistry().getAll().filter(r => r.type==='sdk').length` |
| `waitForSlot(max, timeout, evict)` | `:122-167` | Pool-slot bookkeeping is worker-scoped, **not** a supervisor concern. Keep as free function in `process-spawning.ts`. The `slotWaiters` array (`:104`) stays module-local. |
| `notifySlotAvailable()` (internal) | `:109-112` | Stays module-local in `process-spawning.ts`; called from the `exit` event handler inside `createPidCapturingSpawn`. Under the zero-timer model, `exit` is the sole runtime trigger, so slot notification happens directly from the handler that already owns subprocess-death semantics. No scanner involved. |
| `getActiveProcesses()` | `:172-179` | Free helper in `process-spawning.ts` (still used for stats / debug endpoints). |
| `ensureProcessExit(tracked, timeoutMs=5000)` | `:185-229` | **Inline** into `deleteSession` (SessionManager.ts:406-413) as 12-line block: check `exitCode`, `Promise.race([once('exit'), setTimeout])`, SIGKILL, race again. Per audit item #9 and anti-pattern guard A. |
| `killIdleDaemonChildren()` | `:244-309` | **Delete**. Its runtime role (cleaning up our own idle daemons) is covered by the `child.on('exit')` handler at `ProcessRegistry.ts:479` which already calls `unregisterProcess(pid)`, combined with the per-iterator 3-min idle `setTimeout` at `SessionQueueProcessor.ts:6` that aborts hung generators. Ppid=1 leftovers from a prior worker crash are caught by boot-once `killSystemOrphans()` (see next row). |
| `killSystemOrphans()` | `:315-344` | **Keep function body; move call from interval to boot-once.** Ppid=1 Claude processes can only exist because a *previous* worker crashed without reaping them — during the current worker's lifetime, `exit` handlers catch subprocess death. So one call at worker startup covers the full scope. Called from worker boot init (Phase 3), never scheduled. |
| `reapOrphanedProcesses(activeSessionIds)` | `:349-382` | **Delete**. Runtime component: covered by `exit` handlers. Cross-restart component: covered by boot-once `supervisor.pruneDeadEntries()` which walks the registry and drops entries whose PIDs are no longer in the OS. |
| `createPidCapturingSpawn(sessionDbId)` | `:393-502` | Move verbatim to `process-spawning.ts` as free function. It already wires `child.on('exit')` → `unregisterProcess(pid)` at `:479-486` — keep that path; it's the sole runtime subprocess-death signal under the zero-timer model. |
| `startOrphanReaper(getActiveSessionIds, intervalMs=30_000)` | `:508-527` | **Delete**; no replacement timer. |

Caller fan-out (every `from '.../ProcessRegistry'` site must be re-pointed):

- `src/services/worker/SessionManager.ts:17` — imports `getProcessBySession, ensureProcessExit`. Rewrite: import from `./process-spawning.js` (findSessionProcess), and inline the exit wait in `deleteSession`.
- `src/services/worker/SDKAgent.ts:24` — imports `createPidCapturingSpawn, getProcessBySession, ensureProcessExit, waitForSlot`. Rewrite: import from `./process-spawning.js`. The `ensureProcessExit` call-site (search inside SDKAgent) goes away when we route through `deleteSession`.
- `src/services/worker-service.ts:109` — imports `startOrphanReaper, reapOrphanedProcesses, getProcessBySession, ensureProcessExit`. After Phase 3, imports shrink to `{ getActiveProcesses }` from `./process-spawning.js`. `startOrphanReaper` + `reapOrphanedProcesses` delete. The `ensureProcessExit` at `worker-service.ts:786` inlines.

### `src/supervisor/process-registry.ts` (408 lines — authoritative, stays as-is)

Relevant API (no changes needed):

- `class ProcessRegistry` at `:175` — `register`, `unregister`, `getAll`, `getBySession`, `getByPid`, `getRuntimeProcess`, `pruneDeadEntries` (`:269-285`, uses `isPidAlive`), `reapSession(sessionId)` (`:292-385`, implements SIGTERM → wait 5 s → SIGKILL → wait 1 s).
- `isPidAlive(pid)` at `:28-45` — reused directly by boot-once `supervisor.pruneDeadEntries()` (Phase 3 Mechanism C) and by the inlined `killSystemOrphans()` body, both called exactly once per worker boot. Not called by any repeating timer.
- `getSupervisor().getRegistry()` — how worker code reaches this class (verified in worker/ProcessRegistry.ts:39, 71, 353).

### `src/services/worker/worker-service.ts`

- Line `109`: import site that must shrink.
- Line `174`: `private staleSessionReaperInterval: ReturnType<typeof setInterval> | null = null;` — delete field.
- Line `537`: `this.stopOrphanReaper = startOrphanReaper(() => { ... });` — delete outright, no replacement timer. Runtime subprocess death is handled by `child.on('exit')` handlers; cross-restart orphans are handled by boot-once `killSystemOrphans()` + `supervisor.pruneDeadEntries()`.
- Line `547`: `this.staleSessionReaperInterval = setInterval(async () => { ... }, 2*60*1000)` — **delete the entire block** (outer wrapper + body). Disposition of the three things it did under the zero-timer model:
  - `reapStaleSessions()` → deleted (no replacement timer). Hung-generator case is covered by the per-iterator idle `setTimeout` at `SessionQueueProcessor.ts:6`; no-generator abandonment is covered by the per-session `abandonedTimer` (Phase 3 Mechanism B).
  - `clearFailedOlderThan(1h)` → moved to boot-once (Phase 3 Mechanism C step 4, co-owned with plan 02).
  - `PRAGMA wal_checkpoint(PASSIVE)` → deleted outright. SQLite's default `wal_autocheckpoint=1000` pages is the contract (confirmed at `Database.ts:162-168` — no override).
- Line `786`: `await ensureProcessExit(trackedProcess, 5000)` — inline.
- Line `1108-1110`: shutdown path clears `staleSessionReaperInterval`. **Delete both shutdown clauses outright** — there is nothing to clear since no `setInterval` remains in the worker layer.

### `src/services/worker/SessionManager.ts`

- `MAX_GENERATOR_IDLE_MS = 5*60*1000` at `:23` — **delete**. Hung-generator detection is now owned by `SessionQueueProcessor.ts:6` (`IDLE_TIMEOUT_MS = 3*60*1000`) at the stream level. The 5-min worker-layer threshold is redundant with the 3-min per-iterator threshold and the old split created two sources of truth.
- `MAX_SESSION_IDLE_MS = 15*60*1000` at `:26` — keep; now consumed by the per-session `scheduleAbandonedCheck()` method (Phase 3 Mechanism B).
- `detectStaleGenerator(session, proc, now)` at `:59-84` — **delete**. Its consumer (`reapStaleSessions`) is being deleted; its logic (compare `lastGeneratorActivity` against a threshold) is superseded by the per-iterator idle `setTimeout` in `SessionQueueProcessor.ts` which resets on every chunk and fires `onIdleTimeout` → `abortController.abort()` at the stream level, not from a scanner.
- `deleteSession(sessionDbId)` at `:381-446` — inline `ensureProcessExit` at `:412`; additionally, clear `session.abandonedTimer` at the top of this method if set (per Phase 3 Mechanism B wiring).
- `reapStaleSessions()` at `:516-568` — **delete method**, no replacement closure. The two branches:
  - Generator-active branch at `:520-549`: replaced by the per-iterator idle `setTimeout` at `SessionQueueProcessor.ts:6` which aborts the controller when the stream is silent ≥3 min. The subprocess's `exit` handler then unregisters.
  - No-generator branch at `:550-561`: replaced by the per-session `abandonedTimer` `setTimeout` scheduled on last-generator-completion and cleared on new activity (Phase 3 Mechanism B).
- `queueSummarize(sessionDbId, lastAssistantMessage)` at `:329-377` — unchanged; Phase 7's blocking endpoint calls this first, then awaits.

### `src/services/worker/SDKAgent.ts`

- Line `24` imports.
- The iterator pattern uses `session.abortController` (established in `SessionManager.initializeSession`); Phase 7's `/api/session/end` calls `session.abortController.abort()` after awaiting summary_stored. No change to SDKAgent body needed for abort semantics — the AbortSignal flows through the SDK query already (confirmed by SessionManager.ts:390 existing abort path).

### `src/services/sqlite/PendingMessageStore.ts`

- `STALE_PROCESSING_THRESHOLD_MS = 60_000` at `:6`.
- `claimNextMessage(sessionDbId)` at `:99-145` — the transaction body currently does both self-heal (`:103-116`) and claim (`:118-140`). Phase 5: keep the transaction, delete lines `103-116`, add a new public method `recoverStuckProcessing(): number` that runs the same UPDATE **unscoped by session id** once at worker boot.
- No behavior regression: the only functional change is timing. Crashed sessions are recovered on next worker boot (correct crash-recovery semantic), not on every claim call (polling anti-pattern).

### Blocking `POST /api/session/end` (Phase 7) — current state

- Existing endpoints (to consolidate):
  - `POST /api/sessions/summarize` at `SessionRoutes.ts:387` → handler `handleSummarizeByClaudeId` → calls `queueSummarize` (`:705`) and returns immediately.
  - `POST /api/sessions/complete` at `SessionRoutes.ts:753` → clears active session map.
  - `GET /api/sessions/status?contentSessionId=...` at hook-side polling (`src/cli/handlers/summarize.ts:123`) — returns `{queueLength, summaryStored}`.
- `session.lastSummaryStored` is already written inside `ResponseProcessor` (see `SessionRoutes.ts:747` where it is read). This is the flag Phase 7 awaits.
- Phase 7 delivers: `POST /api/session/end` — body `{sessionDbId, last_assistant_message}`. Server-side: call `queueSummarize`, then `await` a `Promise` that resolves when `session.lastSummaryStored` flips, with a hard 110 000 ms timeout, then `session.abortController.abort()`, then `deleteSession`. Returns `{summaryId or null}`.
- Hook simplification (in 09-lifecycle-hooks plan) replaces the 220-iteration 500-ms poll loop at `summarize.ts:117-150` with one POST.

---

## Copy-ready snippet locations — event-driven + boot-once + per-session timers (revised 2026-04-22)

No new file. No `reaper.ts`. No `ReaperTick`. Three mechanisms, spread across existing modules:

### Mechanism A — `child.on('exit')` handlers (already wired; verify and keep)

- SDK spawn: `ProcessRegistry.ts:475-486` → moves to `process-spawning.ts:createPidCapturingSpawn` in Phase 2. The `on('exit', ...)` at `:479` must continue to call `unregisterProcess(child.pid)` at `:484`. Do not modify.
- MCP spawn: `worker-service.ts:523-532`. The `once('exit', ...)` at `:530` must continue to call `getSupervisor().unregisterProcess('mcp-server')` at `:531`. Do not modify.
- Per-iterator 3-min idle timeout: `SessionQueueProcessor.ts:6` (`IDLE_TIMEOUT_MS`), resets at `:51-52, :62-63`, fires `onIdleTimeout` at `:93-104` → `SessionManager.ts:651-655` → `session.abortController.abort()` → the abort signal reaches the spawn at `ProcessRegistry.ts:463` → child exits → `exit` handler unregisters. This chain already exists and covers the hung-generator case entirely.

**No code edit** — this mechanism is the verification target, not the change target. Phase 3 verification greps confirm these handlers are still in place after Phase 2's extraction.

### Mechanism B — Per-session abandoned-session `setTimeout` (new, replaces `reapAbandonedSessions`)

Goal: when a session has no generator running and no pending messages for 15 min, delete it. Detected at the session itself rather than by a global scanner.

Add to `SessionManager.ts`:

```ts
// In ActiveSession interface — add:
abandonedTimer?: ReturnType<typeof setTimeout>;

// New private method on SessionManager:
private scheduleAbandonedCheck(sessionDbId: number): void {
  const session = this.sessions.get(sessionDbId);
  if (!session) return;
  if (session.abandonedTimer) clearTimeout(session.abandonedTimer);
  session.abandonedTimer = setTimeout(() => {
    const s = this.sessions.get(sessionDbId);
    if (!s) return;
    if (s.generatorPromise !== null) return;                     // still working — drop the timer silently
    if (this.pendingStore.getPendingCount(sessionDbId) > 0) {
      this.scheduleAbandonedCheck(sessionDbId);                  // work arrived while we waited — reschedule
      return;
    }
    void this.deleteSession(sessionDbId);                        // truly abandoned — clean up
  }, MAX_SESSION_IDLE_MS);
}

// In every code path that marks "work finished" — call scheduleAbandonedCheck
// In every code path that marks "new work arrived" — call clearTimeout(session.abandonedTimer)
```

Call-sites (derived from `SessionManager.ts`):

- Schedule (work finished): after `generatorPromise` resolves at `SessionManager.ts:~335` (`queueSummarize` fire-and-forget completion) and after `iterator` exits at `SessionManager.ts:~648` (the for-await loop exit).
- Clear (new work arrived): at the top of `initializeSession()` when a pending message lands; inside `queueSummarize()`; inside any `ingestObservation` path that sets `lastActivity`.

The timer is per-session, not repeating. When it fires it either deletes the session or reschedules itself if new work snuck in — no drift, no thundering-herd scan.

### Mechanism C — Boot-once reconciliation block (new helper in `worker-service.ts`)

Goal: at worker startup, in ONE sequential block, reconcile all state that event handlers cannot catch (i.e., state that can only have been orphaned by a previous worker instance).

Add to `worker-service.ts` boot init, immediately after `resetStaleProcessingMessages(0)` at `:424`:

```ts
// Boot-once reconciliation — runs exactly ONCE per worker process lifetime.
// Catches state orphaned by a previous (possibly crashed) worker instance.
await this.reconcileWorkerStartup();

// private method:
private async reconcileWorkerStartup(): Promise<void> {
  // 1. Kill ppid=1 Claude processes leftover from a crashed prior worker.
  //    (Copy body of killSystemOrphans from ProcessRegistry.ts:315-344 into
  //    process-spawning.ts as a free helper before Phase 2 deletes the file.)
  await killSystemOrphans();

  // 2. Prune registry entries whose PID is no longer in the OS (crash-recovery).
  getSupervisor().getRegistry().pruneDeadEntries();

  // 3. pending_messages stuck on 'processing' from a crashed worker.
  //    (Moved from per-claim 60-s reset — see Phase 5.)
  this.sessionManager.getPendingMessageStore().recoverStuckProcessing();

  // 4. SQLite housekeeping (moved from the deleted stale-reaper interval).
  //    (Covered by plan 02's boot-once SQLite housekeeping phase — this
  //    plan assumes 02 has landed; if it has not, copy the call here.)
  this.sessionManager.getPendingMessageStore().clearFailedOlderThan(60 * 60 * 1000);
}
```

No `setInterval` anywhere in this block. Each step runs exactly once. Explicit `PRAGMA wal_checkpoint` is **not** in this block because SQLite's default `wal_autocheckpoint=1000` pages (`Database.ts:162-168` sets no override) is the contract — see plan 02.

### What's deleted outright (no replacement)

- `src/services/worker/reaper.ts` (never created in this revision).
- `startReaperTick` export (never created).
- `staleSessionReaperInterval` (`worker-service.ts:174, :547`).
- `startOrphanReaper` (`ProcessRegistry.ts:508-527`, `worker-service.ts:537-544`).
- `reapStaleSessions` (`SessionManager.ts:516-568`).
- `reapOrphanedProcesses` (`ProcessRegistry.ts:349-382`).
- `killIdleDaemonChildren` as a runtime sweep (`ProcessRegistry.ts:244-309`) — function deleted entirely; its role is already covered by `exit` handlers + per-iterator idle timeout.
- Periodic `PRAGMA wal_checkpoint(PASSIVE)` call at `worker-service.ts:~581` — SQLite default covers it.
- Periodic `clearFailedOlderThan(1h)` call at `worker-service.ts:~567` — moved to boot-once (Mechanism C step 4).

---

## Phases

Every phase must satisfy: (a) precise "Copy from …" pointer, (b) doc citations, (c) verification, (d) anti-pattern guards (A invent supervisor API; B polling; D facade-over-facade).

### Phase 1 — Introduce ingest helpers (`ingestObservation` / `ingestPrompt` / `ingestSummary`)

(a) **Implement**:
- Create `src/services/ingest/index.ts` (new module). Three exports:
  - `ingestObservation(payload: ObservationPayload): { id: number; skipped: boolean }`
  - `ingestPrompt(payload: PromptPayload): { id: number; skipped: boolean }`
  - `ingestSummary(payload: SummaryPayload): { id: number; skipped: boolean }`
- Each helper: `stripMemoryTags` all user-facing text fields → `PrivacyCheckValidator.validate(operationType)` (existing at `src/services/worker/validation/PrivacyCheckValidator.ts:17-24`) → `INSERT pending_messages` via `PendingMessageStore.enqueue`.
- Copy from: current HTTP-boundary strip + validate + enqueue sequence in `SessionRoutes.ts:696-705` (summarize branch) and the observation-queue path in `SessionManager.ts:276`. Consolidate.

(b) **Docs**:
- 05 § 3.8 — "`POST /api/session/observation` → `ingestObservation(payload) strip → validate → INSERT pending_messages` → emit 'message' event"
- 05 Part 2 D1 ("One observation ingest path")
- 05 § 3.2 call-site list (`C1` ingestObservation, `C2` ingestPrompt, `C3` ingestSummary — **C3 closes the summary privacy gap**)
- 06 cites `src/services/worker/validation/PrivacyCheckValidator.ts:17-24`
- Live: `src/services/worker/http/routes/SessionRoutes.ts:696-705`, `src/services/worker/SessionManager.ts:276`

(c) **Verification**:
- Grep `stripMemoryTags` usage: exactly 3 call-sites (one per helper) + unit test imports.
- Unit test: `ingestSummary({ last_assistant_message: "<private>secret</private> clean text" })` → DB row's `last_assistant_message` field does not contain "secret" (closes P1).
- `POST /api/sessions/summarize` call-path routes through `ingestSummary` (no direct strip call in `SessionRoutes.ts` anymore).

(d) **Guards**:
- A: do **not** add a fourth "`ingestAny(type, payload)`" dispatcher; the three shapes have different required fields and privacy rules. Separate functions → explicit failure modes.
- D: do **not** keep the old HTTP-boundary strip calls as a "belt-and-suspenders" second pass. Edge-processing only.

### Phase 2 — Delete `src/services/worker/ProcessRegistry.ts`; extract spawn helpers

(a) **Implement**:
- Create `src/services/worker/process-spawning.ts`:
  - `createPidCapturingSpawn(sessionDbId)` — copy verbatim from `ProcessRegistry.ts:393-502`.
  - `findSessionProcess(sessionDbId): TrackedProcess | undefined` — copy from `ProcessRegistry.ts:85-94` (`getProcessBySession` renamed for clarity).
  - `getActiveProcesses()` — copy from `:172-179`.
  - `getActiveProcessCount()` — copy from `:99-101`.
  - `waitForSlot(max, timeoutMs, evict)` + `notifySlotAvailable()` + `slotWaiters` array + `TOTAL_PROCESS_HARD_CAP` — copy from `:104-167`.
  - `TrackedProcess` interface — copy from `:27-32`.
  - Inline helper `getTrackedProcesses()` — copy from `:34-52`.
- Rewire imports in:
  - `SessionManager.ts:17` → `{ findSessionProcess }` from `./process-spawning.js`.
  - `SDKAgent.ts:24` → `{ createPidCapturingSpawn, findSessionProcess, waitForSlot }`.
  - `worker-service.ts:109` → `{ getActiveProcesses }`.
- Delete `src/services/worker/ProcessRegistry.ts`.

(b) **Docs**:
- 05 § 3.8 "Deleted: `src/services/worker/ProcessRegistry.ts` (facade, 528 lines) — supervisor registry is source of truth"
- 05 Part 1 item #4
- 06 Phase 5 "Delete worker ProcessRegistry facade" (Phase 5 :246-280)
- V5, V6
- Live: `ProcessRegistry.ts:1-527`, `worker-service.ts:109, 537, 786`, `SessionManager.ts:17, 412`, `SDKAgent.ts:24`

(c) **Verification**:
- `test -f src/services/worker/ProcessRegistry.ts` → false.
- `grep -rn "worker/ProcessRegistry" src/` → 0.
- `npx tsc --noEmit` clean.
- Manual: spawn SDK subprocess, kill with `kill -TERM <pid>`; subprocess exits; supervisor-registry prunes dead PID on next reaper tick (Phase 3 verifies the prune).

(d) **Guards**:
- D: no compat shim re-exporting deleted symbols.
- A: do **not** invent new methods on `supervisor/process-registry.ts` — use its existing public API (`register`, `unregister`, `getByPid`, `getBySession`, `getAll`, `pruneDeadEntries`, `reapSession`, `getRuntimeProcess`).

### Phase 3 — Wire event-driven cleanup + boot-once reconciliation + per-session abandoned-session timer (revised 2026-04-22)

**Previously proposed:** build a new `reaper.ts` module exporting a `ReaperTick` with three skippable checks on a 30-s interval; additionally introduce a dedicated `sqliteHousekeepingInterval` for `clearFailedOlderThan` + `wal_checkpoint`. Both were rejected as band-aids by investigation 2026-04-22 — see `08-reconciliation.md` Part 4 revision. This phase is now a **three-part change with zero new `setInterval`s.**

(a) **Implement — Part 1 (Mechanism A: verify existing event handlers survive Phase 2's extraction)**:

After Phase 2 moved `createPidCapturingSpawn` from `ProcessRegistry.ts:393-502` to `process-spawning.ts`, verify the subprocess `exit` handler still:
- At `ProcessRegistry.ts:479` (now `process-spawning.ts` in its new location): `child.on('exit', ...)` is present.
- Calls `unregisterProcess(child.pid)` (line `:484` relative) on exit.
- Also calls `notifySlotAvailable()` inside the same handler (keeps pool bookkeeping correct without a scanner).

No code change beyond what Phase 2 already did — the handler was already correct; this phase is where it *becomes load-bearing* because the sweeper it was backing up is being deleted.

(a) **Implement — Part 2 (Mechanism B: per-session abandoned-session `setTimeout`)**:

In `SessionManager.ts`:

1. Add `abandonedTimer?: ReturnType<typeof setTimeout>` to `ActiveSession` interface.
2. Add private `scheduleAbandonedCheck(sessionDbId: number): void` per the Copy-ready snippet section (Mechanism B). Threshold: `MAX_SESSION_IDLE_MS = 15*60*1000` (re-home from the module-level const at `:26` to a `thresholds` object — or leave in place and import into the method).
3. Wire schedule-on-idle call-sites:
   - Inside `queueSummarize()` fire-and-forget completion handler (around `:335` — the `.finally` branch on the generator promise): `this.scheduleAbandonedCheck(sessionDbId)`.
   - Inside the for-await iterator exit in `getMessageIterator()` consumer (around `:648`): `this.scheduleAbandonedCheck(sessionDbId)`.
4. Wire clear-on-activity call-sites:
   - Top of `initializeSession()`: if `sessions.has(id)` and `session.abandonedTimer`, `clearTimeout(session.abandonedTimer)` + `session.abandonedTimer = undefined`.
   - Inside `queueSummarize()` at entry: same clear.
   - Inside observation enqueue path (wherever `ingestObservation` bumps `lastActivity`): same clear.
5. Inside `deleteSession()`: `if (session.abandonedTimer) clearTimeout(session.abandonedTimer)`. (Prevents firing after deletion.)

(a) **Implement — Part 3 (Mechanism C: boot-once reconciliation in `worker-service.ts`)**:

In `worker-service.ts`, replace the deleted blocks at lines `537-544` (`startOrphanReaper`) and `547-589` (stale reaper + WAL + failed-purge) with the boot-once call per the Copy-ready snippet section (Mechanism C). Insertion point: immediately after the existing `resetStaleProcessingMessages(0)` at `:424`.

Move the body of `killSystemOrphans` out of the doomed `ProcessRegistry.ts` **before** Phase 2 deletes that file. Two options:
- Land Phase 3 before Phase 2 and keep a direct import until Phase 2 runs; then move the function along with `createPidCapturingSpawn` into `process-spawning.ts` and re-export. (Chosen — preserves Phase ordering.)
- Copy the body inline into `worker-service.ts` boot helper. (Fallback if circular-import issues arise.)

`supervisor.getRegistry().pruneDeadEntries()` is used directly — no new method on the supervisor, per anti-pattern guard A.

(b) **Docs**:
- 05 § 3.8 revised subgraph "Event-driven cleanup — no repeating timers" and "Worker startup — boot-once reconciliation".
- 05 Part 2 **D3** ("Zero repeating background timers").
- 05 Part 4 timer census ("Repeating background timers: 3 → 0") — revision 2026-04-22.
- 08-reconciliation.md Part 4 (revised) — zero-timer model rationale + invariants.
- V6 (register ownership), V19 (stale-reset relocation to boot-once).
- Live: `ProcessRegistry.ts:315-344, 475-486, 479-484`, `worker-service.ts:421-427, 523-532, 537-589`, `SessionManager.ts:26, 59-84, 516-568, 648-656, 651-655`, `SessionQueueProcessor.ts:6, 51-52, 62-63, 93-104`, `supervisor/process-registry.ts` (pruneDeadEntries).

(c) **Verification**:
- **Zero `setInterval` in the worker layer**:
  ```
  grep -rn "setInterval" src/services/worker/ src/services/worker-service.ts
  ```
  Expected: **0** matches. No exclusions, no parenthetical carve-outs.
- **Zero references to the deleted sweeper names**:
  ```
  grep -rn "ReaperTick\|startReaperTick\|startOrphanReaper\|staleSessionReaperInterval\|reapStaleSessions\|reapOrphanedProcesses\|killIdleDaemonChildren\|sqliteHousekeepingInterval" src/
  ```
  Expected: **0**.
- **`killSystemOrphans` is called exactly once per worker boot**:
  ```
  grep -rn "killSystemOrphans" src/
  ```
  Expected: 2 matches — the definition and a single call site inside the boot-once helper. No call site inside any handler or interval.
- **Abandoned-session timer**:
  - Unit test: initialize a session, fire-and-forget resolve its generator, advance a fake clock 15 min — assert `deleteSession` was called exactly once.
  - Unit test: initialize a session, let it go idle for 14 min, then enqueue an observation — assert `abandonedTimer` was cleared and nothing was deleted.
  - Unit test: initialize a session, idle 15 min, timer fires, but `pendingStore.getPendingCount()` returns > 0 at the moment of firing — assert timer reschedules and no delete occurs.
- **Hung-generator path**:
  - Integration test: spawn an SDK session, freeze its stream (SIGSTOP the subprocess); after 3 min the per-iterator idle timeout at `SessionQueueProcessor.ts` fires, `abortController.abort()` fires, the child exits, the `exit` handler unregisters. No background scanner involved.
- **Boot-once reconciliation**:
  - Integration test: before starting the worker, spawn a detached Claude subprocess whose ppid is `1` (simulate a crashed prior worker). Boot the worker. Within 1 s of boot completion, that process is SIGKILLed. Registry is clean.
  - Integration test: seed `pending_messages` with a row in `status='processing'` from a prior (fake-crashed) worker; boot; assert the row is reset to `status='pending'` within 1 s.
- **Subprocess crash-recovery during runtime**:
  - Integration test: while the worker is running, `kill -9` an active SDK subprocess. Within 500 ms the `exit` handler fires, `unregisterProcess` is called, pool slot is released. No timer involved.

(d) **Guards**:
- **B (no polling, no new interval)**: the definitive grep. `grep -rn "setInterval" src/services/worker/ src/services/worker-service.ts` must return **0**. Any hit is a regression — the fix is to either remove the call or convert it to an event-driven / per-session pattern.
- **A (no invented supervisor API)**: `pruneDeadEntries`, `getByPid`, `getBySession`, `getAll`, `reapSession`, `getRuntimeProcess`, `unregisterProcess`, `registerProcess` are the full public surface — any other method name in a diff is an invented API and must be reverted.
- **D (no facade-over-facade)**: the per-session abandoned-session timer lives on `ActiveSession` as a field — no new `AbandonedSessionManager` class, no `SessionTimeoutScheduler` abstraction. If a second per-session timer needs to be added later, *then* extract.
- **E (one code path per concern)**: the only subprocess-death signal at runtime is `child.on('exit')`. Do not add a second redundant signal (no `pid-alive` poller, no "heartbeat check").

### Phase 4 — Delete `staleSessionReaperInterval` + `startOrphanReaper` + periodic SQLite housekeeping (revised 2026-04-22)

(a) **Implement**:
- Delete `src/services/worker/worker-service.ts:174` field declaration (`private staleSessionReaperInterval`).
- Delete `worker-service.ts:537-544` (startOrphanReaper call + `this.stopOrphanReaper` wiring).
- Delete `worker-service.ts:547-589` (entire stale-reaper block, including its embedded `clearFailedOlderThan` and `PRAGMA wal_checkpoint(PASSIVE)` calls). **Do not** create a new `setInterval` in their place. `clearFailedOlderThan` has moved to boot-once (Phase 3 Mechanism C step 4, co-owned with plan 02). `wal_checkpoint` is deleted outright — SQLite's default `wal_autocheckpoint=1000` pages covers it (`Database.ts:162-168` sets no override; the default is active).
- Delete shutdown clauses at `worker-service.ts:1108-1110` (both `clearInterval(this.staleSessionReaperInterval)` and `this.stopOrphanReaper?.()`). The boot-once block has nothing to clear on shutdown.
- Delete `startOrphanReaper` export from `ProcessRegistry.ts` (already removed by Phase 2's file deletion).
- Delete `SessionManager.reapStaleSessions()` method entirely (`SessionManager.ts:516-568`). No stub; no replacement — both of its branches are covered by the per-iterator idle timeout (hung-generator branch) and the per-session abandoned-session timer from Phase 3 (no-generator branch).
- Keep module-level `MAX_SESSION_IDLE_MS` in `SessionManager.ts:26` — it is now consumed by `scheduleAbandonedCheck()` (Phase 3 Mechanism B). Keep `MAX_GENERATOR_IDLE_MS` at `:23` — unchanged usage by `detectStaleGenerator`.

(b) **Docs**:
- 05 § 3.8 Deleted list (`staleSessionReaperInterval`, `startOrphanReaper`, `reapStaleSessions`, periodic `clearFailedOlderThan`, periodic `wal_checkpoint`).
- 05 Part 1 items #5, #6, #7.
- 05 Part 4 timer census (revised 2026-04-22 — 3 → 0).
- 05 Part 2 **D3** (zero repeating background timers).
- 08-reconciliation.md Part 4 revised + C7 revised (no `sqliteHousekeepingInterval`).
- V6.
- Live: `worker-service.ts:174, 537, 547-589, 1108`, `SessionManager.ts:516-568`, `Database.ts:162-168` (auto-checkpoint confirmation).

(c) **Verification**:
- `grep -rn "staleSessionReaperInterval\|startOrphanReaper\|reapStaleSessions\|sqliteHousekeepingInterval" src/` → **0** (tests included).
- `grep -rn "setInterval" src/services/worker/ src/services/worker-service.ts` → **0**. No carve-outs, no exclusions. If any match appears, the fix is to delete or convert to event-driven, never to add an exclusion comment.
- `grep -rn "wal_checkpoint" src/` → 0 in `worker-service.ts`. (The `PRAGMA wal_autocheckpoint` read at boot for observability is fine if introduced by plan 02.)
- `grep -rn "clearFailedOlderThan" src/` → 2 matches: the definition in `PendingMessageStore.ts` and a single call site inside the boot-once reconciliation block.

(d) **Guards**:
- D: no "deprecated stub" left behind for `reapStaleSessions`; no shim for `startOrphanReaper`; no renamed variant of `sqliteHousekeepingInterval`.
- B: no `setInterval` added anywhere in the worker layer — the grep above is the canonical check.

### Phase 5 — Move `PendingMessageStore` 60-s reset to one-shot boot recovery

(a) **Implement**:
- In `src/services/sqlite/PendingMessageStore.ts`:
  - Delete lines `103-116` (self-heal UPDATE inside `claimNextMessage` transaction).
  - Add a new public method:
    ```ts
    recoverStuckProcessing(): number {
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing'
      `);
      const result = stmt.run();
      if (result.changes > 0) {
        logger.info('QUEUE', `BOOT_RECOVERY | recovered ${result.changes} stuck processing message(s)`);
      }
      return result.changes;
    }
    ```
  - Note the one-shot version is **unscoped by session** and **unscoped by threshold** — on boot, any `processing` row is by definition stuck (worker was not running a moment ago), so the 60-s guard is not needed. This is cleaner than copying the threshold logic.
  - Delete `STALE_PROCESSING_THRESHOLD_MS` constant (line 6) — no remaining caller.
- In `src/services/worker-service.ts`, call `pendingStore.recoverStuckProcessing()` once during boot as part of the boot-once reconciliation block (Phase 3 Mechanism C step 3), after DB initialization. (Co-owned with 02-sqlite-persistence; that plan may also call it — this plan guarantees the call exists.)

(b) **Docs**:
- 05 § 3.3 bottom box "BootOnce → Recover" (authoritative).
- 05 Part 1 item #16.
- 05 § 3.8 bottom "Worker startup → UPDATE pending_messages status processing → pending".
- 06 Phase 6 task 3.
- V19.
- Live: `src/services/sqlite/PendingMessageStore.ts:6, 99-145`.

(c) **Verification**:
- `grep -n "STALE_PROCESSING_THRESHOLD_MS" src/` → 0.
- Integration test: insert `pending_messages` row with `status='processing', started_processing_at_epoch=now-2*3600*1000`; start worker; assert row flips to `pending` before first `claimNextMessage` is called.
- Unit test: `claimNextMessage` is now a pure SELECT+UPDATE transaction; passing a row with `started_processing_at_epoch=now-10000` (stale by old threshold) is **not** reset — confirms boot-only recovery.

(d) **Guards**:
- B: `claimNextMessage` no longer mutates on read path.
- A: `recoverStuckProcessing` is a method on `PendingMessageStore`, not a new table / migration.

### Phase 6 — Inline SIGTERM → wait 5 s → SIGKILL

(a) **Implement**:
- In `SessionManager.deleteSession` (`:381-446`), replace the call at `:412` (`await ensureProcessExit(tracked, 5000)`) with the inlined ladder. 12-line block:
  ```ts
  if (tracked.process.exitCode !== null) {
    // already exited
  } else {
    const exited = new Promise<void>(resolve => tracked.process.once('exit', () => resolve()));
    const timed  = new Promise<void>(resolve => setTimeout(resolve, 5000));
    await Promise.race([exited, timed]);
    if (tracked.process.exitCode === null) {
      try { tracked.process.kill('SIGKILL'); } catch { /* dead */ }
      const killed = new Promise<void>(resolve => tracked.process.once('exit', () => resolve()));
      const killTimed = new Promise<void>(resolve => setTimeout(resolve, 1000));
      await Promise.race([killed, killTimed]);
    }
  }
  // unregister via supervisor
  for (const rec of getSupervisor().getRegistry().getByPid(tracked.pid)) {
    if (rec.type === 'sdk') getSupervisor().unregisterProcess(rec.id);
  }
  notifySlotAvailable();
  ```
- Do the same inline at `worker-service.ts:786` (other call-site).
- Delete `ensureProcessExit` (already removed with `ProcessRegistry.ts` in Phase 2; this phase also removes its re-export if any temporary shim existed).

(b) **Docs**:
- 05 Part 1 item #9 ("Keep SIGTERM → SIGKILL, delete the ladder framework — inline it").
- 05 § 3.8 Deleted list.
- 06 Phase 5 task 1 ("`ensureProcessExit` → keep as free function... Remove the ladder-framework packaging").
- Live: `ProcessRegistry.ts:185-229`, `SessionManager.ts:412`, `worker-service.ts:786`.

(c) **Verification**:
- `grep -n "ensureProcessExit" src/` → 0.
- Manual: spawn subprocess that ignores SIGTERM (`trap '' TERM; sleep 60`); call `deleteSession`; observe SIGKILL 5 s after the abort.

(d) **Guards**:
- A: no new `EscalationLadder` class, no `ProcessControl` wrapper.

### Phase 7 — Blocking `POST /api/session/end`

(a) **Implement**:
- Add new route in `src/services/worker/http/routes/SessionRoutes.ts`:
  ```ts
  app.post('/api/session/end', this.handleSessionEnd.bind(this));
  ```
- Handler body (copy and simplify from `handleSummarizeByClaudeId` at `:663-720` + the hook-side wait at `summarize.ts:117-150`):
  1. Resolve `session = sessionManager.getSession(sessionDbId)`; if missing, try to init from DB (same pattern `queueSummarize` uses at `SessionManager.ts:332-334`).
  2. `sessionManager.queueSummarize(sessionDbId, last_assistant_message)`. Also call `ensureGeneratorRunning(sessionDbId, 'summarize')` (same helper used at `SessionRoutes.ts:500, 708`).
  3. Await `session.lastSummaryStored` flag flipping (currently written by `ResponseProcessor` — see 03-response-parsing-storage). Implementation: expose an `awaitSummary(sessionDbId, timeoutMs)` helper on `SessionManager` that returns a `Promise<{ summaryId: number | null; timedOut: boolean }>`. Internally: subscribe to the existing `sessionQueues` EventEmitter for a `summary-stored` event, OR fall back to polling `session.lastSummaryStored` once per 200 ms. *Recommendation: add a `session.summaryStoredEvent = new EventEmitter()` field and have `ResponseProcessor` emit `'stored'` with the summary id; `awaitSummary` uses `events.once(emitter, 'stored')` raced against `setTimeout(110_000)`.*
  4. After the promise resolves (or times out): `session.abortController.abort()`. Wait briefly (≤1 s) for generator, then `sessionManager.deleteSession(sessionDbId)` (which runs the inline SIGTERM→SIGKILL from Phase 6 + supervisor `reapSession`).
  5. **(Preflight edit 2026-04-22 — reconciliation B2)** Return `{ summaryId, timedOut }` with **HTTP 200 on both success and timeout**. Do NOT return 504 on timeout — that status was rejected in reconciliation. Windows Terminal closes tabs only when the hook exits with code 0; hook 09 Phase 3 maps HTTP 200 → exit 0 unconditionally. If the endpoint returns any non-200, the hook must fall through to exit 1 which accumulates Windows Terminal tabs per CLAUDE.md. Contract: timeout path response is `{ summaryId: null, timedOut: true }` with status 200; success path is `{ summaryId: <number>, timedOut: false }` with status 200. Only programmer errors (400 invalid body, 404 missing session) use non-200.
6. **(Preflight edit 2026-04-22 — reconciliation C6)** Initialize `session.summaryStoredEvent = new EventEmitter()` when an `ActiveSession` is created in `SessionManager` (likely the `initializeSession` method). The emitter is consumed by `awaitSummary` above and produced by `ResponseProcessor` per plan 03 Phase 2 step 5. Field addition on `ActiveSession` shape: `summaryStoredEvent?: EventEmitter`. Use `events.once(session.summaryStoredEvent, 'stored')` raced against `setTimeout(110_000)` inside `awaitSummary`.
- Delete after hook 09 lands: `POST /api/sessions/complete` (`:753`) and `GET /api/sessions/status` consumers in hooks (the hook-side poll loop at `summarize.ts:117-150`). Keep the status endpoint for the viewer UI short-term.

(b) **Docs**:
- 05 § 3.8 `End → queueSummarize → await summary_stored OR 110s → abortController.abort → delete` (authoritative).
- 05 § 3.1 (STOP box: "BLOCKS until summary written or 110s timeout").
- 05 Part 1 item #11 ("`/api/sessions/summarize` blocks until done... Hook waits on one call").
- 05 Part 2 D6.
- Live: `src/cli/handlers/summarize.ts:25, 89, 117-150`, `src/services/worker/http/routes/SessionRoutes.ts:379-720, 747-753`, `src/services/worker/SessionManager.ts:329-377`, `src/services/worker/agents/ObservationBroadcaster.ts:43-55`.

(c) **Verification**:
- Hook-less integration test: POST `/api/session/end` with a valid sessionDbId that has queued work; response arrives only after the summary row exists in `session_summaries`; **HTTP 200** with `{ summaryId: <number>, timedOut: false }`; total latency <5 s in happy path.
- Timeout test: POST with a session whose SDK is hung; response at 110 s with **HTTP 200** and `{ summaryId: null, timedOut: true }`; subprocess is killed (verify PID gone from registry). Assert status code is 200, not 504 — this is a Windows Terminal contract gate (preflight edit B2).
- Hook 09 plan's verification runs one POST (no 500-ms loop) and asserts hook exit 0 on both the success and timeout paths.

(d) **Guards**:
- B: no 500-ms polling loop in the server handler either — use the event emitter or single 200-ms fall-back.
- D: do not keep `/api/sessions/complete` as a "safety net" — one endpoint owns session termination.
- A: do not extend `SessionRoutes` with a seventh summary endpoint; route-count goal is shrink, not grow.

### Phase 8 — Verification

(a) **Run**:
- `grep -rn "setInterval" src/services/worker/ src/services/worker-service.ts` → **0** matches. No repeating intervals in the worker layer at all.
- `wc -l src/services/worker/ProcessRegistry.ts 2>/dev/null || echo DELETED` → DELETED.
- `wc -l src/services/worker/process-spawning.ts` → ~150 LoC (contains `createPidCapturingSpawn`, `findSessionProcess`, `getActiveProcesses`, `waitForSlot`, `notifySlotAvailable`, `killSystemOrphans` as free helpers). No `reaper.ts` exists.
- Session-lifecycle total: `SessionManager.ts` (~570 after deleting `reapStaleSessions` + `detectStaleGenerator` + `MAX_GENERATOR_IDLE_MS`, adding `scheduleAbandonedCheck` + `abandonedTimer` wiring) + `process-spawning.ts` (~150) + worker-service boot-once block (~40 added, ~55 removed from the deleted stale-reaper block) + `supervisor/process-registry.ts` (unchanged 408) ≈ **~450 LoC reduction** from today's ~900 in worker-layer lifecycle code.

(b) **Regression suite**:
- Subprocess crash recovery: kill SDK subprocess → within ~500 ms the `child.on('exit')` handler fires at `process-spawning.ts` (copied from `ProcessRegistry.ts:479`) and calls `unregisterProcess(pid)`. No scanner involved.
- Hung-generator kill: SDK subprocess frozen (SIGSTOP) → after 3 min of stream silence the per-iterator idle `setTimeout` at `SessionQueueProcessor.ts:6` fires `onIdleTimeout` → `SessionManager.ts:651-655` → `abortController.abort()` → child exits → `exit` handler unregisters. No scanner involved.
- Abandoned-session cleanup: session with no generator and no pending for 15 min → the per-session `abandonedTimer` (scheduled on last-generator-completion) fires, calls `deleteSession(id)`. If new work arrived first, the timer was cleared on activity. No scanner involved.
- Cross-restart orphans: ppid=1 Claude processes from a previously crashed worker are cleaned up exactly once, at the next worker's boot, by `killSystemOrphans()` in the boot-once reconciliation block. No repeating sweep.
- PID reuse: supervisor `isPidAlive` + `verifyPidFileOwnership` (already at `supervisor/process-registry.ts:28-172`) catches PID reuse — no behavior change.
- Privacy gap closed: end-to-end test with `<private>` tag in `last_assistant_message` — not persisted to `session_summaries`.
- Blocking `/api/session/end`: one request, ≤110 s, returns summary id or null.

(c) **Doc-driven coverage check**: every item in 05 § 3.8 "Deleted" list corresponds to a Phase and a grep-based verification.

(d) **Guards audit**: no new timers, no new classes over 5 LoC, no supervisor-registry surface extension.

---

## Confidence + gaps

### High confidence

- Worker-layer `ProcessRegistry.ts` (527 LoC) is a pure facade over `supervisor/process-registry.ts`: every method body I audited (`:34-52`, `:57-65`, `:70-79`, `:85-94`, `:99-101`, `:349-382`) already delegates via `getSupervisor().getRegistry()`. Deletion is mechanical.
- `reapStaleSessions` (SessionManager.ts:516-568) has two independent branches that map cleanly onto existing mechanisms: the generator-active branch is already covered by `SessionQueueProcessor.ts:6` (per-iterator 3-min idle `setTimeout` that resets on every chunk and aborts the controller — then `child.on('exit')` unregisters); the no-generator branch is covered by the new per-session `abandonedTimer` `setTimeout` (Phase 3 Mechanism B). `detectStaleGenerator` (`:59-84`) is deleted along with `reapStaleSessions` — the per-iterator timer at the stream level is the single source of truth for "silent generator."
- Supervisor `reapSession` (`supervisor/process-registry.ts:292-385`) already implements SIGTERM → 5 s → SIGKILL; the worker-layer `ensureProcessExit` (`ProcessRegistry.ts:185-229`) duplicates this for the ChildProcess reference. Inlining the worker version keeps per-process escalation while supervisor-level reap handles the session-wide sweep on `deleteSession`.
- Cadence math: 30 s tick × 4 = 2 min matches the current `staleSessionReaperInterval` cadence at `worker-service.ts:589`. Zero timing regression.

### Gaps / open integration points

1. **`summary_stored` wiring (Phase 7)** — the cleanest implementation needs `ResponseProcessor` (03-response-parsing-storage) to emit a per-session event on successful summary write. Today `session.lastSummaryStored` is written (referenced at `SessionRoutes.ts:747`) but there is no event — only a polled read. **Blocking coordinate point: 09-lifecycle-hooks cannot simplify its hook until Phase 7 is wired, and Phase 7 cannot wire `awaitSummary` cleanly until 03 exposes an emitter.** Concrete ask from 03: add `session.summaryStoredEvent = new EventEmitter()` populated inside `ResponseProcessor` after the commit (approx. location: `src/services/worker/agents/ResponseProcessor.ts:228` region where `broadcastSummary` is already called). Fallback if 03 can't accommodate: Phase 7 polls `session.lastSummaryStored` at 200 ms with the 110 s timeout — still one HTTP call from the hook's perspective, still blocking server-side, just internally polled. Degrades cleanly.
2. **SQLite housekeeping in `worker-service.ts:547-589`** (resolved 2026-04-22) — the stale-reaper block today also runs `clearFailedOlderThan(1h)` and `PRAGMA wal_checkpoint`. Under the zero-timer model: `clearFailedOlderThan` moves to boot-once (co-owned with plan 02's boot-once SQLite housekeeping phase); `wal_checkpoint` explicit calls are deleted outright because `Database.ts:162-168` sets no `wal_autocheckpoint` override, so SQLite's default of 1000 pages is the active policy. This plan's Phase 4 deletes all three items together — no transient "two `setInterval` hits" in the diff.
