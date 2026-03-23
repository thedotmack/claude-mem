# Implementation Plan: Fix 8 "Up Next" GitHub Issues

## Phase 0: Documentation Discovery (COMPLETE)

### Allowed APIs & Patterns

**ProcessManager.ts** (`src/services/infrastructure/ProcessManager.ts`):
- `spawnDaemon(scriptPath, port, extraEnv?)` — returns `number | undefined`
- Windows branch: lines 638-663, uses `execSync(powershell ...)` with `Start-Process`
- Unix branch: lines 666-700, uses `child_process.spawn()` with `{detached: true, stdio: 'ignore'}`
- `resolveWorkerRuntimePath()` — returns full path to bun/node exe (lines 80-124)

**bun-runner.js** (`plugin/scripts/bun-runner.js`):
- `findBun()` lines 49-80 — returns `'bun'` | full path | `null`
- `collectStdin()` lines 124-149 — 5s timeout on stdin buffering
- `IS_WINDOWS` constant available
- `spawnSync('where'/'which', ['bun'])` used for PATH lookup

**env-sanitizer.ts** (`src/supervisor/env-sanitizer.ts`):
- `ENV_PREFIXES = ['CLAUDECODE_', 'CLAUDE_CODE_']` — strips all matching vars
- `ENV_EXACT_MATCHES` Set — currently: CLAUDECODE, CLAUDE_CODE_SESSION, CLAUDE_CODE_ENTRYPOINT, MCP_SESSION_ID
- Logic: if key starts with prefix AND is NOT in exact matches, it's REMOVED

**worker-service.ts** (`src/services/worker-service.ts`):
- `isMainModule` guard at lines 1262-1272
- CommonJS: `require.main === module || !module.parent`
- ESM: `import.meta.url === 'file://${process.argv[1]}'` || `.endsWith('worker-service')`
- `ensureWorkerStarted(port)` at lines 960-1064 — dual-guard system

**process-registry.ts** (`src/supervisor/process-registry.ts`):
- `pruneDeadEntries()` lines 128-144 — only called from `initialize()`
- `isPidAlive(pid)` lines 28-39 — `process.kill(pid, 0)` with EPERM handling

**HealthMonitor.ts** (`src/services/infrastructure/HealthMonitor.ts`):
- `isPortInUse(port)` lines 40-49 — `fetch(/api/health)`, returns boolean

**hooks.json** (`plugin/hooks/hooks.json`):
- SessionStart hooks: 60s timeout
- SessionEnd hooks: 30s timeout

**Path normalization** (`src/shared/path-utils.ts:19-21`):
- `normalizePath(p)` — `p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')`

### Anti-Patterns to Avoid
- Do NOT use `AbortSignal.timeout()` in health checks — causes libuv assertion crash in Bun on Windows
- Do NOT return actual PID from Windows spawn — PowerShell `Start-Process` doesn't expose it
- Do NOT use `shell: true` in spawn on Windows unless absolutely needed (security risk)
- Do NOT strip `CLAUDE_CODE_GIT_BASH_PATH` — required by Claude Code for Git Bash on Windows

---

## Phase 1: Windows Path Spaces Fix (Issues #1453, #1445)

### What to implement
Replace the PowerShell `Start-Process` approach in `spawnDaemon()` with Node's `child_process.spawn()` using `{detached: true, windowsHide: true}`. Copy the Unix pattern from lines 688-700 of ProcessManager.ts.

### Files to modify
- `src/services/infrastructure/ProcessManager.ts` lines 638-663

### Implementation
Replace the Windows branch (lines 638-663) with:
```typescript
if (isWindows) {
  const runtimePath = resolveWorkerRuntimePath();
  if (!runtimePath) {
    logger.error('SYSTEM', 'Failed to locate Bun runtime for Windows worker spawn');
    return undefined;
  }

  const child = spawn(runtimePath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });

  if (child.pid === undefined) {
    logger.error('SYSTEM', 'Failed to spawn worker daemon on Windows', { runtimePath });
    return undefined;
  }

  child.unref();
  return child.pid;
}
```

### Verification checklist
- [ ] `spawnDaemon()` no longer uses `execSync` or PowerShell on Windows
- [ ] `windowsHide: true` is set
- [ ] `detached: true` is set
- [ ] Returns actual PID (not sentinel `0`)
- [ ] Existing tests pass: `npm test -- --grep ProcessManager`

### Anti-pattern guards
- Do NOT use `shell: true` — paths are passed as array args, no shell needed
- Do NOT use `AbortSignal.timeout()` anywhere in spawn logic

