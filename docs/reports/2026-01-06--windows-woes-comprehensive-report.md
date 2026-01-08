# Windows Woes: Comprehensive Report

**Date:** 2026-01-06
**Coverage:** October 2025 - January 2026
**Memory Sources:** 100+ observations from claude-mem

## Executive Summary

The claude-mem project has faced significant Windows platform challenges, requiring extensive architectural changes and ongoing maintenance. The issues fall into four major categories:

1. **Zombie Port Problem** - Bun's socket cleanup bug on Windows
2. **Console Window Popups** - PowerShell/cmd windows appearing during hook execution
3. **Process Management** - Orphaned processes, cleanup failures, multi-session conflicts
4. **Path & Shell Compatibility** - PowerShell escaping, Git Bash conflicts, PATH detection

## Timeline of Major Issues & Fixes

### Phase 1: Initial Windows Support (Oct-Nov 2025)

| Date | Issue | Fix |
|------|-------|-----|
| Oct 27 | Hardcoded Unix paths | Cross-platform path refactoring |
| Nov 5 | Windows installation failures | Smart caching installer created |
| Nov 6 | PM2 ENOENT bug | Released v5.1.1 with fix |
| Nov 11 | Worker crashes on Windows | Investigation started |

### Phase 2: Worker Reliability Crisis (Dec 2025)

