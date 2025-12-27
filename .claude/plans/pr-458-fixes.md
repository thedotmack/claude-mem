# PR #458 Fix Plan: Worker Lifecycle Critical Issues

**Branch:** `bugfix/spawn-worker`
**Created:** 2025-12-26
**Context:** PR review found 3 critical bugs, 5 important issues in the worker self-spawn implementation

---

## Phase 1: Fix Critical `waitForProcessesExit` Bug

**Goal:** Fix the logic bug that crashes shutdown when child processes exit

**File:** `src/services/worker-service.ts`

**What to do:**
1. Find the `waitForProcessesExit` method (around line 752-771)
2. The `pids.filter()` callback calls `process.kill(pid, 0)` which throws when the process is dead
3. Wrap in try/catch to return false when process doesn't exist

**Current code:**
```typescript
const stillAlive = pids.filter(pid => {
  process.kill(pid, 0); // Signal 0 checks if process exists - throws if dead
  return true;
});
```

**Fixed code:**
```typescript
const stillAlive = pids.filter(pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
});
```

**Verification:** The filter should now correctly remove PIDs of exited processes instead of throwing.

---

## Phase 2: Fix Spawn PID Validation

**Goal:** Prevent invalid PID file writes when spawn fails

**File:** `src/services/worker-service.ts`

**What to do:**
1. Find the `start` case in the CLI switch (around line 816-844)
2. After spawn(), add check for undefined pid before writing PID file
3. Exit with error if spawn failed

**Current code:**
```typescript
const child = spawn(process.execPath, [__filename, '--daemon'], {...});
child.unref();
writePidFile({ pid: child.pid!, port, startedAt: new Date().toISOString() });
```

**Fixed code:**
```typescript
const child = spawn(process.execPath, [__filename, '--daemon'], {...});

if (child.pid === undefined) {
  console.error('Failed to spawn worker daemon');
  process.exit(1);
}

child.unref();
writePidFile({ pid: child.pid, port, startedAt: new Date().toISOString() });
```

**Verification:** Remove the `!` non-null assertion since we now properly check.

---

## Phase 3: Fix Unix Process Cleanup Error Handling

**Goal:** Handle errors in orphaned process cleanup

**File:** `src/services/worker-service.ts`

**What to do:**
1. Find `cleanupOrphanedProcesses` method (around line 389-458)
2. The Unix branch at line 454 has `await execAsync(\`kill ${pids.join(' ')}\`)` with no error handling
3. Replace with individual process.kill calls wrapped in try/catch

**Current code:**
```typescript
} else {
  await execAsync(`kill ${pids.join(' ')}`);
}
```

**Fixed code:**
```typescript
} else {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited - that's fine
    }
  }
}
```

---

## Phase 4: Fix Windows taskkill Error Handling

**Goal:** Prevent cleanup abort when one process fails to kill

**File:** `src/services/worker-service.ts`

**What to do:**
1. Find the Windows taskkill loop in `cleanupOrphanedProcesses` (around line 444-452)
2. Wrap `execSync` in try/catch so one failure doesn't abort the loop

**Current code:**
```typescript
for (const pid of pids) {
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
    continue;
  }
  execSync(`taskkill /PID ${pid} /T /F`, { timeout: 60000, stdio: 'ignore' });
}
```

**Fixed code:**
```typescript
for (const pid of pids) {
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
    continue;
  }
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { timeout: 60000, stdio: 'ignore' });
  } catch {
    // Process may have already exited - continue cleanup
  }
}
```

---

## Phase 5: Use Readiness Endpoint for Health Checks

**Goal:** Ensure `waitForHealth` checks full initialization, not just HTTP server

**File:** `src/services/worker-service.ts`

**What to do:**
1. Find `waitForHealth` function (around line 61-68)
2. Change endpoint from `/api/health` to `/api/readiness`
3. `/api/readiness` returns 503 until background init completes, `/api/health` returns 200 immediately

**Current code:**
```typescript
async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortInUse(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
```

**Fixed code:**
```typescript
async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
```

---

## Phase 6: Build, Test, and Commit

**Goal:** Verify fixes work and commit changes

**Commands:**
```bash
npm run build-and-sync
```

**Commit message:**
```
fix: address critical error handling issues in worker lifecycle

- Fix waitForProcessesExit crash when child processes exit
- Add spawn pid validation before writing PID file
- Handle Unix kill errors in orphaned process cleanup
- Handle Windows taskkill errors in cleanup loop
- Use /api/readiness for health checks instead of /api/health

Fixes issues found in PR #458 review.
```

---

## Summary

| Phase | Priority | Description |
|-------|----------|-------------|
| 1 | CRITICAL | Fix `waitForProcessesExit` filter bug |
| 2 | CRITICAL | Validate `child.pid` after spawn |
| 3 | CRITICAL | Fix Unix kill error handling |
| 4 | HIGH | Fix Windows taskkill error handling |
| 5 | HIGH | Use readiness endpoint for health |
| 6 | - | Build and commit |

**Estimated changes:** ~30 lines modified in `worker-service.ts`
