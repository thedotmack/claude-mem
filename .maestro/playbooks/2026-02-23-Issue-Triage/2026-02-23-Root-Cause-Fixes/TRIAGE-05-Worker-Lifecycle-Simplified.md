# Phase 05: Worker Lifecycle — Fix Restart Loops and Subprocess Cleanup

Multiple sessions detect version mismatch and all try to restart the worker simultaneously, spawning hundreds of daemons (#1145). The fix is simple: use the existing PID file to coordinate restarts. Additionally, chroma-mcp subprocesses aren't cleaned up on shutdown — fix by calling `ChromaMcpManager.stop()` on all exit paths. No ProcessRegistry needed.

**Issues resolved:** #1124, #1145 (restart loops), #1068, #1089, #1090 (process leaks), #1131 (stale transport), #1042 (ENOENT on shutdown)

## Root Cause Validation

**Restart loops** — Each hook invocation that sees a version mismatch tries to restart the worker independently. With 10 concurrent sessions, you get 10 simultaneous restart attempts. Fix: check if another restart is already in progress (PID file age check).

**Process leaks** — `ChromaMcpManager.stop()` exists and properly kills the subprocess, but it's not called on all shutdown paths. SIGTERM/SIGINT handlers in the worker may not await the async `stop()`.

## Tasks

- [x] Fix version mismatch restart loops:
  - Find where version mismatch is detected (search for `version` checks in `src/cli/handlers/session-init.ts` or `src/shared/worker-utils.ts`)
  - Add a simple guard: before attempting restart, check the PID file's mtime. If it was written less than 15 seconds ago, skip the restart and wait for the existing restart to complete
  - After restart, update the PID file mtime (touch it)
  - Other sessions should poll `/api/health` every 500ms for up to 15 seconds instead of trying their own restart
  - This is a simple timestamp check on an existing file — NOT a new lock file system with JSON payloads
  > **Done:** Added `isPidFileRecent()` and `touchPidFile()` to ProcessManager.ts. `ensureWorkerStarted()` now checks PID file mtime before attempting version-mismatch restart — if recent (<15s), polls health instead. After successful restart, touches PID file to signal other sessions.

- [x] Ensure ChromaMcpManager.stop() is called on all shutdown paths:
  - In `src/services/worker-service.ts`, find the SIGTERM/SIGINT signal handlers
  - Add `await ChromaMcpManager.getInstance().stop()` to every shutdown path
  - Also check `src/services/infrastructure/ProcessManager.ts` for its shutdown handler — add the same call
  - The key is that `stop()` is async but signal handlers often exit before awaiting. Ensure the handler awaits or uses `process.on('beforeExit')` as a backup
  > **Already implemented:** All shutdown paths flow through `WorkerService.shutdown()` → `performGracefulShutdown()` which already has STEP 5 that awaits `chromaMcpManager.stop()`. Signal handlers use `createSignalHandler()` which properly awaits the shutdown function before `process.exit(0)`. No changes needed.

- [x] Fix the stale transport reconnect bug (#1131):
  - In `ChromaMcpManager.ts`, `ensureConnected()` checks `this.connected && this.client` but doesn't verify the transport is alive
  - The `onclose` handler (line 159-169) already sets `this.connected = false` when the transport closes
  - Verify this handler fires reliably — if the subprocess is killed externally (e.g., by orphan reaper), does `onclose` fire?
  - If not, add a health check: before returning from `ensureConnected()`, do a quick `this.client.ping()` or equivalent
  > **Done:** The `onclose` handler fires reliably when subprocess is killed (SIGKILL closes file descriptors → stdio close event → onclose). Added transparent single-retry logic in `callTool()`: on transport error, marks disconnected, reconnects, and retries once before throwing. This eliminates the one-shot failure that callers previously had to handle.

- [x] Fix ENOENT race on shutdown (#1042):
  - In Stop hooks, `package.json` is read to check version but may not exist during shutdown
  - Wrap the `readFileSync` for `package.json` in try/catch — if the file doesn't exist, skip version check
  > **Done:** Wrapped `getInstalledPluginVersion()` in HealthMonitor.ts with try/catch for ENOENT/EBUSY, returning 'unknown'. Updated `checkVersionMatch()` to skip comparison when plugin version is 'unknown'.

- [x] Run `npm test` and fix any failures
  > **Done:** 964 pass, 21 fail (all pre-existing from baseline #54831), 3 skip. Added tests for `isPidFileRecent`, `touchPidFile`, `getInstalledPluginVersion`, and `checkVersionMatch`. Zero new failures introduced.