| Date | Issue | Fix | PR/Version |
|------|-------|-----|------------|
| Dec 4 | Console windows appearing | Added `windowsHide` parameter | - |
| Dec 9 | Multiple Windows bugs | Released v7.0.4 | @kat-bell |
| Dec 13 | libuv crash from process.type hack | Removed workaround | v7.1.7 |
| Dec 15 | Console popups on Windows 11 | Investigation (Issues #304, #330) | - |
| Dec 16 | Zombie processes persist | Considered Bun self-executable | - |
| Dec 17 | **Comprehensive stabilization** | PR #378 merged | v7.3.7 |

### Phase 3: Ongoing Challenges (Dec 2025 - Jan 2026)

| Date | Issue | Status |
|------|-------|--------|
| Dec 27 | Multi-session hangs with libuv assertion failures | Investigated |
| Dec 28 | Lock acquisition ENOENT errors | PR #470 fixes |
| Dec 29 | Windows stability refactoring | PR #492 |
| Jan 4 | PowerShell `$_` escaping in Git Bash (Issue #517) | **NOT FIXED** |
| Jan 5 | Windows hooks IPC issues (Issue #555) | **OPEN** |

---

## Issue Category 1: Zombie Port Problem

### The Problem
Bun runtime has a known bug on Windows where socket handles aren't properly released when the worker process exits. This causes "zombie ports" that remain bound even after all processes terminate, requiring system reboot to clear.

### The Solution: Worker Wrapper Architecture

**Implemented:** December 17, 2025 (PR #372 by @ToxMox)

A two-tier process architecture was introduced:

```
ProcessManager
    └── worker-wrapper.cjs (no sockets, manages lifecycle)
            └── worker-service.cjs (HTTP server on port 37777)
                    ├── MCP server
                    └── ChromaSync
```

**How it works:**
1. `worker-wrapper.cjs` spawns as outer process with no socket bindings
2. Actual worker runs as child process with IPC communication
3. On restart/shutdown, wrapper uses `taskkill /T /F` to kill entire process tree
4. Wrapper exits itself - since it holds no sockets, port is properly released

**Files modified (14 files, +665/-249 lines):**
- `src/services/worker-wrapper.ts` (152 lines, new)
- `src/services/process/ProcessManager.ts`
- `src/services/worker-service.ts`
- All hook scripts
- Build system

### Known Limitation

**Issue:** The hooks don't set `CLAUDE_MEM_MANAGED=true` environment variable, so the managed restart code path (lines 314-330 of worker-service.ts) is never activated. Every session runs the "standalone Windows" code path which lacks proper serialization.

---

## Issue Category 2: Console Window Popups

### The Problem
Windows users on Windows 11 reported multiple PowerShell/cmd popup windows appearing during Claude Code usage, disrupting user input. Issue #367 specifically noted these popups were stealing keyboard focus.

### The Solution: Standardized windowsHide

**Implemented:** December 17, 2025 (PR #378)

- All `child_process.spawn()` calls now include `windowsHide: true`
- PowerShell spawning uses `Start-Process -WindowStyle Hidden`
- ChromaSync MCP transport includes windowsHide option

**Affected components:**
- ProcessManager subprocess spawning
- ChromaSync Python subprocess
- All hook executions

### Worker Logs Revealed Additional Issue

Worker logs showed failed orphaned process cleanup using Unix commands (`ps`, `grep`) that don't exist on Windows. This required implementing Windows-specific process enumeration using PowerShell's `Get-CimInstance`.

---

## Issue Category 3: Process Management

### 3.1 Orphaned Process Cleanup

**The Problem:** Child processes (chroma-mcp Python processes) accumulate over time, holding socket descriptors and preventing worker restart.

**The Solution (PR #378):**
```typescript
// Windows: Recursive process tree enumeration
const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' -and $_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
```

**Security:** Triple PID validation at lines 287, 306, 327 to prevent command injection.

### 3.2 Multi-Session Conflicts

**The Problem (Dec 27):** Running multiple concurrent Claude sessions causes the second session to hang indefinitely with:
- libuv assertion failure: `!(handle->flags & UV_HANDLE_CLOSING)`
- SessionStart hook error: "Worker failed to restart"

**Root Cause Analysis:**
1. SessionStart hook calls restart without locking mechanism
2. Two sessions simultaneously trigger `httpShutdown()`, `waitForPortFree()`, `spawn()`
3. `waitForPortFree()` polls for only 10 seconds (Windows TCP TIME_WAIT: 30-60s)
4. Child processes inherit socket descriptors, blocking port 37777
5. `cleanupOrphanedProcesses()` runs AFTER worker starts instead of during shutdown

**Proposed Fix:** File-based mutex to prevent concurrent restart operations.

### 3.3 Lock Acquisition ENOENT Errors

**The Problem (Dec 28):** On Windows, the `.claude-mem` directory can be in flux during filesystem operations, causing `worker.lock` file access to fail with ENOENT.

**The Solution (PR #470):**
```typescript
// Retry up to 3 times, creating DATA_DIR between attempts
for (let i = 0; i < 3; i++) {
  try {
    return await acquireLock();
  } catch (e) {
    if (e.code === 'ENOENT') {
      await mkdir(DATA_DIR, { recursive: true });
    }
  }
}
```

---

## Issue Category 4: Path & Shell Compatibility

### 4.1 PowerShell `$_` Variable Escaping (Issue #517)

**Status:** NOT FIXED as of v8.5.7

**The Problem:** When running in Git Bash or WSL, Bash interprets `$_` before PowerShell receives it. This affects:

- `cleanupOrphanedProcesses()` (lines 170-172)
- `getChildProcesses()` (lines 91-92)

**Current Code (problematic):**
```typescript
const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' ..."`;
```

**Recommended Fix:** Use WMIC instead:
```typescript
const cmd = `wmic process where "name like '%python%' and commandline like '%chroma-mcp%'" get processid /format:list`;
```

### 4.2 Bun PATH Detection

**The Problem:** Windows users with non-standard Bun installations get unhelpful error messages.

**The Solution (Dec 17):**
Enhanced `getBunPathOrThrow()` with Windows-specific troubleshooting:
- Verification command: `bun --version`
- PATH check for `%USERPROFILE%\.bun\bin`
- Reference to GitHub issue #371
- Link to troubleshooting docs

### 4.3 PowerShell String Escaping

**The Solution:** `escapePowerShellString()` function doubles single quotes for safety when constructing PowerShell commands.

---

## Timeout Adjustments

Windows requires longer timeouts due to slower filesystem and process operations:

| Setting | Unix | Windows | Multiplier |
|---------|------|---------|------------|
| Worker startup | 15s | 30s | 2.0x |
| Hook execution | 5s | 10s | 2.0x |
| Port free check | 5s | 10s | 2.0x |
| Process cleanup | 30s | 60s | 2.0x |

---

## CI/CD for Windows

**Implemented:** December 17, 2025

`.github/workflows/windows-ci.yml` tests:
- Worker process lifecycle (startup/shutdown)
- Rapid restart scenarios
- Bun PATH detection
- Port cleanup verification
- Zombie process detection

**Note:** Windows CI was later removed due to testing challenges.

---

## Currently Open Windows Issues

| Issue | Title | Severity |
|-------|-------|----------|
| #517 | PowerShell `$_` escaping in Git Bash | Medium |
| #555 | Windows hooks IPC false | High |
| #324 | Windows 11 64-bit system issues | Unknown |

---

## Key Contributors

- **@ToxMox** - Worker wrapper architecture (PR #372), zombie port fix
- **@kat-bell** - Windows plugin installation fixes (v7.0.4)
- **Claude Opus 4.5** - Co-authored many Windows stabilization commits

---

## Architectural Decisions

### Why Worker Wrapper?
The two-process architecture was chosen over alternatives like:
- Bun self-executable packaging (considered but not implemented)
- PM2 process management (replaced due to Windows issues)
- Native Node.js (abandoned due to windowsHide limitations with detached processes)

### Why PowerShell over cmd.exe?
PowerShell provides:
- `Get-CimInstance` for WMI process enumeration
- `-WindowStyle Hidden` for truly hidden windows
- Better handling of complex command strings

### Why Keep Windows Code?
December 20, 2025 decision documented:
- Active Windows users evidenced by bug reports
- 20+ Windows-specific commits with recent fixes
- Critical functionality that can't be removed
- Comprehensive documentation ensures maintainability

---

## Recommendations

1. **Implement file-based mutex** for worker restart serialization
2. **Fix Issue #517** by switching to WMIC or proper escaping
3. **Increase waitForPortFree timeout** to 60s for Windows TIME_WAIT
4. **Run cleanup BEFORE worker startup** instead of after
5. **Set CLAUDE_MEM_MANAGED=true** in hooks.json to activate managed mode
6. **Consider Windows ARM64** - currently uses x64 emulation

---

## References

### Key PRs
- PR #372: Worker wrapper architecture
- PR #377/#378: Comprehensive Windows stabilization
- PR #470: Lock acquisition retry
- PR #492: Worker service refactoring

### Key Versions
- v5.1.1: PM2 ENOENT fix
- v7.0.4: Windows installation fixes
- v7.1.7: libuv crash fix
- v7.3.7: Platform stabilization

### Documentation
- https://docs.claude-mem.ai/troubleshooting/windows-issues
- `docs/context/windows-code-evaluation.md`
- `docs/PM2-TO-BUN-MIGRATION.md`
