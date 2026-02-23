# Implementation Plan: Worker Auto-Restart on Version Mismatch

## Overview

When the plugin is updated but the worker keeps running the old version, `ensureWorkerRunning()` in `src/shared/worker-utils.ts` detects the mismatch but only logs it. This plan adds auto-restart logic so the worker is restarted and verified healthy within the same call, using the existing `worker-service.cjs restart` CLI command.

## Requirements

- When `ensureWorkerRunning()` detects a healthy worker with a version mismatch, trigger a restart
- After restart, verify the new worker is healthy
- If restart fails, fall back gracefully (return `false`, don't block the hook)
- Minimal changes -- reuse existing restart mechanism
- No changes to `worker-service.ts` or `HealthMonitor.ts`

## Delivery Strategy

user-managed (current branch, user handles branching)

## Architecture Changes

- **`src/shared/worker-utils.ts`**: Modify `checkWorkerVersion()` to return mismatch status; add `restartWorker()` function; update `ensureWorkerRunning()` to restart on mismatch
- **`tests/shared/worker-utils-version-restart.test.ts`**: New test file for version mismatch restart behavior

## Implementation Steps

### Phase 1: Modify worker-utils.ts

1. **Change `checkWorkerVersion()` return type** (File: `src/shared/worker-utils.ts`)
   - Action: Change return type from `Promise<void>` to `Promise<boolean>` where `true` = versions match, `false` = mismatch
   - Why: `ensureWorkerRunning()` needs to know whether a mismatch was detected to decide whether to restart
   - Dependencies: None
   - Risk: Low (private function, only called from `ensureWorkerRunning`)

2. **Add `restartWorker()` function** (File: `src/shared/worker-utils.ts`)
   - Action: Add a new async function that:
     1. Resolves the path to `worker-service.cjs` using the MARKETPLACE_ROOT constant (already defined)
     2. Calls `execFile('node', [workerServicePath, 'restart'])` asynchronously (not sync -- hooks have 30-60s timeout, plenty of time)
     3. After the restart command completes, calls `isWorkerHealthy()` to verify the new worker is up
     4. Returns `true` if healthy, `false` otherwise
     5. Wraps everything in try/catch for graceful degradation
   - Why: Encapsulates restart logic cleanly; uses the existing CLI `restart` command which handles shutdown, port-free wait, daemon spawn, and health check
   - Dependencies: Step 1
   - Risk: Low (fire-and-verify pattern; existing restart command is battle-tested)

   ```typescript
   import { execFile } from 'child_process';
   import { promisify } from 'util';

   const execFileAsync = promisify(execFile);

   async function restartWorker(): Promise<boolean> {
     const workerServicePath = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
     try {
       logger.info('SYSTEM', 'Restarting worker due to version mismatch');
       await execFileAsync('node', [workerServicePath, 'restart'], { timeout: 45000 });
       const healthy = await isWorkerHealthy();
       if (healthy) {
         logger.info('SYSTEM', 'Worker restarted successfully after version mismatch');
       } else {
         logger.warn('SYSTEM', 'Worker restart completed but health check failed');
       }
       return healthy;
     } catch (error) {
       logger.warn('SYSTEM', 'Worker restart failed, proceeding gracefully', {
         error: error instanceof Error ? error.message : String(error)
       });
       return false;
     }
   }
   ```

3. **Update `ensureWorkerRunning()` to restart on mismatch** (File: `src/shared/worker-utils.ts`)
   - Action: After `isWorkerHealthy()` returns true, call `checkWorkerVersion()`. If it returns `false` (mismatch), call `restartWorker()` and return its result. If restart fails, return `false`.
   - Why: This is the core fix -- the function now actually handles version mismatch instead of just logging
   - Dependencies: Steps 1, 2
   - Risk: Low (graceful degradation on failure; if restart fails, hook proceeds without worker)

   Updated flow:
   ```typescript
   export async function ensureWorkerRunning(): Promise<boolean> {
     try {
       if (await isWorkerHealthy()) {
         const versionsMatch = await checkWorkerVersion();
         if (!versionsMatch) {
           return await restartWorker();
         }
         return true;
       }
     } catch (e) {
       logger.debug('SYSTEM', 'Worker health check failed', {
         error: e instanceof Error ? e.message : String(e)
       });
     }
     logger.warn('SYSTEM', 'Worker not healthy, hook will proceed gracefully');
     return false;
   }
   ```

### Phase 2: Tests

4. **Create test file** (File: `tests/shared/worker-utils-version-restart.test.ts`)
   - Action: Write unit tests using Vitest with `vi.mock` to mock `fetch`, `execFile`, `readFileSync`, and `logger`. Test scenarios:
     1. **Healthy worker, versions match** -- returns `true`, no restart triggered
     2. **Healthy worker, version mismatch, restart succeeds** -- calls restart, returns `true`
     3. **Healthy worker, version mismatch, restart fails** -- calls restart, returns `false`
     4. **Healthy worker, version check throws** -- returns `true` (graceful; can't determine version)
     5. **Unhealthy worker** -- returns `false`, no version check or restart attempted
     6. **Version mismatch, restart succeeds but post-restart health check fails** -- returns `false`
   - Why: Verifies all code paths including error scenarios
   - Dependencies: Steps 1-3
   - Risk: Low

### Phase 3: Verify Build

5. **Build and verify** (No file changes)
   - Action: Run `npm run build` to verify TypeScript compiles and esbuild bundles correctly
   - Why: The new `execFile` import must be handled correctly by esbuild for both ESM hooks and CJS worker bundle
   - Dependencies: Steps 1-4
   - Risk: Low (child_process is a Node.js built-in, already used elsewhere in the codebase)

6. **Run tests** (No file changes)
   - Action: Run `npm test` to verify all tests pass including the new ones
   - Dependencies: Step 5
   - Risk: Low

## Testing Strategy

- **Unit tests**: `tests/shared/worker-utils-version-restart.test.ts` -- mock all I/O (fetch, execFile, fs)
- **Manual integration test**: After `npm run build-and-sync`, verify that stopping and starting with a version mismatch triggers restart (can simulate by editing the version in the running worker's memory)

## Risks & Mitigations

- **Risk**: `execFileAsync` timeout could be too short on slow systems (Windows, WSL)
  - Mitigation: 45-second timeout is generous; the `restart` command itself has internal timeouts (15s for port-free, 30s for health). If it times out, `restartWorker()` returns `false` gracefully.

- **Risk**: Race condition if two hooks detect mismatch simultaneously and both try to restart
  - Mitigation: The `restart` command uses `httpShutdown` which is idempotent, and `spawnDaemon` will fail gracefully if port is already in use. The second restart attempt will find the worker already healthy at the correct version. This is acceptable for a rare edge case.

- **Risk**: Circular restart loop if the new worker version also mismatches (build artifact stale)
  - Mitigation: `restartWorker()` is only called once per `ensureWorkerRunning()` invocation. There's no retry loop. If the restarted worker still has a mismatch, the next hook call will attempt restart again, but that's expected behavior (eventually the user will rebuild).

## Success Criteria

- [ ] `ensureWorkerRunning()` returns `true` when worker is healthy and versions match (no restart)
- [ ] `ensureWorkerRunning()` triggers restart when versions mismatch and returns `true` on success
- [ ] `ensureWorkerRunning()` returns `false` gracefully when restart fails
- [ ] All existing tests continue to pass
- [ ] New tests cover all 6 scenarios listed above
- [ ] Build succeeds (`npm run build`)
