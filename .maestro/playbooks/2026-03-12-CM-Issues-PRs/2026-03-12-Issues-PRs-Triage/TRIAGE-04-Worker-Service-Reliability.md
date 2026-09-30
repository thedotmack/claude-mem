# Phase 04: High — Worker Service Reliability

These bugs cause the worker service to silently fail, report incorrect health status, or get killed by process managers. They're high severity because users think claude-mem is working when it's actually dead — observations are silently lost.

**Issues addressed:** #1323, #1231, #1245
**Prerequisite:** Phases 01-03 should be complete.

## Tasks

- [x] Fix race condition in database initialization on session-init hook (#1323). The hook fires before `initializeBackground()` completes in `src/services/worker-service.ts`, causing "Database not initialized" errors:
  - Read `src/services/worker-service.ts` — find the `initializeBackground()` method (around line 377) and the readiness tracking (`initializationCompleteFlag`, `resolveInitialization`)
  - Read the HTTP route that handles session-init — likely in `src/services/worker/http/routes/SessionRoutes.ts`
  - The fix: in the session-init route handler, `await this.workerService.initializationComplete` before proceeding with database operations. The promise already exists (line ~182) — it resolves when DB + search are ready
  - Check if other route handlers already use this pattern — search for `initializationComplete` across the routes
  - If a readiness middleware already exists (check `src/services/worker/http/middleware.ts`), ensure it covers the session-init endpoint
  - Alternative: return HTTP 503 with `Retry-After: 1` header if not initialized, so the hook retries
  - **Completed:** Added `/sessions/*` guard middleware in `worker-service.ts` matching the existing `/api/*` guard pattern. Legacy session routes now wait for `initializationComplete` with 30s timeout, returning 503 if DB isn't ready. 5 tests added in `tests/worker/http/initialization-guard.test.ts`. All 1154 tests pass. Commit `726afd12`.

- [x] Fix stale PID file causing false "worker running" detection (#1231). `ProcessManager.readPidFile()` returns a PID that no longer corresponds to a running worker, causing the startup logic to skip spawning a new one:
  - Read `src/services/infrastructure/ProcessManager.ts` — find `readPidFile()` (around line 124-165) and `isProcessAlive()` (around line 698)
  - The fix: after reading PID file, ALWAYS validate with `isProcessAlive(pid)` AND a health check to `/api/health`. A process can be alive (PID exists) but not be the worker (different process reused the PID)
  - In the startup path (likely `ensureWorkerRunning()` in hook-command.ts), add this validation sequence:
    1. Read PID file → if no file, spawn new worker
    2. Check `isProcessAlive(pid)` → if dead, remove stale PID file, spawn new worker
    3. Check health endpoint → if unhealthy, kill stale process, remove PID file, spawn new worker
    4. Only skip spawning if ALL three checks pass
  - Search for existing liveness validation patterns in the codebase before implementing
  - **Completed:** Two-part fix in `worker-service.ts`: (1) Daemon startup guard now validates PID liveness AND health check via `isPortInUse()` — if PID alive but health fails, removes stale PID file instead of refusing to start. (2) `ensureWorkerStarted()` now removes residual PID file when health check fails but `cleanStalePidFile()` kept it (PID reuse case). 7 tests added in `tests/infrastructure/stale-pid-detection.test.ts`. All 1033 tests pass. Commit `840a7500`.

- [x] Fix systemd SIGKILL from fork-then-exit pattern (#1245). Under systemd, the worker-service.cjs start subcommand forks a background process and exits, but systemd's default `KillMode=control-group` kills all processes in the cgroup including the forked worker:
  - Read `plugin/scripts/worker-service.cjs` to understand the start subcommand's fork pattern
  - The fix has two parts:
    1. In `worker-service.cjs`, when running under systemd (detect via `INVOCATION_ID` env var or `NOTIFY_SOCKET`), do NOT fork — run the worker in the foreground so systemd tracks the correct PID
    2. Add a `systemd` mode: if `process.env.INVOCATION_ID` is set, skip the fork-and-exit logic and run directly
  - Document in a comment that systemd users should use `Type=exec` or `Type=simple` in their service file, not `Type=forking`
  - This is a targeted fix — do NOT add a full systemd service file or socket activation
  - **Completed:** Added `isRunningUnderSystemd()` to `ProcessManager.ts` that detects systemd via `INVOCATION_ID` env var. In `worker-service.ts` `main()`, when `start` command runs under systemd, it redirects to `--daemon` (foreground) mode — reusing all existing guard checks (PID file validation, port-in-use check, unhandled error handlers). 3 tests added in `tests/infrastructure/systemd-foreground.test.ts`. All infrastructure tests pass. Build synced. Commit `5fd91ec0`.

- [x] Run tests and verify worker lifecycle:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - Verify PID validation by manually testing: stop the worker, check that next session start spawns a new one (not stale PID skip)
  - **Completed:** All 1154 tests pass (3 skipped, 0 failures). Build-and-sync completed successfully — worker-service.cjs (1844 KB), mcp-server.cjs (350 KB), context-generator.cjs (71 KB) all built and synced to marketplace. PID validation verified manually: planted stale PID file (PID 99999), worker start detected it as stale, cleaned up, and spawned fresh worker (PID 91027) with healthy `/api/health` response.
