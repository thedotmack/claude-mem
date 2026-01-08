# Issue #602: PostToolUse Error - Worker Service Failed to Start (Windows)

**Report Date:** 2026-01-07
**Issue Author:** onurtirpan
**Issue Created:** 2026-01-07
**Labels:** bug
**Severity:** HIGH
**Priority:** P1 - Critical

---

## 1. Executive Summary

A Windows 11 user running Claude Code 0.2.76 with claude-mem v9.0.0 is experiencing complete plugin failure. The worker service cannot start during PostToolUse hook execution, resulting in long delays and multiple cascading errors. This is a systemic Windows platform compatibility issue that prevents the entire memory system from functioning.

### Key Symptoms
- "Plugin hook bun worker-service.cjs start failed to start: The operation was aborted"
- Multiple "Worker failed to start (health check timeout)" errors
- "Failed to start server. Is port 37777 in use?"
- "wmic is not recognized" - Windows command compatibility issue
- Database not initialized errors

### Impact
- **Complete loss of memory functionality** on Windows
- Long delays during Claude Code operations
- User workflow disruption

---

## 2. Problem Analysis

### 2.1 Error Chain Analysis

The reported errors form a cascade failure pattern:

```
1. PostToolUse hook triggered
   └── 2. worker-service.cjs start command executed
       └── 3. Bun spawns worker process
           └── 4. Worker startup timeout (operation aborted)
               └── 5. Health check fails repeatedly
                   └── 6. "Is port 37777 in use?" check fails
                       └── 7. "wmic is not recognized" - WMIC unavailable
                           └── 8. Database cannot initialize
                               └── 9. Plugin hook failure
```

### 2.2 Error Categories

| Error Type | Root Cause | Severity |
|------------|-----------|----------|
| "operation was aborted" | Hook timeout exceeded before worker ready | High |
| "health check timeout" | Worker startup takes too long on Windows | High |
| "Is port 37777 in use?" | Previous zombie process holding port | Medium |
| "wmic is not recognized" | WMIC deprecated/removed in Windows 11 | Critical |
| "Database not initialized" | Worker never reached ready state | Consequential |

---

## 3. Technical Details

### 3.1 Affected Components

| Component | File Path | Role |
|-----------|-----------|------|
| Hook Configuration | `plugin/hooks/hooks.json` | Defines PostToolUse command chain |
| Worker Service | `src/services/worker-service.ts` | Main worker orchestrator |
| Process Manager | `src/services/infrastructure/ProcessManager.ts` | Windows process enumeration via WMIC |
| Health Monitor | `src/services/infrastructure/HealthMonitor.ts` | Port and health check logic |
| Server | `src/services/server/Server.ts` | HTTP server on port 37777 |

### 3.2 Hook Configuration (hooks.json)

```json
{
  "PostToolUse": [{
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" start",
        "timeout": 60
      },
      {
        "type": "command",
        "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/save-hook.js\"",
        "timeout": 120
      }
    ]
  }]
}
```

The 60-second timeout for worker startup may be insufficient on Windows systems, especially during first-time initialization when database creation, Chroma vector store setup, and MCP server connection all must complete.

### 3.3 Platform Timeouts

Current timeout configuration in `src/shared/hook-constants.ts`:

```typescript
export const HOOK_TIMEOUTS = {
  DEFAULT: 300000,            // 5 minutes
  HEALTH_CHECK: 30000,        // 30 seconds
  WORKER_STARTUP_WAIT: 1000,
  WORKER_STARTUP_RETRIES: 300,
  PRE_RESTART_SETTLE_DELAY: 2000,
  WINDOWS_MULTIPLIER: 1.5     // Only 1.5x for Windows
} as const;
```

### 3.4 WMIC Dependency

The `ProcessManager.ts` uses WMIC for Windows process enumeration:

```typescript
// Line 91-92: getChildProcesses()
const cmd = `wmic process where "parentprocessid=${parentPid}" get processid /format:list`;

// Line 174: cleanupOrphanedProcesses()
const cmd = `wmic process where "name like '%python%' and commandline like '%chroma-mcp%'" get processid /format:list`;
```

**Critical Issue:** WMIC (Windows Management Instrumentation Command-line) has been deprecated since Windows 10 version 21H1 and is being removed in Windows 11. Users with clean Windows 11 installations may not have WMIC available.

---

## 4. Impact Assessment

### 4.1 User Impact

| Impact Category | Description |
|-----------------|-------------|
| Functionality | Complete loss of memory features on Windows |
| Performance | Long delays during Claude Code operations (60s+ timeouts) |
| User Experience | Error messages displayed, interrupted workflows |
| Data | No observations being saved, no context injection |

### 4.2 Scope