---

## Phase 2: Bun Runner findBun() Fix (Issue #1452)

### What to implement
Modify `findBun()` to parse `where bun` output on Windows, filter for `.exe` files, and skip `.cmd` shims.

### Files to modify
- `plugin/scripts/bun-runner.js` lines 49-62

### Implementation
Replace the PATH check section with:
```javascript
function findBun() {
  const pathCheck = spawnSync(IS_WINDOWS ? 'where' : 'which', ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS
  });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    if (IS_WINDOWS) {
      // Parse `where` output: multiple lines, one path per line
      // Prioritize .exe files over .cmd shims
      const paths = pathCheck.stdout.trim().split(/\r?\n/);
      const exePath = paths.find(p => p.toLowerCase().endsWith('.exe'));
      if (exePath) return exePath.trim();
      // If only .cmd shims found, fall through to hardcoded paths
    } else {
      return 'bun';
    }
  }

  // ... existing hardcoded path checks unchanged ...
```

### Documentation references
- `where` output format: one path per line on Windows
- npm shims are `.cmd` files at `AppData\Roaming\npm\bun.cmd`
- Real Bun is at `~/.bun/bin/bun.exe`

### Verification checklist
- [ ] `findBun()` returns `.exe` path when `where` finds both `.cmd` and `.exe`
- [ ] Falls through to hardcoded paths when only `.cmd` shims exist
- [ ] Unix behavior unchanged (still returns `'bun'`)
- [ ] Build succeeds: `npm run build-and-sync`

### Anti-pattern guards
- Do NOT add `shell: true` to the main `spawn()` call — only needed for `where`/`which`

---

## Phase 3: sanitizeEnv Whitelist Fix (Issue #1451)

### What to implement
Add `CLAUDE_CODE_GIT_BASH_PATH` to the `ENV_EXACT_MATCHES` set so it passes through sanitization. Use a "passthrough" approach rather than a full whitelist refactor — minimal change.

### Files to modify
- `src/supervisor/env-sanitizer.ts` line 3

### Implementation
Add to `ENV_EXACT_MATCHES`:
```typescript
export const ENV_EXACT_MATCHES = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'MCP_SESSION_ID',
]);
```

### Verification checklist
- [ ] `CLAUDE_CODE_GIT_BASH_PATH` survives `sanitizeEnv()` call
- [ ] Other `CLAUDE_CODE_*` vars are still stripped
- [ ] Tests pass: `npm test -- --grep sanitize`

### Anti-pattern guards
- Do NOT remove the prefix filtering — other `CLAUDE_CODE_*` vars must still be stripped
- Do NOT create a separate whitelist mechanism — the Set pattern already exists

---

## Phase 4: isMainModule Guard Fix (Issue #1450)

### What to implement
Fix the ESM branch of the `isMainModule` check to handle Windows+Bun URL format differences and the `.cjs` extension.

### Files to modify
- `src/services/worker-service.ts` lines 1263-1265

### Implementation
Replace the `isMainModule` guard:
```typescript
const isMainModule = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module || !module.parent
  : (() => {
      // Normalize both URLs for cross-platform comparison
      try {
        const metaPath = new URL(import.meta.url).pathname;
        const argvPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : '';
        if (metaPath === argvPath) return true;
      } catch { /* URL parsing failed, fall through */ }
      return process.argv[1]?.endsWith('worker-service') ||
             process.argv[1]?.endsWith('worker-service.cjs') ||
             process.argv[1]?.endsWith('worker-service.js');
    })();
```

### Documentation references
- `new URL().pathname` normalizes `file:///C:/path` to `/C:/path` on all platforms
- Copy URL normalization pattern from `src/shared/path-utils.ts:19-21`

### Verification checklist
- [ ] `isMainModule` resolves correctly with CommonJS require/module
- [ ] ESM branch handles `file:///C:/` (3 slashes) format
- [ ] `.endsWith()` checks include `.cjs` and `.js` extensions
- [ ] Tests pass: `npm test -- --grep worker`

### Anti-pattern guards
- Do NOT remove the CommonJS branch — still needed for Node.js environments
- Do NOT use string replacement for URL normalization — use `new URL()`

---

## Phase 5: Worker Lifecycle Fixes (Issues #1447, #1446, #1449)

### 5A: Startup Race Condition (#1447)

