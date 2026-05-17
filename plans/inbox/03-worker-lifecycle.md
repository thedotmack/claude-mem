# Plan 03 — Worker / Daemon Lifecycle Hardening

> **Scope**: Fix accumulated worker / daemon lifecycle bugs in claude-mem.
> Address DB bloat, chroma-mcp leaks, retry storms, port/PID races, queue zombies, missing supervision, and observability gaps.
>
> **Non-implementation**: This document is a plan. Each phase is self-contained; an executing agent should be able to run a single phase without re-discovering context.
>
> **Audience**: Subsequent agents executing one phase per session.

---

## Phase 0 — Documentation Discovery & Allowed APIs

**Goal**: Anchor every implementation phase in real APIs that exist in the current codebase or in vetted libraries. Prevent phantom-method invention.

### 0.1 Read these files end-to-end before touching code

| File | Why |
| --- | --- |
| `CLAUDE.md` (project root) | Architecture, exit-code strategy, Pro/OSS boundary, settings conventions |
| `src/services/worker-service.ts` | `WorkerService` class, `--daemon` `main()`, signal registration, all CLI subcommands |
| `src/services/worker-spawner.ts` | `ensureWorkerStarted` 3-state machine (`ready`/`warming`/`dead`) |
| `src/services/infrastructure/ProcessManager.ts` | `spawnDaemon`, PID file ops, `captureProcessStartToken`, `isProcessAlive` |
| `src/services/infrastructure/HealthMonitor.ts` | `isPortInUse`, `waitForHealth`, `waitForReadiness`, `httpShutdown` |
| `src/services/infrastructure/GracefulShutdown.ts` | `performGracefulShutdown` ordering |
| `src/services/infrastructure/CleanupV12_4_3.ts` | `runOneTimeV12_4_3Cleanup`, `STUCK_PENDING_THRESHOLD = 10`, observer-purge SQL |
| `src/services/sync/ChromaMcpManager.ts` | `ensureConnected`, `connectInternal`, `stop`, `killProcessTree`, `collectDescendantPids`, `RECONNECT_BACKOFF_MS = 10_000`, `MCP_CONNECTION_TIMEOUT_MS = 30_000` |
| `src/supervisor/index.ts` | `Supervisor` class, `validateWorkerPidFile`, signal-handler config |
| `src/supervisor/process-registry.ts` | `ProcessRegistry`, `getSdkProcessForSession`, `ensureSdkProcessExit`, `waitForSlot`, `TOTAL_PROCESS_HARD_CAP = 10` |
| `src/supervisor/health-checker.ts` | 30s `pruneDeadEntries` loop (already present — extend, don't replace) |
| `src/supervisor/shutdown.ts` | `runShutdownCascade`, `signalProcess`, `loadTreeKill` |
| `src/services/worker/SessionManager.ts` | In-memory session map, `deleteSession`, queue/pending integration |
| `src/services/worker/RestartGuard.ts` | Per-session restart cap (10/60s window, 5 consecutive) |
| `src/services/worker/retry.ts` | Provider-level retry (`withRetry`, classified errors) — DO NOT mutate; circuit breaker layers ABOVE this |
| `src/shared/worker-utils.ts` | `recordWorkerUnreachable` (line 401), `executeWithWorkerFallback` (line 443), fail-loud counter file at `~/.claude-mem/state/hook-failures.json` |
| `src/services/sqlite/Database.ts` | PRAGMA setup (lines 27-32, 69-74) — single source of truth for DB pragmas |
| `src/services/server/Server.ts` | `/api/health` (line 161), `/api/readiness` (line 178), `/api/version` (line 192) |
| `src/shared/SettingsDefaultsManager.ts` | Where every new setting key MUST be declared with a default |
| `src/shared/hook-constants.ts` | `HOOK_TIMEOUTS`, `HOOK_EXIT_CODES` — extend here, don't inline |
| `plugin/bun-runner.js`, `plugin/scripts/worker-service.cjs` | Built worker entrypoint — note the build pipeline (`scripts/build-hooks.js`) |

### 0.2 Allowed APIs (use these, do NOT invent siblings)

**SQLite (bun:sqlite)** — pragma calls are `db.run('PRAGMA …')` or `db.prepare('PRAGMA …').get()`. Existing pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=memory`, `mmap_size`, `cache_size`. **VACUUM** runs only outside a transaction. `VACUUM INTO 'path'` is the backup form already used in `CleanupV12_4_3.ts:135`. `wal_checkpoint(TRUNCATE)` is the truncating-checkpoint form.

**Process supervision** — `getSupervisor()`, `getProcessRegistry()`, `registerProcess(id, info, processRef?)`, `unregisterProcess(id)`, `pruneDeadEntries()`, `assertCanSpawn(type)`, `runShutdownCascade(...)`. Tree-kill on POSIX uses `pgrep -P` recursion + `process.kill(-pgid, signal)`; on Windows uses `taskkill /T /F /PID` or `tree-kill` npm.

**HTTP/Express** — `Server.app.get('/api/...', handler)` via `registerRoutes` (handlers implement `setupRoutes(app)` on a `RouteHandler` interface). Every new endpoint must follow the existing `RouteHandler` pattern under `src/services/worker/http/routes/`.

**Settings** — `SettingsDefaultsManager.get('CLAUDE_MEM_…')`, `SettingsDefaultsManager.loadFromFile(path)`. New keys require: (a) type added to the interface in `SettingsDefaultsManager.ts`, (b) default value declared in the same file, (c) documented in CLAUDE.md if user-tunable.

**Logging** — `logger.info(category, msg, fields)`, `logger.warn`, `logger.error(category, msg, fields, error)`. Categories used here: `SYSTEM`, `WORKER`, `SESSION`, `CHROMA_MCP`, `SDK`, `DB`, `QUEUE`, `PROCESS`. Add new category `MAINTENANCE` for VACUUM / reaper events.

### 0.3 Anti-patterns — explicitly forbidden

- **Do not** add a new singleton supervisor — extend `getSupervisor()`.
- **Do not** spawn child processes without going through `getSupervisor().assertCanSpawn(...)` and `registerProcess(...)`.
- **Do not** call `process.exit(1)` on hook-side error paths — it accumulates Windows Terminal tabs (CLAUDE.md exit-code strategy). Use `0` for graceful, `2` only for blocking-error paths that need to surface stderr to Claude.
- **Do not** delete `sdk_sessions` rows if `observations` or `session_summaries` still reference their `memory_session_id` without an explicit user-opt-in flag.
- **Do not** hold a SQLite write lock during `VACUUM` while ingestion is hot. Pause queue processing first.
- **Do not** introduce setInterval timers that keep the event loop alive — every new timer must call `.unref()`.
- **Do not** invent settings keys — declare them in `SettingsDefaultsManager.ts` first.

### 0.4 Confidence note

Confidence: HIGH on file/API inventory (read-pass complete on all referenced files). MEDIUM on Windows behavior of new advisory locks (Windows mandatory locking via `lockf` is bun-runtime-dependent — verify via spike before committing).

---

## Phase 1 — Inventory & Instrumentation (read-only, safe)

**Goal**: Produce a written state-machine diagram and an exit-site catalog that subsequent phases reference. No code changes; create a scratch document at `docs/internal/worker-lifecycle-state-machine.md` if the executor wants an artifact, otherwise capture findings in commit messages.

### 1.1 Tasks

1. **Trace the worker daemon spawn → terminate path** end-to-end. Source order:
   - Hook entry → `src/shared/worker-utils.ts:ensureWorkerRunning` (lazy spawn) OR `src/services/worker-spawner.ts:ensureWorkerStarted` (explicit)
   - `spawnDaemon` (`src/services/infrastructure/ProcessManager.ts:408`) — POSIX uses `setsid` if available, Windows uses `Start-Process -WindowStyle Hidden`
   - `--daemon` branch in `src/services/worker-service.ts:937` — duplicate-PID/duplicate-port guard
   - `WorkerService.start()` (line 258) → `startSupervisor()` → `server.listen()` → `writePidFile()` → `getSupervisor().registerProcess('worker', ...)` → `initializeBackground()`
   - Signal handlers via `configureSupervisorSignalHandlers` (`src/supervisor/index.ts:49`) — SIGTERM/SIGINT; SIGHUP ignored in `--daemon` mode on POSIX
   - Shutdown: `WorkerService.shutdown()` → `performGracefulShutdown` → server close → `sessionManager.shutdownAll()` → mcp client close → chroma stop → db close → `getSupervisor().stop()` → `runShutdownCascade` → PID file unlink

2. **Catalog every `process.exit(...)` site** in worker-service.ts (already mapped — 21 sites; lines 764, 772, 794, 804, 810, 813, 828, 835, 842, 853, 870, 878, 888, 895, 916, 933, 945, 950, 971, 975, 991). Annotate each with: code, intent, whether it leaks the worker on the same path, whether shutdown ran first.

3. **Catalog every retry / unreachable site**:
   - `src/shared/worker-utils.ts:401 recordWorkerUnreachable` (the #1874 counter)
   - `src/cli/handlers/{context,file-context,file-edit,summarize,observation,user-message,session-init}.ts` — every `executeWithWorkerFallback` caller
   - `src/servers/mcp-server.ts:72,100,145` — direct `workerHttpRequest`
   - `src/services/transcripts/processor.ts:331,371,373` — direct `workerHttpRequest`
   - `src/services/integrations/CursorHooksInstaller.ts:64,349,352` — direct `workerHttpRequest`
   - `src/utils/claude-md-utils.ts:305` — direct `workerHttpRequest`

4. **Catalog every spawn site**:
   - `spawnDaemon` (worker self-spawn)
   - `ChromaMcpManager.connectInternal` (chroma-mcp via uvx → uv → python → chroma-mcp)
   - `spawnSdkProcess` (`src/supervisor/process-registry.ts:532`) — Claude SDK subprocesses
   - `runMcpSelfCheck` (`src/services/worker-service.ts:405`) — MCP loopback probe via `process.execPath`
   - Any `execSync` / `execFile` / `spawnSync` in `ChromaMcpManager` (cert resolution) or `ProcessManager` (binary lookup, cwd-remap)

### 1.2 Acceptance criteria

- Markdown table written (commit message or scratch doc) listing every spawn and exit site with file:line.
- A 1-paragraph English description of the worker state machine (states + transitions) suitable to paste into PR descriptions.
- Confirmed list of which `executeWithWorkerFallback` callers run inside hooks (Claude Code's strict timeout window) vs. inside the worker (no timeout pressure) — this drives Phase 4 circuit-breaker scoping.

### 1.3 Verification

- `grep -rn "process.exit" src/ --include="*.ts" | wc -l` matches the catalog.
- `grep -rn "executeWithWorkerFallback\|workerHttpRequest" src/ --include="*.ts" | grep -v worker-utils.ts | wc -l` matches the catalog.

### 1.4 Deliverable

Hand-off note for Phase 2-8 executors with file/line anchors; no code committed.

---

## Phase 5 — PID/Port Reclamation & Race-Free Startup

> Shipping order: **Phase 5 first** (per Phase 8 ordering). Idempotent and safe.

**Goal**: Eliminate the silent-exit-0 case where a fresh `--daemon` spawn loses the port race; harden cross-platform PID-reuse detection; serialize concurrent spawns with an OS-level advisory lock.

### 5.1 Files to modify

| File | Change |
| --- | --- |
| `src/supervisor/process-registry.ts` | Extend `captureProcessStartToken` for macOS (already partial via `ps -o lstart`) and Windows (`wmic process where ProcessId=X get CreationDate /value`). Add unit test for each platform branch. |
| `src/supervisor/index.ts:validateWorkerPidFile` | Add port-on-pid match check — if `pidInfo.port !== currentExpectedPort`, treat as `'stale'`. |
| `src/services/infrastructure/ProcessManager.ts` | Add new exports: `acquireDaemonLock()` / `releaseDaemonLock()` using POSIX `flock` (via `fcntl`/`flock` syscall through `bun:ffi` or shelling to `flock(1)` on Linux only) and Windows mandatory file lock via `LockFile` (or fall back to atomic-rename sentinel on Windows). |
| `src/services/worker-service.ts:937` (`--daemon` branch) | Wrap startup in `acquireDaemonLock()`. If port is in use, perform a `/api/version` probe; if the listener returns OUR `BUILT_IN_VERSION` → exit 0 (legit duplicate); if it returns a different version → log a warning and exit 0 (stale worker, will be restarted by version-mismatch path); if the listener doesn't respond → wait `HOOK_TIMEOUTS.PORT_IN_USE_WAIT` then write a clear stderr line with diagnostic before exiting. |
| `src/services/worker-spawner.ts` | Same lock acquisition before `spawnDaemon`. Release on success or error. |

### 5.2 Detailed tasks

1. **macOS start-time token**: extend `captureProcessStartToken` (registry line 56). On Darwin, prefer `ps -p <pid> -o lstart=` (already in fallback path). Verify with `LC_ALL=C LANG=C` env so locale doesn't change the timestamp format. Add a comment explaining that `ps lstart` resolution is 1-second — collisions still possible but vastly less likely than no-token.

2. **Windows start-time token**: add a Win32 branch using `wmic process where ProcessId=<pid> get CreationDate /value`. Parse the `CreationDate=YYYYMMDDHHMMSS.ffffff+TZ` line. Cache the wmic resolution per-pid for 5s (avoid re-shelling on repeat checks).

3. **Port-on-pid match**: in `validateWorkerPidFile`, after confirming `isPidAlive(pidInfo.pid)`, verify the recorded `pidInfo.port` is reachable via `isPortInUse(pidInfo.port)` AND the listener's `/api/version` returns a version string. If port is dead but PID alive → return `'stale'` (worker crashed mid-listen, PID about to be reused).

4. **Advisory lock**:
   - POSIX: open `<DATA_DIR>/.worker-spawn.lock` with `O_RDWR | O_CREAT`, `flock(fd, LOCK_EX | LOCK_NB)`. On EAGAIN, log `Another spawn in progress, waiting up to 5s` and retry with `LOCK_EX` (blocking) under a `setTimeout` race. Implement via `bun:ffi` for POSIX `flock(2)` if available, otherwise shell `flock -n -x <path> <command>`. **Spike first**: confirm bun's `bun:ffi` exposes `flock`. If not, use a watch-and-rename sentinel (less ideal but works).
   - Windows: Use `LockFile` via Win32 API or fall back to atomic `mkdirSync` of `<DATA_DIR>/.worker-spawn.lock.dir` (fails if exists) with stale-timeout cleanup at 30s.

5. **Diagnostic stderr**: when port-in-use without our worker responding, write to stderr (and log INFO) with: `claude-mem worker port <N> in use by an unidentified process; not spawning duplicate`. This must NOT block the hook — exit 0 still per CLAUDE.md.

### 5.3 New settings

| Key | Default | Range | Purpose |
| --- | --- | --- | --- |
| `CLAUDE_MEM_DAEMON_LOCK_TIMEOUT_MS` | `5000` | 0–60000 | Max wait for the spawn lock |
| `CLAUDE_MEM_PID_PORT_RECHECK_MS` | `2000` | 500–30000 | Wait window before treating port-in-use without `/api/version` response as "unknown listener" |

### 5.4 Acceptance criteria

- Run two `claude-mem start` commands in parallel → exactly one daemon ends up alive; the other exits cleanly with a log line referencing the lock.
- Kill the worker `-9` (skip cleanup), reuse the PID with `python -c 'import time; time.sleep(60)'` → `validateWorkerPidFile` returns `'stale'` and removes the file.
- On macOS, run worker, capture token, kill, spawn unrelated process with same PID, spawn worker again → token mismatch detected; old PID file ignored.
- `/api/version` probe path: spawn a fake server on the worker port → daemon exits 0 with the new diagnostic stderr, NOT silently.

### 5.5 Observability hooks

- Log `SYSTEM` INFO `Daemon spawn lock acquired` on success.
- Log `SYSTEM` WARN `Daemon spawn lock contention`, fields `{waitedMs}`.
- Log `SYSTEM` WARN `Worker port occupied by foreign listener`, fields `{port, probeStatus}`.
- New `/api/healthz` fields (added in Phase 7): `pid_file_path`, `pid_start_token`, `daemon_lock_held: bool`.

### 5.6 Verification checklist

- [ ] `grep "process.exit(0)" src/services/worker-service.ts` — count unchanged (no new silent exits introduced).
- [ ] Manual two-process race test (Linux + macOS + Windows VM).
- [ ] Existing health-check tests still pass.
- [ ] No new always-on `setInterval` introduced.

---

## Phase 6 — DB Maintenance (VACUUM / WAL)

> Ships alongside Phase 5 (idempotent).

**Goal**: Recover the 504 MB of free pages, prevent recurrence, surface DB-size metrics.

### 6.1 Files to modify

| File | Change |
| --- | --- |
| `src/services/sqlite/Database.ts:27-32` and `:69-74` | Add `PRAGMA auto_vacuum = INCREMENTAL` BEFORE the first table is created (only takes effect on a fresh DB; harmless on existing DBs but logs a no-op). For existing DBs, the migration path is the one-shot Phase-6 startup VACUUM. |
| `src/services/maintenance/DbMaintenance.ts` (new) | Periodic maintenance task: on a 24h timer (configurable), call `PRAGMA incremental_vacuum`, `PRAGMA wal_checkpoint(TRUNCATE)`, then collect metrics (`page_count`, `freelist_count`, file size). Emit `MAINTENANCE` INFO log. Acquire `dbMaintenanceMutex` so other writers wait. |
| `src/services/maintenance/DbMaintenance.ts` | Startup check: if `freelist_count / page_count > FREE_RATIO_VACUUM_THRESHOLD` (default 0.40), perform full `VACUUM` after `VACUUM INTO` backup to `<DATA_DIR>/backups/claude-mem-pre-vacuum-<ts>.db`. Pause queue processor first. |
| `src/services/worker-service.ts:initializeBackground` | Wire the maintenance task — start after `dbManager.initialize()`. Timer must `.unref()`. |
| `src/services/worker/SessionManager.ts` | Expose `pauseQueueProcessing(): Promise<void>` and `resumeQueueProcessing(): void`. Use the existing AbortController + emitter to drain in-flight work; don't introduce new state. Maintenance acquires; readers continue (WAL allows them). |
| `src/services/infrastructure/CleanupV12_4_3.ts:135` | Reuse the existing `VACUUM INTO` backup pattern verbatim — copy the disk-space pre-flight check (`statfsSync`, line 115). |

### 6.2 Detailed tasks

1. **Auto-vacuum on new DBs**: Add `PRAGMA auto_vacuum = INCREMENTAL` in `Database.ts` BEFORE `migrationRunner.runAllMigrations()`. Verify with a comment that this is no-op on existing DBs (sqlite docs say a full VACUUM is required to flip auto_vacuum mode after tables exist). Document the migration path: existing users get the freed-page reclamation via the startup full VACUUM in step 3.

2. **Periodic incremental vacuum + WAL checkpoint**:
   - Schedule via `setInterval` with `.unref()`. Default cadence: 24h. Setting: `CLAUDE_MEM_DB_MAINTENANCE_INTERVAL_HOURS` (default `24`, min `1`, max `168`).
   - Each tick: acquire mutex → `db.run('PRAGMA incremental_vacuum')` → `db.run('PRAGMA wal_checkpoint(TRUNCATE)')` → snapshot metrics → release.
   - Skip the tick if a `VACUUM` is in progress.

3. **Startup full VACUUM (one-shot per session) when free-ratio is high**:
   - Read `page_count` (`PRAGMA page_count`) and `freelist_count` (`PRAGMA freelist_count`).
   - If `freelist_count / page_count >= CLAUDE_MEM_DB_VACUUM_THRESHOLD_RATIO` (default `0.40`), schedule a deferred VACUUM (5 minutes after worker becomes ready) to avoid slowing startup.
   - VACUUM steps: pause queue → `VACUUM INTO '<backup>'` → verify backup → `VACUUM` (full) → resume queue → log freed pages and ms taken.
   - Disk-space pre-flight: `statfsSync` (mirror `CleanupV12_4_3.ts:115`). Skip if free space < `1.2 * dbSize + 100MB`. Log `MAINTENANCE` ERROR in that case so the user sees actionable info.

4. **Pause/resume hook in SessionManager**: The existing `for await ... of getMessageIterator()` loop in queue processor needs a "pause" semaphore. Implementation: add a `Promise<void>` gate that the iterator awaits before yielding. Maintenance flips it to a pending promise during VACUUM; resolve to release. **Do not** abort in-flight messages — they can complete; new messages wait.

5. **Cleanup-V12.4.3 regression detection**: Re-scan `sdk_sessions WHERE project = OBSERVER_SESSIONS_PROJECT` and `pending_messages` matching the stuck-pending pattern at maintenance ticks. If any match AND the marker exists, log `MAINTENANCE` WARN and re-run the purge (idempotent). Setting: `CLAUDE_MEM_CLEANUP_REGRESSION_CHECK = true`.

### 6.3 New settings

| Key | Default | Range | Purpose |
| --- | --- | --- | --- |
| `CLAUDE_MEM_DB_MAINTENANCE_ENABLED` | `true` | bool | Master kill-switch |
| `CLAUDE_MEM_DB_MAINTENANCE_INTERVAL_HOURS` | `24` | 1–168 | Periodic cadence |
| `CLAUDE_MEM_DB_VACUUM_THRESHOLD_RATIO` | `0.40` | 0.05–0.95 | Free-ratio above which we auto-VACUUM at startup |
| `CLAUDE_MEM_DB_VACUUM_STARTUP_DELAY_MS` | `300000` (5 min) | 0–3600000 | Defer startup VACUUM so it doesn't block readiness |
| `CLAUDE_MEM_CLEANUP_REGRESSION_CHECK` | `true` | bool | Re-scan v12.4.3-shaped pollution |

### 6.4 Acceptance criteria

- Reproduce the bloat scenario: stuff `pending_messages` with 100k stuck `processing` rows, run worker → startup VACUUM fires within 5 min after readiness, freed-pages log line appears, file size drops.
- Existing 532 MB DBs reclaim ≥ 95% of free pages on first run (matches the 28 MB target observed manually).
- Hot-ingestion test: enqueue 1000 observations during a maintenance tick → no `SQLITE_BUSY` or `database is locked` errors; queue resumes after VACUUM.
- `PRAGMA auto_vacuum` returns `2` (incremental) on freshly-created DBs.
- Maintenance loop ticks honor `.unref()` — `process.exit(0)` from a clean shutdown returns immediately, not after the 24h interval.

### 6.5 Observability hooks

- New log category: `MAINTENANCE`.
- Events: `MaintenanceStart`, `MaintenanceTick`, `VacuumStart`, `VacuumComplete` (`{freedPages, ms, dbSizeBeforeMb, dbSizeAfterMb}`), `VacuumSkippedLowDisk`, `RegressionDetected`, `MaintenanceComplete`.
- `/api/healthz` fields (Phase 7): `db_page_count`, `db_freelist_count`, `db_free_ratio_pct`, `db_size_bytes`, `db_last_vacuum_at`, `db_last_vacuum_freed_pages`, `db_last_maintenance_at`.

### 6.6 Anti-pattern guards

- **Do not** call `VACUUM` inside a transaction (sqlite errors).
- **Do not** hold the queue pause across the `VACUUM INTO` backup phase — only the final full `VACUUM` needs the writer-lock window. (`VACUUM INTO` works on a read-only snapshot.)
- **Do not** call `PRAGMA wal_checkpoint(FULL)` — TRUNCATE is required to actually shrink the WAL file.

### 6.7 Verification checklist

- [ ] Backup created at `<DATA_DIR>/backups/` before every full VACUUM.
- [ ] Maintenance timer registered with `.unref()` (grep for `setInterval` in the new file → `unref()` follows each).
- [ ] No new direct `setInterval` outside the maintenance file.
- [ ] PRAGMA list in `Database.ts` extended with `auto_vacuum` and includes a comment about migration.

---

## Phase 2 — Stuck-Session Reaper (fix v12.4.3 bloat)

**Goal**: Stop `pending_messages` and `sdk_sessions` from accumulating zombies.

### 2.1 Files to modify

| File | Change |
| --- | --- |
| `src/services/maintenance/SessionReaper.ts` (new) | Periodic reaper. Plugs into the supervisor's existing `health-checker.ts` 30s tick (extend, do not replace). |
| `src/supervisor/health-checker.ts:9 runHealthCheck` | Call `SessionReaper.tick()` after `pruneDeadEntries()`. |
| `src/services/worker/SessionManager.ts:deleteSession` | After in-memory delete, call `pendingStore.clearPendingForSession(sessionDbId)` synchronously (it already does this via `clearPendingForSession` on a separate path — verify and unify). |
| `src/services/sqlite/PendingMessageStore.ts` | Add `reapStuckProcessing(olderThanMs: number): number` returning the count of rows reset to `pending`. |
| `src/services/sqlite/SessionStore.ts` | Add `findInactiveSdkSessions(olderThanDays: number): Array<{id, project, contentSessionId, memorySessionId, lastActivityAt}>`. |
| `src/services/sqlite/SessionStore.ts` | Add `markSdkSessionInactive(id: number)` — adds an `inactive_at` column or sets a sentinel. |
| `src/services/sqlite/migrations/runner.ts` | New migration: add `inactive_at TEXT NULL` to `sdk_sessions` if absent. |

### 2.2 Reaper logic

Per tick (default 30s, gated by `CLAUDE_MEM_REAPER_ENABLED`):

1. **Stuck-processing sweep**: `UPDATE pending_messages SET status='pending' WHERE status='processing' AND updated_at < <now - PROCESSING_STUCK_MS>` (default 5 minutes). Log count if > 0.

2. **Orphan-pending sweep**: `DELETE FROM pending_messages WHERE session_db_id NOT IN (SELECT id FROM sdk_sessions)` (defensive — should already be FK-protected but log if any deleted).

3. **Inactive-session detection** (does NOT delete):
   - SELECT sdk_sessions where `id NOT IN <in-memory session ids>` AND `last_activity > N days ago` (computed from MAX of related observations / pending_messages / session_summaries timestamps).
   - For each: `UPDATE sdk_sessions SET inactive_at = <now> WHERE id = ? AND inactive_at IS NULL`.

4. **Observer-pollution regression check** (matches Phase 6 task 5):
   - If `OBSERVER_SESSIONS_PROJECT` rows reappear after the v12.4.3 marker is present, re-run the purge SQL from `CleanupV12_4_3.runObserverSessionsPurge` (lines 196-218).
   - Log `MAINTENANCE` WARN with counts.

5. **Hard delete is opt-in** via `CLAUDE_MEM_REAPER_HARD_DELETE_INACTIVE_DAYS` (default `0` = disabled; nonzero = days threshold). When enabled and a session has `inactive_at` older than the threshold AND no FK-referencing rows, hard-delete the session row. Default-off because user data safety > disk space.

### 2.3 New settings

| Key | Default | Range | Purpose |
| --- | --- | --- | --- |
| `CLAUDE_MEM_REAPER_ENABLED` | `true` | bool | Master switch |
| `CLAUDE_MEM_REAPER_TICK_MS` | `30000` | 5000–600000 | Tick cadence (piggy-backs supervisor; this value gates whether the reaper runs each tick) |
| `CLAUDE_MEM_REAPER_PROCESSING_STUCK_MS` | `300000` (5 min) | 30000–86400000 | Threshold for a `processing` row to be considered stuck |
| `CLAUDE_MEM_REAPER_INACTIVE_DAYS` | `30` | 1–365 | When to mark a session `inactive_at` |
| `CLAUDE_MEM_REAPER_HARD_DELETE_INACTIVE_DAYS` | `0` | 0–365 | 0 = never; otherwise, hard-delete inactive rows older than N days |

### 2.4 Acceptance criteria

- Inject 50 stuck `processing` rows older than 5 minutes → next reaper tick resets them → `/api/healthz` shows `oldest_pending_processing_age_sec` drop to 0.
- Inject `OBSERVER_SESSIONS_PROJECT` rows post-marker → next tick logs regression and purges them.
- Reaper survives a worker restart without losing state (everything is DB-backed).
- Active sessions (in-memory) are NEVER marked inactive even if their last DB write is old (in-memory presence wins).

### 2.5 Observability

- Log: `MAINTENANCE` INFO `ReaperTick`, fields `{stuckProcessing, orphanPending, markedInactive, hardDeleted, observerRegression}`.
- New `/api/healthz` fields (Phase 7): `oldest_processing_pending_age_sec`, `processing_pending_count`, `pending_count_total`, `sdk_sessions_total`, `sdk_sessions_inactive`, `sdk_sessions_by_project: { [project]: count }`.

### 2.6 Verification checklist

- [ ] Migration adds `inactive_at` column without breaking existing data (test on a copy of a real DB).
- [ ] In-memory active sessions never appear in `findInactiveSdkSessions`.
- [ ] Reaper does NOT cascade-delete `observations` / `session_summaries` unless explicit hard-delete + zero-FK-reference precondition.
- [ ] `/api/healthz` shows reaper metrics.

---

## Phase 3 — chroma-mcp Child-Process Supervisor

**Goal**: Stop the 23-concurrent-chroma-mcp leak. Bound concurrency, reap idle, scan for orphans at startup.

### 3.1 Files to modify

| File | Change |
| --- | --- |
| `src/services/sync/ChromaMcpManager.ts` | Add idle reaper; enforce single-instance via supervisor registry; add startup orphan scan; add `lastCallAt` timestamp updated by `callTool`. |
| `src/services/sync/ChromaMcpManager.ts:ensureConnected` (line 43) | Before connect, check `getProcessRegistry().getAll().filter(r => r.type === 'chroma')` — if non-empty AND PID alive AND PID not the current `_process.pid`, refuse to spawn (alert + reuse existing if possible; otherwise wait for backoff). |
| `src/services/sync/ChromaMcpManager.ts:registerManagedProcess` (line 613) | Already calls `getSupervisor().registerProcess(CHROMA_SUPERVISOR_ID, ...)` — verify the supervisor enforces single-instance for this id. (Currently `register` is keyed by id so same id replaces; document this.) |
| `src/supervisor/process-registry.ts` | Add `getActiveCountByType(type: string): number`. Add `findChromaOrphans(): Promise<number[]>` — POSIX `pgrep -af 'chroma-mcp'` filtered by PPID == 1. |
| `src/services/worker-service.ts:initializeBackground` | After `ChromaMcpManager.getInstance()`, kick off `await ChromaMcpManager.scanAndReapOrphans()` (best-effort; never throws). |

### 3.2 Detailed tasks

1. **Startup orphan scan**: New static method `ChromaMcpManager.scanAndReapOrphans()`:
   - POSIX: `pgrep -af 'chroma-mcp'` → for each PID, check PPID. If PPID == 1 (re-parented to init), call `killProcessTree(pid)` (existing function at line 388). Log `CHROMA_MCP` INFO `ReapedOrphan`, fields `{pid, ageSec}`.
   - Windows: `Get-CimInstance Win32_Process -Filter "Name='chroma-mcp.exe'"` filter by parent process state, kill with taskkill.
   - Bound the scan to processes whose command-line includes `chroma-mcp==<CHROMA_MCP_PINNED_VERSION>` to avoid killing unrelated chroma installations.

2. **Idle reaper**: Add `lastCallAt: number = 0` field to `ChromaMcpManager`. Update on every `callTool`. Run a `setInterval(checkIdle, 60_000)` (`.unref()`) — if `connected && Date.now() - lastCallAt > CHROMA_MCP_IDLE_SHUTDOWN_MS` (default 15 min), call `await this.stop()`. Lazy-reconnect resumes on next `callTool`.

3. **Single-instance guard on reconnect**: In `ensureConnected`, before `connectInternal`, call `getProcessRegistry().getActiveCountByType('chroma')`. If > 0 AND the registered PID is alive but `this.connected === false`, this is a stale process (we lost track). Tear it down via `killProcessTree(registeredPid)` first, then proceed with fresh spawn. Otherwise the count grows by one each reconnect — exactly the leak observed.

4. **Hard cap**: extend `getSupervisor().assertCanSpawn('chroma mcp')` (already called at line 87) to actually count and reject. Cap = 1 chroma-mcp per worker. Cap = `TOTAL_PROCESS_HARD_CAP` (10) overall — already enforced for SDK processes; extend to chroma-mcp.

5. **Tighten close path**: in `connectInternal` (line 74), after `transport.close()` / `client.close()`, if the underlying `_process.pid` is still in the registry, call `killProcessTree` and `unregisterProcess` explicitly. Don't rely on `transport.onclose` alone — it has the stale-callback guard but doesn't always fire on connect-time failures.

### 3.3 New settings

| Key | Default | Range | Purpose |
| --- | --- | --- | --- |
| `CLAUDE_MEM_CHROMA_IDLE_SHUTDOWN_MS` | `900000` (15 min) | 60000–86400000 | Idle reaper threshold |
| `CLAUDE_MEM_CHROMA_ORPHAN_SCAN_ON_START` | `true` | bool | Master switch for startup scan |
| `CLAUDE_MEM_CHROMA_MAX_CONCURRENT` | `1` | 1–4 | Cap chroma-mcp instances per worker |

### 3.4 Acceptance criteria

- Spawn 5 chroma-mcp processes manually parented to init; restart worker → all 5 are reaped at startup.
- Force connect-time failure (kill transport mid-connect) 10 times → registry count never exceeds 1.
- Run worker for 30 min with no chroma calls → process is reaped after 15 min and `getProcessRegistry().getActiveCountByType('chroma')` returns 0.
- `callTool` after idle-shutdown lazy-reconnects successfully.

### 3.5 Observability

- Log: `CHROMA_MCP` INFO `OrphanScan` `{found, killed}`.
- Log: `CHROMA_MCP` INFO `IdleShutdown` `{idleMs}`.
- Log: `CHROMA_MCP` WARN `RegistryStale` when single-instance guard tears down a phantom.
- `/api/healthz` fields (Phase 7): `chroma_mcp_pid_count`, `chroma_mcp_last_call_at`, `chroma_mcp_state` ('connected'|'disconnected'|'backoff'), `chroma_mcp_backoff_remaining_ms`.

### 3.6 Anti-pattern guards

- **Do not** kill chroma processes whose command-line doesn't match `chroma-mcp==<PINNED_VERSION>` — could match unrelated user installs.
- **Do not** spin up the idle-reaper timer if `chromaMcpManager` is null (chroma disabled via `CLAUDE_MEM_CHROMA_ENABLED=false`).
- **Do not** call `getProcessRegistry()` from outside the worker process — it's worker-internal.

### 3.7 Verification checklist

- [ ] After 2.5 hours of normal use, `ps aux | grep chroma-mcp | wc -l` ≤ 1.
- [ ] Idle-reaper timer is `.unref()`d.
- [ ] Orphan scan tolerates `pgrep` returning empty (no false-error logs).
- [ ] Build still passes on Windows (Win32 branch compiles even if not unit-tested).

---

## Phase 4 — Circuit Breaker for Retry Storms

**Goal**: Replace the unbounded counter at `worker-utils.ts:401` with a real circuit breaker. Stop hooks from hammering the worker when it's down.

### 4.1 Files to modify

| File | Change |
| --- | --- |
| `src/shared/worker-circuit-breaker.ts` (new) | `CircuitBreaker` class: states `CLOSED`, `OPEN`, `HALF_OPEN`. Persist to `~/.claude-mem/state/circuit-breaker.json`. |
| `src/shared/worker-utils.ts:executeWithWorkerFallback` (line 443) | Wrap the call in `breaker.run(...)`. On `OPEN`, return `WorkerFallback` immediately (no HTTP). |
| `src/shared/worker-utils.ts:recordWorkerUnreachable` (line 401) | Becomes a thin shim that calls `breaker.recordFailure()`. Hard cap (`MAX_LIFETIME_FAILURES = 50`) trips the breaker permanently until manual reset. |
| `src/shared/worker-utils.ts:resetWorkerFailureCounter` (line 419) | Becomes `breaker.recordSuccess()`. |
| `src/cli/hook-command.ts` | Verify the swallowed-stderr fix from observation 2026-05-07 is applied (it's marked as a "no-op replacement bug"). The breaker's stderr-fail-loud path must actually write to `process.stderr.write()`, not a stub. |
| `src/services/server/Server.ts` | Add `/api/admin/breaker/reset` POST endpoint (gated by localhost only) for manual unsticking. |

### 4.2 Breaker semantics

States and transitions:

```
CLOSED ──[N consecutive failures]──> OPEN
OPEN   ──[reset_timeout_ms elapsed]──> HALF_OPEN
HALF_OPEN ──[1 success]──> CLOSED
HALF_OPEN ──[1 failure]──> OPEN  (resets timer)
ANY    ──[lifetime failures > MAX_LIFETIME_FAILURES]──> OPEN_PERMANENT (until manual reset via API or settings reload)
```

Defaults:

| Setting | Default | Range |
| --- | --- | --- |
| `CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD` | `5` | 1–50 |
| `CLAUDE_MEM_BREAKER_RESET_TIMEOUT_MS` | `30000` | 1000–600000 |
| `CLAUDE_MEM_BREAKER_HALF_OPEN_MAX_PROBES` | `1` | 1–10 |
| `CLAUDE_MEM_BREAKER_LIFETIME_CAP` | `50` | 0–10000 (0 = no cap) |

Persistent state file shape:

```json
{
  "state": "CLOSED|OPEN|HALF_OPEN|OPEN_PERMANENT",
  "consecutiveFailures": 0,
  "lifetimeFailures": 0,
  "openedAt": null,
  "lastFailureAt": null,
  "lastSuccessAt": null,
  "lastTrippedAt": null
}
```

### 4.3 Detailed tasks

1. **CircuitBreaker class**: pure logic class, no I/O. Methods: `getState()`, `canAttempt()`, `recordFailure(reason)`, `recordSuccess()`, `forceReset()`. Atomic file writes (write tmp + rename) for the JSON snapshot, mirroring `writeHookFailureStateAtomic` (worker-utils.ts:372).

2. **Wire into `executeWithWorkerFallback`**:
   ```
   if (!breaker.canAttempt()) {
     // Optional: print one-line stderr if state changed during this call
     return { continue: true, reason: 'circuit_breaker_open', [WORKER_FALLBACK_BRAND]: true };
   }
   const alive = await ensureWorkerAliveOnce();
   if (!alive) { breaker.recordFailure('unreachable'); ... }
   ...
   if (response.ok) breaker.recordSuccess();
   ```

3. **Fail-loud stderr fix**: The 2026-05-07 observation mentions a "stderr no-op replacement bug" in `hookCommand`. Investigate `src/cli/hook-command.ts` for any `process.stderr.write` shim that suppresses output. The breaker's diagnostic ("Worker unreachable; circuit breaker OPEN; will retry in Xs") MUST appear on the user's terminal so they know what's happening. Test by intentionally killing the worker and running a hook — message should appear on stderr.

4. **Manual reset endpoint**: `POST /api/admin/breaker/reset` (no body required). Restricted to `127.0.0.1` only. Logs `SYSTEM` WARN `BreakerForceReset` with caller info.

5. **Lifetime cap**: when `lifetimeFailures > CLAUDE_MEM_BREAKER_LIFETIME_CAP`, transition to `OPEN_PERMANENT`. The only way out is the manual-reset API or restarting the worker with a fresh state file. Print prominent stderr: `claude-mem: 50 lifetime worker failures detected. Disabling memory hooks until reset. Run: claude-mem worker doctor`.

### 4.4 Acceptance criteria

- Kill the worker, run 100 hooks → exactly `CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD` HTTP attempts made; rest short-circuit.
- After 30s idle, next hook makes ONE probe (HALF_OPEN); if probe succeeds, breaker closes.
- Lifetime cap (set to 5 for testing): 6th lifetime failure → permanent open until `POST /api/admin/breaker/reset` clears it.
- Stderr message visible to user when breaker opens (manual repro: kill worker, run 5+ hooks).
- Existing hook-failures.json file is migrated to the new breaker JSON format on first run (one-shot migration in `worker-utils.ts`).

### 4.5 Observability

- Log: `SYSTEM` WARN `BreakerOpened`, fields `{lifetime, consecutiveBefore}`.
- Log: `SYSTEM` INFO `BreakerHalfOpen`.
- Log: `SYSTEM` INFO `BreakerClosed`, fields `{recoveredAfterMs}`.
- Log: `SYSTEM` ERROR `BreakerOpenedPermanent`.
- `/api/healthz` fields (Phase 7): `breaker_state`, `breaker_consecutive_failures`, `breaker_lifetime_failures`, `breaker_opened_at`, `breaker_total_trips`.

### 4.6 Anti-pattern guards

- **Do not** call the breaker from inside the worker process — it's a hook-side concern. The worker has `RestartGuard` for its own session-level limits.
- **Do not** auto-reset the lifetime counter on restart; persist it. Otherwise restart-loops mask the underlying failure.
- **Do not** block the breaker reset endpoint on initialization (`/api/admin/breaker/reset` should work even if `initializationCompleteFlag === false`).

### 4.7 Verification checklist

- [ ] No call site bypasses the breaker (grep for `workerHttpRequest` outside `executeWithWorkerFallback` and audit each — some integrations may need `breaker.canAttempt()` guards added).
- [ ] State file readable/writable across process restarts.
- [ ] Stderr fail-loud path verified end-to-end on Linux + macOS + Windows Terminal.
- [ ] No `process.exit(1)` introduced — breaker tripping returns `WorkerFallback`, not exit codes.

---

## Phase 7 — `/api/healthz` Endpoint with Concrete Metrics

**Goal**: Centralized observability so future regressions are detectable at a glance.

### 7.1 Files to modify

| File | Change |
| --- | --- |
| `src/services/worker/http/routes/HealthzRoutes.ts` (new) | Implements `RouteHandler`. GET `/api/healthz` and `/api/healthz?format=prom`. |
| `src/services/worker-service.ts:registerRoutes` | Register the new `HealthzRoutes(...)`. |
| `src/services/worker/MetricsCollector.ts` (new) | Aggregates metrics; refreshed on the supervisor's existing 30s health-check tick to avoid amplifying load. |
| `src/supervisor/health-checker.ts:runHealthCheck` | Call `MetricsCollector.refresh()` after `pruneDeadEntries`. |

### 7.2 Endpoint contract

`GET /api/healthz` → 200 JSON:

```json
{
  "status": "ok|degraded|unhealthy",
  "ts": "2026-05-07T21:30:00.000Z",
  "uptime_sec": 12345,
  "versions": {
    "plugin": "12.7.5",
    "worker": "12.7.5",
    "matches": true
  },
  "process": {
    "pid": 12345,
    "rss_mb": 145.2,
    "event_loop_lag_ms": 3.1,
    "managed": true,
    "platform": "darwin"
  },
  "pid_file": {
    "path": "/Users/.../worker.pid",
    "start_token": "Wed May  7 14:23:15 2026",
    "daemon_lock_held": true
  },
  "db": {
    "path": "/Users/.../claude-mem.db",
    "size_bytes": 31457280,
    "page_count": 7680,
    "freelist_count": 12,
    "free_ratio_pct": 0.16,
    "last_vacuum_at": "2026-05-07T20:00:00.000Z",
    "last_vacuum_freed_pages": 130000,
    "last_maintenance_at": "2026-05-07T20:00:00.000Z",
    "oldest_processing_pending_age_sec": 4,
    "processing_pending_count": 1,
    "pending_count_total": 12,
    "sdk_sessions_total": 145,
    "sdk_sessions_inactive": 13,
    "sdk_sessions_by_project": { "claude-mem": 25, "...": 120 }
  },
  "child_processes": {
    "chroma_mcp_pid_count": 1,
    "chroma_mcp_last_call_at": "2026-05-07T21:25:11.000Z",
    "chroma_mcp_state": "connected",
    "chroma_mcp_backoff_remaining_ms": 0,
    "sdk_process_count": 0,
    "supervisor_registry_size": 2
  },
  "network": {
    "hook_consecutive_failures": 0,
    "breaker_state": "CLOSED",
    "breaker_consecutive_failures": 0,
    "breaker_lifetime_failures": 3,
    "breaker_opened_at": null,
    "breaker_total_trips": 1,
    "last_request_at": "2026-05-07T21:29:55.000Z",
    "request_rate_per_min": 12.3
  },
  "ai": {
    "provider": "claude",
    "auth_method": "...",
    "last_interaction": { ... }
  }
}
```

`GET /api/healthz?format=prom` → 200 `text/plain` with Prometheus text format. One metric per JSON leaf (e.g. `claude_mem_db_free_ratio_pct 0.16`).

`status` derivation:
- `unhealthy` if breaker is OPEN_PERMANENT, OR DB initialization failed, OR chroma-mcp pid count > `CLAUDE_MEM_CHROMA_MAX_CONCURRENT`.
- `degraded` if breaker is OPEN, OR free_ratio > 0.4, OR oldest_processing_pending > 1 hour, OR worker version mismatches plugin version.
- `ok` otherwise.

### 7.3 Detailed tasks

1. **MetricsCollector class**: a `Map<string, unknown>` snapshot. Public `refresh()` collects fresh data; public `getSnapshot()` returns the cached object. Refresh is called by the 30s health-check tick AND on-demand if last refresh > 5s ago (debounced).

2. **DB metrics queries** (use `db.prepare` + `.get()`):
   - `PRAGMA page_count` → `{ page_count: number }`
   - `PRAGMA freelist_count` → `{ freelist_count: number }`
   - `PRAGMA page_size` → for size_bytes computation
   - `SELECT MIN(updated_at) FROM pending_messages WHERE status='processing'` (with `julianday` math for age in seconds)
   - `SELECT COUNT(*) FROM sdk_sessions GROUP BY project`

3. **Process metrics**: `process.memoryUsage().rss / 1024 / 1024`. Event-loop lag via `perf_hooks.monitorEventLoopDelay` (Node API, available in bun) — sample over 30s window.

4. **Network metrics**: maintain a rolling 1-min request counter in middleware (existing `createMiddleware` in `Server.ts:156`). Increment on each `/api/*` request.

5. **Prometheus format**: emit `# HELP` and `# TYPE` lines per metric. Use the same naming convention (`claude_mem_<group>_<name>`).

6. **Compatibility**: leave `/api/health` UNCHANGED (existing integrations break otherwise). `/api/healthz` is the new richer endpoint.

### 7.4 Acceptance criteria

- `curl 127.0.0.1:<port>/api/healthz | jq .status` returns `ok` on a healthy worker.
- After Phase 6 ships, `db.free_ratio_pct` updates at 30s cadence (verify by manually inflating freelist).
- Phase 4 breaker state changes are visible within 30s.
- `?format=prom` parses with `promtool check metrics`.
- No new endpoint blocks for > 50ms (snapshot is cached; refresh is async).

### 7.5 Observability hooks (yes, for the observability endpoint itself)

- Log `WORKER` DEBUG `MetricsRefresh`, fields `{durationMs}`.
- Log `WORKER` WARN `MetricsRefreshSlow` if refresh > 250ms (DB query stall signal).

### 7.6 Verification checklist

- [ ] `/api/health` response body unchanged byte-for-byte (regression test).
- [ ] All Phase 2-6 metrics exposed (cross-check the field list in those phases).
- [ ] `?format=prom` output validates with `promtool` if available; otherwise visual inspection.
- [ ] Endpoint mounted via `RouteHandler` pattern (no direct `app.get` in worker-service.ts).

---

## Phase 8 — Observability, CLI, & Rollout

**Goal**: User-facing surface so operators can see what the new machinery did. Ordered last to allow phases 2-7 to stabilize.

### 8.1 Files to modify

| File | Change |
| --- | --- |
| `src/cli/handlers/worker-doctor.ts` (new) | New CLI subcommand `claude-mem worker doctor` — fetches `/api/healthz`, formats it for terminals, includes recent reaper actions. |
| `src/services/worker-service.ts:main()` | Register the `worker doctor` CLI route (alongside existing `cursor`, `gemini-cli` cases). |
| `plugin/scripts/worker-cli.js` | Wire to the new doctor command. |
| `CLAUDE.md` (project root) | Document new settings under a "Worker Maintenance" section. |
| `docs/public/` (optional) | User-facing explanation of the breaker, reaper, and health endpoint. |

### 8.2 `worker doctor` output (example)

```
claude-mem worker doctor

Status:           OK
Version:          plugin=12.7.5 worker=12.7.5 (match)
Uptime:           3h 25m
PID:              12345  (lock held: yes)

Database:
  Size:             32 MB    (free: 0.16%)
  Last vacuum:      4h ago, freed 130k pages
  Pending:          12 total / 1 processing (oldest 4s)
  SDK sessions:     145 total / 13 inactive

Child processes:
  chroma-mcp:       1  (last call: 5s ago, state: connected)
  SDK processes:    0
  Supervisor:       2 entries

Circuit breaker:
  State:            CLOSED
  Consecutive:      0
  Lifetime:         3
  Total trips:      1

Recent maintenance (last 24h):
  2026-05-07 20:00  Vacuum: freed 130k pages in 1.4s
  2026-05-07 19:30  Reaper: 5 stuck-processing reset, 2 inactive marked
  2026-05-07 18:00  Chroma orphan scan: 0 found
```

If `status != ok`, append a "Recommended actions" block:
- breaker open → `claude-mem worker reset-breaker`
- DB free ratio high → mention next vacuum window
- chroma orphans → `claude-mem worker reap-chroma`

### 8.3 Detailed tasks

1. **Doctor command**: GET `/api/healthz` via `workerHttpRequest`. Format as the table above. Color-code (red/yellow/green) using existing chalk integration if present, otherwise plain text. JSON pass-through via `--json` flag.

2. **Recent-actions feed**: store the last 50 maintenance events in a circular buffer in `MetricsCollector` (in-memory only — survives one worker lifetime; not persistent). Expose at `/api/healthz/events` (separate to avoid bloating the main response).

3. **Update CLAUDE.md**: add a "Worker Maintenance" section with: settings reference table, the doctor command, a brief description of the reaper/breaker/vacuum behavior. Per CLAUDE.md "Important: No need to edit the changelog ever" — only edit CLAUDE.md, never CHANGELOG.

4. **Rollout ordering** (per problem statement constraint):
   - Wave 1 (idempotent, low-risk): Phase 5 (PID/port reclamation), Phase 6 (DB maintenance).
   - Wave 2 (reapers — needs careful testing on busy DBs): Phase 2 (session reaper), Phase 3 (chroma supervisor).
   - Wave 3 (user-visible behavior change): Phase 4 (circuit breaker), Phase 7 (`/api/healthz`).
   - Wave 4 (CLI surface): Phase 8 (doctor command, docs).

   Each wave can ship as a separate release. Inter-wave dependencies: Phase 7 depends on data sources from Phases 2/3/4/6 — but the endpoint can ship with partial data (fields gated by phase availability).

### 8.4 Acceptance criteria

- `claude-mem worker doctor` prints a green-OK summary on a healthy worker.
- `claude-mem worker doctor --json` returns valid JSON pipeable to `jq`.
- Killing the worker → `claude-mem worker doctor` cleanly reports `Worker unreachable` instead of hanging.
- CLAUDE.md updates are limited to a new section; no churn elsewhere.

### 8.5 Verification checklist

- [ ] `claude-mem worker doctor` exits 0 on healthy state, 1 on unhealthy, 2 if worker unreachable (mirrors hook-exit-codes convention).
- [ ] No new public marketplace API surface beyond what's documented.
- [ ] Doctor command works without the worker running (unreachable path covered).

---

## Final Phase — Cross-Phase Verification

**Goal**: Prove the system works end-to-end before declaring victory.

### F.1 Soak test (24h)

Run the worker for 24 hours under realistic Claude Code usage. After 24h:

| Metric | Pass criterion |
| --- | --- |
| `ps aux \| grep chroma-mcp \| wc -l` | ≤ 1 |
| `ps aux \| grep claude-mem \| wc -l` | ≤ a small constant (1-2) |
| DB size growth rate | < 5 MB/hr; free_ratio < 20% |
| `/api/healthz` `breaker.lifetime_failures` | < 10 (vs. the #1874 starting baseline) |
| Stuck `processing` rows older than 10 min | 0 |
| Worker memory RSS | < 300 MB (no leak) |

### F.2 Failure-injection tests

| Inject | Expected behavior |
| --- | --- |
| Kill worker via `kill -9` | Lazy-respawn on next hook; PID file cleaned |
| Two parallel `claude-mem start` | Exactly one daemon survives; lock log line visible |
| 100 stuck processing rows | Reaper resets all within `REAPER_PROCESSING_STUCK_MS + REAPER_TICK_MS` |
| Spawn fake listener on worker port | New `--daemon` exits 0 with diagnostic stderr (no silent exit) |
| Fork 5 chroma-mcp orphans | Worker startup reaps all 5 |
| Pull network during 10 hooks | Breaker opens after threshold; subsequent hooks short-circuit |

### F.3 Anti-pattern grep

```
# No new always-on intervals
grep -rn "setInterval" src/ --include="*.ts" | grep -v "unref()" | grep -v "^src/.*test"

# No new process.exit(1) on hook paths
git diff main -- src/shared/worker-utils.ts src/cli/ | grep "process.exit(1)"

# No invented settings
git diff main -- src/shared/SettingsDefaultsManager.ts | grep "CLAUDE_MEM_"
# Cross-reference with all phases' settings tables.

# No hardcoded magic numbers in business logic
git diff main | grep -E "[0-9]{4,}" | grep -v SettingsDefaultsManager | grep -v test
```

### F.4 Documentation diff

- `CLAUDE.md` adds: Worker Maintenance section (Phase 8.3).
- `docs/public/` (optional): user-facing explanation.
- No CHANGELOG edits (auto-generated per CLAUDE.md).

### F.5 Sign-off checklist

- [ ] All 8 phases shipped.
- [ ] `/api/healthz` reports `status: "ok"` 24h after deployment.
- [ ] No new ERROR-level logs in production for 24h (excluding pre-existing).
- [ ] Manual `worker doctor` on 3 production-like environments confirms expected output.
- [ ] Phase 0 doc-discovery anti-patterns not violated (grep `git log -p`).

---

## Appendix A — Settings Reference (consolidated)

All settings declared in `src/shared/SettingsDefaultsManager.ts`:

| Setting | Phase | Default | Range |
| --- | --- | --- | --- |
| `CLAUDE_MEM_DAEMON_LOCK_TIMEOUT_MS` | 5 | `5000` | 0–60000 |
| `CLAUDE_MEM_PID_PORT_RECHECK_MS` | 5 | `2000` | 500–30000 |
| `CLAUDE_MEM_DB_MAINTENANCE_ENABLED` | 6 | `true` | bool |
| `CLAUDE_MEM_DB_MAINTENANCE_INTERVAL_HOURS` | 6 | `24` | 1–168 |
| `CLAUDE_MEM_DB_VACUUM_THRESHOLD_RATIO` | 6 | `0.40` | 0.05–0.95 |
| `CLAUDE_MEM_DB_VACUUM_STARTUP_DELAY_MS` | 6 | `300000` | 0–3600000 |
| `CLAUDE_MEM_CLEANUP_REGRESSION_CHECK` | 6 | `true` | bool |
| `CLAUDE_MEM_REAPER_ENABLED` | 2 | `true` | bool |
| `CLAUDE_MEM_REAPER_TICK_MS` | 2 | `30000` | 5000–600000 |
| `CLAUDE_MEM_REAPER_PROCESSING_STUCK_MS` | 2 | `300000` | 30000–86400000 |
| `CLAUDE_MEM_REAPER_INACTIVE_DAYS` | 2 | `30` | 1–365 |
| `CLAUDE_MEM_REAPER_HARD_DELETE_INACTIVE_DAYS` | 2 | `0` | 0–365 |
| `CLAUDE_MEM_CHROMA_IDLE_SHUTDOWN_MS` | 3 | `900000` | 60000–86400000 |
| `CLAUDE_MEM_CHROMA_ORPHAN_SCAN_ON_START` | 3 | `true` | bool |
| `CLAUDE_MEM_CHROMA_MAX_CONCURRENT` | 3 | `1` | 1–4 |
| `CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD` | 4 | `5` | 1–50 |
| `CLAUDE_MEM_BREAKER_RESET_TIMEOUT_MS` | 4 | `30000` | 1000–600000 |
| `CLAUDE_MEM_BREAKER_HALF_OPEN_MAX_PROBES` | 4 | `1` | 1–10 |
| `CLAUDE_MEM_BREAKER_LIFETIME_CAP` | 4 | `50` | 0–10000 |

## Appendix B — File Change Summary

| File | Phases that touch it |
| --- | --- |
| `src/services/worker-service.ts` | 3 (initializeBackground), 5 (--daemon), 6 (maintenance wiring), 7 (route registration), 8 (CLI) |
| `src/services/worker-spawner.ts` | 5 |
| `src/services/infrastructure/ProcessManager.ts` | 5 (lock + start-token) |
| `src/services/infrastructure/HealthMonitor.ts` | 5 (port-on-pid match) |
| `src/services/infrastructure/CleanupV12_4_3.ts` | 6 (regression detection — read only) |
| `src/services/sync/ChromaMcpManager.ts` | 3 |
| `src/supervisor/index.ts` | 5 (validateWorkerPidFile) |
| `src/supervisor/process-registry.ts` | 3 (orphan scan), 5 (start-token) |
| `src/supervisor/health-checker.ts` | 2 (reaper), 7 (metrics refresh) |
| `src/services/worker/SessionManager.ts` | 2 (delete hook), 6 (pause/resume) |
| `src/shared/worker-utils.ts` | 4 (breaker integration) |
| `src/services/sqlite/Database.ts` | 6 (auto_vacuum) |
| `src/services/sqlite/PendingMessageStore.ts` | 2 (reapStuckProcessing) |
| `src/services/sqlite/SessionStore.ts` | 2 (findInactiveSdkSessions) |
| `src/services/sqlite/migrations/runner.ts` | 2 (inactive_at column) |
| `src/services/server/Server.ts` | 4 (breaker reset), 7 (healthz route) |
| `src/shared/SettingsDefaultsManager.ts` | 2-6 (settings keys) |
| `src/services/maintenance/DbMaintenance.ts` | 6 (NEW) |
| `src/services/maintenance/SessionReaper.ts` | 2 (NEW) |
| `src/shared/worker-circuit-breaker.ts` | 4 (NEW) |
| `src/services/worker/MetricsCollector.ts` | 7 (NEW) |
| `src/services/worker/http/routes/HealthzRoutes.ts` | 7 (NEW) |
| `src/cli/handlers/worker-doctor.ts` | 8 (NEW) |
| `CLAUDE.md` | 8 (Worker Maintenance section) |

## Appendix C — Open Questions for Executor

1. **`bun:ffi` flock support**: confirm via spike before committing Phase 5.4. If unavailable, fall back to `flock(1)` shell on Linux + atomic `mkdirSync` sentinel on macOS/Windows.
2. **Event-loop lag sampling on bun**: verify `perf_hooks.monitorEventLoopDelay` works in bun's Node-compat layer. If not, fall back to a setImmediate-based heuristic.
3. **Existing-DB auto_vacuum migration**: verify that the startup full VACUUM in Phase 6.3 is sufficient to reclaim the 504 MB without requiring users to run `PRAGMA auto_vacuum = INCREMENTAL; VACUUM;` manually. (It should — full VACUUM with auto_vacuum already set takes effect.)
4. **Pro-features compatibility**: confirm with maintainers that `/api/healthz` does not duplicate any planned Pro endpoint. Per CLAUDE.md "Pro Features Architecture", the worker's local HTTP API stays open — `/api/healthz` is fine to add OSS-side.