- **Affected Platform:** Windows 11 (Build 26100+)
- **Affected Shell:** PowerShell 7
- **Affected Version:** claude-mem 9.0.0
- **Claude Code Version:** 0.2.76
- **Estimated User Base:** All Windows 11 users with modern builds

### 4.3 Related Issues

| Issue | Title | Status | Relationship |
|-------|-------|--------|--------------|
| #517 | PowerShell `$_` escaping in Git Bash | Fixed (v9.0.0) | Same component (ProcessManager) |
| #555 | Windows hooks IPC issues | Open | Related Windows hook execution |
| #324 | Windows 11 64-bit system issues | Open | Same platform |

---

## 5. Root Cause Analysis

### 5.1 Primary Root Cause: WMIC Deprecation

WMIC is no longer available by default on Windows 11. When `cleanupOrphanedProcesses()` runs during worker initialization, it fails with "wmic is not recognized", causing the error to be swallowed but subsequent operations to fail.

**Evidence from ProcessManager.ts lines 167-218:**
```typescript
export async function cleanupOrphanedProcesses(): Promise<void> {
  const isWindows = process.platform === 'win32';
  // ...
  if (isWindows) {
    // Windows: Use WMIC to find chroma-mcp processes
    const cmd = `wmic process where "name like '%python%' and commandline like '%chroma-mcp%'" get processid /format:list`;
    const { stdout } = await execAsync(cmd, { timeout: 60000 });
    // ...
  }
}
```

### 5.2 Secondary Root Cause: Insufficient Timeouts

The hooks.json defines a 60-second timeout for worker startup, but on Windows:
1. WMIC command execution adds latency
2. Database initialization is slower on Windows file systems
3. MCP server initialization has a 5-minute timeout but the hook only waits 60 seconds
4. The WINDOWS_MULTIPLIER of 1.5x is applied inconsistently

### 5.3 Tertiary Root Cause: Zombie Port Issue

The "Is port 37777 in use?" error indicates previous worker processes may not have exited cleanly. This is a known issue (documented in `docs/reports/2026-01-06--windows-woes-comprehensive-report.md`) where Bun's socket cleanup bug on Windows leaves zombie ports.

### 5.4 Quaternary Root Cause: Error Cascade

When `cleanupOrphanedProcesses()` fails silently, the worker attempts to start but:
1. Previous zombie processes may still hold port 37777
2. Health checks fail because the new worker cannot bind
3. The "operation was aborted" error triggers when the 60s hook timeout expires
4. Database initialization never completes

---

## 6. Recommended Solutions

### 6.1 Immediate Fix: Replace WMIC with PowerShell CIM Cmdlets (P0)

**Replace WMIC commands with PowerShell Get-CimInstance:**

```typescript
// Before (ProcessManager.ts line 91-92)
const cmd = `wmic process where "parentprocessid=${parentPid}" get processid /format:list`;

// After
const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty ProcessId"`;
```

```typescript
// Before (ProcessManager.ts line 174)
const cmd = `wmic process where "name like '%python%' and commandline like '%chroma-mcp%'" get processid /format:list`;