**What to implement**: The `ensureWorkerStarted()` function at line 1014 already checks `isPortInUse()` and waits for health. The issue is that TWO simultaneous invocations both pass the check. The daemon's `--daemon` guard (lines 1214-1236) has PID + port checks but there's a TOCTOU window.

**Files to modify**: `src/services/worker-service.ts` lines 1214-1236

**Implementation**: Add a file-based lock (using the existing lock pattern from lines 26-62) before spawning:
```typescript
case '--daemon':
default: {
  // GUARD 1: Refuse if PID file exists and process alive
  const existingPidInfo = readPidFile();
  if (existingPidInfo && isProcessAlive(existingPidInfo.pid)) {
    logger.info('SYSTEM', 'Worker already running (PID alive), refusing to start duplicate', {
      existingPid: existingPidInfo.pid
    });
    process.exit(0);
  }

  // GUARD 2: Refuse if port already bound
  if (await isPortInUse(port)) {
    logger.info('SYSTEM', 'Port already in use, refusing to start duplicate', { port });
    process.exit(0);
  }

  // GUARD 3: Atomic lock file to prevent TOCTOU race
  const lockPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), '.worker-start.lock');
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // fails if exists
  } catch {
    // Lock file exists — another process is starting
    // Check if the lock holder is still alive
    try {
      const holderPid = parseInt(readFileSync(lockPath, 'utf-8'), 10);
      if (isProcessAlive(holderPid)) {
        logger.info('SYSTEM', 'Another process is starting the worker', { holderPid });
        process.exit(0);
      }
      // Lock holder is dead — remove stale lock and take it
      unlinkSync(lockPath);
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    } catch {
      logger.info('SYSTEM', 'Could not acquire worker start lock, exiting');
      process.exit(0);
    }
  }

  // ... rest of daemon startup ...
  // Clean up lock after listen() succeeds (in WorkerService.start())
```

### 5B: Stale PIDs in supervisor.json (#1446)

**What to implement**: Call `pruneDeadEntries()` at the start of `ensureWorkerStarted()` — before relying on registry data.

**Files to modify**: `src/supervisor/process-registry.ts`

**Implementation**: Add a `pruneBeforeUse()` method or call `pruneDeadEntries()` from `ensureWorkerStarted()`. The existing `cleanStalePidFile()` call at line 962 already handles the worker PID file, but the supervisor registry needs explicit pruning too:
```typescript
// In ensureWorkerStarted(), after cleanStalePidFile() call:
getSupervisor().getProcessRegistry().pruneDeadEntries();
```

### 5C: SessionEnd Hook Timeout (#1449)

**What to implement**: Reduce `collectStdin()` timeout from 5000ms to 500ms. The session-complete handler is a simple HTTP POST that doesn't need 5s of stdin buffering.

**Files to modify**: `plugin/scripts/bun-runner.js` line 143

**Implementation**:
```javascript
// Change timeout from 5000 to 500ms
setTimeout(() => {
  process.stdin.removeAllListeners();
  process.stdin.pause();
  resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
}, 500);
```

### Verification checklist
- [ ] Worker startup with simultaneous `start` commands: only one worker starts
- [ ] Stale PIDs in supervisor.json are cleaned on next startup
- [ ] SessionEnd hook completes within 30s timeout (should now finish in ~1-2s)
- [ ] Lock file is cleaned up after successful startup
- [ ] Tests pass: `npm test`

### Anti-pattern guards
- Do NOT use `AbortSignal.timeout()` in any health check code
- Do NOT reduce SessionEnd hook timeout below 30s — fix the startup overhead instead
- Do NOT remove the `collectStdin()` function entirely — other hooks may legitimately need stdin

---

## Phase 6: Final Verification

### Verification steps
1. Full test suite: `npm test`
2. Build: `npm run build-and-sync`
3. Grep for anti-patterns:
   - `grep -r "Start-Process" src/` — should find NO matches
   - `grep -r "AbortSignal.timeout" src/` — should find NO matches in health/spawn code
   - `grep -r "endsWith('worker-service')" src/` — should include `.cjs` variant
4. Review all changes against issue descriptions
5. Verify duplicate issues #1453 and #1445 are both addressed by Phase 1

### GitHub Issues Mapping
| Phase | Issues Fixed |
|-------|-------------|
| Phase 1 | #1453, #1445 (duplicate pair) |
| Phase 2 | #1452 |
| Phase 3 | #1451 |
| Phase 4 | #1450 |
| Phase 5A | #1447 |
| Phase 5B | #1446 |
| Phase 5C | #1449 |
