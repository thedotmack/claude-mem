# Issue #517 Analysis: Windows PowerShell Escaping in cleanupOrphanedProcesses()

**Date:** 2026-01-04
**Version Analyzed:** 8.5.7
**Status:** NOT FIXED - Issue still present

## Summary

The reported issue involves PowerShell's `$_` variable being interpreted by Bash before PowerShell receives it when running in Git Bash or WSL environments on Windows. This causes `cleanupOrphanedProcesses()` to fail during worker initialization.

## Current State

The `cleanupOrphanedProcesses()` function is located in:
- **File:** `/Users/alexnewman/Scripts/claude-mem/src/services/infrastructure/ProcessManager.ts`
- **Lines:** 164-251

### Problematic Code (Lines 170-172)

```typescript
if (isWindows) {
  // Windows: Use PowerShell Get-CimInstance to find chroma-mcp processes
  const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' -and $_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
  const { stdout } = await execAsync(cmd, { timeout: 60000 });
```

The `$_.Name` and `$_.CommandLine` contain `$_` which is a special variable in both PowerShell and Bash. When this command string is executed via Node.js `child_process.exec()` in a Git Bash or WSL environment, Bash may interpret `$_` as its own special variable (the last argument of the previous command) before passing it to PowerShell.

### Additional Occurrence (Lines 91-92)

A similar issue exists in `getChildProcesses()`:

```typescript
const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty ProcessId"`;
```

## Error Handling Analysis

Both functions have try-catch blocks with non-blocking error handling:
- Line 208-212: `cleanupOrphanedProcesses()` catches errors and logs a warning, then returns
- Line 98-102: `getChildProcesses()` catches errors and logs a warning, returning empty array

While this prevents worker initialization from crashing, it means orphaned process cleanup silently fails on affected Windows environments.

## Recommended Fix

Replace PowerShell commands with WMIC (Windows Management Instrumentation Command-line), which does not use `$_` syntax:

### For cleanupOrphanedProcesses() (Line 171):

**Current:**
```typescript
const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' -and $_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
```

**Recommended:**
```typescript
const cmd = `wmic process where "name like '%python%' and commandline like '%chroma-mcp%'" get processid /format:list`;
```

### For getChildProcesses() (Line 91):

**Current:**
```typescript
const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty ProcessId"`;
```

**Recommended:**
```typescript
const cmd = `wmic process where "parentprocessid=${parentPid}" get processid /format:list`;
```

### Implementation Notes

1. WMIC output format differs from PowerShell - parse `ProcessId=12345` format
2. WMIC is deprecated in newer Windows versions but still widely available
3. Alternative: Use PowerShell with proper escaping (`$$_` or `\$_` depending on context)
4. Consider using `powershell -NoProfile -NonInteractive` flags for faster execution

## Impact Assessment

- **Severity:** Medium - orphaned process cleanup fails silently
- **Scope:** Windows users running in Git Bash, WSL, or mixed shell environments
- **Workaround:** None currently - users must manually kill orphaned chroma-mcp processes

## Files to Modify

1. `/src/services/infrastructure/ProcessManager.ts` (lines 91-92, 171-172)