// After
const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' -and $_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
```

**Note:** This reintroduces Issue #517 concerns about `$_` in Git Bash. Use proper escaping or run via Node.js `child_process.spawn` with `shell: false` and explicit `powershell.exe` path.

### 6.2 Alternative Fix: Use tasklist Command (P0)

A WMIC-free alternative using built-in Windows commands:

```typescript
// For process enumeration
const cmd = `tasklist /FI "IMAGENAME eq python*" /FO CSV /NH`;
// Parse CSV output to get PIDs
```

### 6.3 Increase Windows Timeouts (P1)

Update `plugin/hooks/hooks.json` to use longer Windows-appropriate timeouts:

```json
{
  "PostToolUse": [{
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" start",
        "timeout": 120
      }
    ]
  }]
}
```

Update `src/shared/hook-constants.ts`:

```typescript
export const HOOK_TIMEOUTS = {
  // ...
  WINDOWS_MULTIPLIER: 2.5  // Increase from 1.5 to 2.5
} as const;
```

### 6.4 Add WMIC Availability Detection (P1)

Add graceful fallback when WMIC is unavailable:

```typescript
async function isWmicAvailable(): Promise<boolean> {
  try {
    await execAsync('wmic os get caption', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function cleanupOrphanedProcesses(): Promise<void> {
  if (process.platform !== 'win32') {
    // Unix implementation
    return;
  }

  const useWmic = await isWmicAvailable();
  const cmd = useWmic
    ? `wmic process where "name like '%python%' ..." get processid /format:list`
    : `powershell -NoProfile -Command "Get-CimInstance Win32_Process | ..."`;

  // Continue with appropriate parser
}
```

### 6.5 Improve Port Cleanup on Windows (P2)

Ensure proper cleanup before worker restart:

```typescript
// Add to ProcessManager.ts
export async function forceReleasePort(port: number): Promise<void> {
  if (process.platform !== 'win32') return;

  try {
    // Find process using the port
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique"`
    );

    const pids = stdout.trim().split('\n').filter(p => p.trim());
    for (const pid of pids) {
      await forceKillProcess(parseInt(pid, 10));
    }
  } catch {
    // Port not in use or access denied
  }
}
```

### 6.6 Improve Error Messaging (P2)

Add user-friendly error messages with actionable guidance:

```typescript
// In HealthMonitor.ts
export async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  // ... existing logic ...

  if (!ready && process.platform === 'win32') {
    logger.warn('SYSTEM', 'Windows worker startup slow. Check:');
    logger.warn('SYSTEM', '  1. Is antivirus scanning the plugin folder?');
    logger.warn('SYSTEM', '  2. Is port 37777 blocked by firewall?');
    logger.warn('SYSTEM', '  3. Try: netstat -ano | findstr 37777');
  }

  return ready;
}
```

---

## 7. Priority/Severity Assessment

### 7.1 Severity Matrix

| Factor | Assessment | Score |
|--------|-----------|-------|
| User Impact | Complete feature loss | 5/5 |
| Frequency | Every operation on affected systems | 5/5 |
| Workaround Available | None | 5/5 |
| Data Loss Risk | No data saved | 4/5 |
| Affected Users | All Windows 11 users | 4/5 |

**Overall Severity: CRITICAL (23/25)**

### 7.2 Priority Recommendation

| Priority | Action | Timeline |
|----------|--------|----------|
| P0 | Replace WMIC with PowerShell CIM cmdlets | Immediate (v9.0.1) |
| P1 | Increase Windows timeouts | Same release |
| P1 | Add WMIC availability detection | Same release |
| P2 | Improve port cleanup | Next minor release |
| P2 | Better error messaging | Next minor release |

### 7.3 Testing Requirements

1. **Unit Tests:**
   - Test `cleanupOrphanedProcesses()` with mock WMIC failure
   - Test `getChildProcesses()` with PowerShell fallback
   - Test timeout multiplier application

2. **Integration Tests:**
   - Windows 11 clean install (no WMIC)
   - Windows 10 with WMIC available
   - Git Bash environment with PowerShell commands

3. **Manual Verification:**
   - Confirm worker starts successfully on Windows 11
   - Confirm health checks pass within timeout
   - Confirm orphaned process cleanup works

---

## 8. Files to Modify

| File | Change Required |
|------|-----------------|
| `src/services/infrastructure/ProcessManager.ts` | Replace WMIC with PowerShell or tasklist |
| `src/shared/hook-constants.ts` | Increase WINDOWS_MULTIPLIER |
| `plugin/hooks/hooks.json` | Increase worker start timeout |
| `src/services/infrastructure/HealthMonitor.ts` | Add Windows-specific error messages |
| `docs/public/troubleshooting.mdx` | Document Windows 11 requirements |

---

## 9. Appendix

### 9.1 Related Documentation

- `docs/reports/2026-01-06--windows-woes-comprehensive-report.md`
- `docs/reports/2026-01-04--issue-517-windows-powershell-analysis.md`
- `docs/reports/2026-01-05--issue-555-windows-hooks-ipc-false.md`

### 9.2 WMIC Deprecation Timeline

| Windows Version | WMIC Status |
|-----------------|-------------|
| Windows 10 (pre-21H1) | Available by default |
| Windows 10 21H1+ | Deprecated, feature on demand |
| Windows 11 (initial) | Available but deprecated |
| Windows 11 22H2+ | Being removed progressively |
| Windows 11 23H2+ | Not installed by default |

### 9.3 PowerShell Equivalent Commands

| WMIC Command | PowerShell Equivalent |
|--------------|----------------------|
| `wmic process list` | `Get-CimInstance Win32_Process` |
| `wmic process where "name='x'"` | `Get-CimInstance Win32_Process \| Where-Object { $_.Name -eq 'x' }` |
| `wmic process get processid` | `(Get-CimInstance Win32_Process).ProcessId` |

### 9.4 User Workaround (Temporary)

Until a fix is released, users can manually install WMIC:

1. Open Settings > Apps > Optional Features
2. Click "Add a feature"
3. Search for "WMIC (Windows Management Instrumentation Command-line)"
4. Install and restart terminal

**Note:** This is not a recommended long-term solution as WMIC will eventually be fully removed.

---

*Report generated by Claude Opus 4.5 for issue #602*
