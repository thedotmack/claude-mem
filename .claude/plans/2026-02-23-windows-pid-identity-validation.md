# Implementation Plan: Windows PID Identity Validation for Orphaned Subprocess Cleanup

## Overview

Enable Windows subprocess cleanup that was previously skipped due to the absence of PID identity validation. The two call sites (crash-recovery in `worker-service.ts` and the orphan reaper in `ProcessRegistry.ts`) will use PowerShell `Get-CimInstance Win32_Process` to validate process CommandLine before killing, matching the safety guarantees already present on Unix.

## Requirements

- **Crash-recovery**: On Windows, query PowerShell for a stale PID's CommandLine, check if it contains `claude`, then kill it (same logic as Unix but different shell command)
- **Orphan reaper**: On Windows, use a single PowerShell batch query to find all `claude.*haiku|claude.*output-format` processes whose parent PID is dead, then kill them
- **Shared utility**: Extract PowerShell process querying into a reusable module
- **Error handling**: Fall back gracefully if PowerShell is unavailable
- **Testing**: TDD approach with vitest; mock `execSync`/`execAsync` for PowerShell commands

## Delivery Strategy

current-branch (main)

## Architecture Changes

- **New file**: `src/utils/windows-process.ts` -- PowerShell process query utilities
- **Modified file**: `src/services/worker-service.ts` (lines 308-311) -- Replace Windows skip with PowerShell identity validation
- **Modified file**: `src/services/worker/ProcessRegistry.ts` (`killSystemOrphans` function) -- Add Windows orphan detection
- **New file**: `tests/utils/windows-process.test.ts` -- Unit tests for the utility module

## Implementation Steps

### Phase 1: Shared Utility Module (RED then GREEN)

1. **Write tests for `getProcessCommandLine`** (File: `tests/utils/windows-process.test.ts`)
   - Action: Create test file with cases for:
     - Successful CommandLine retrieval (mock `execSync` returning PowerShell output like `"C:\node.exe" --claude --haiku ...`)
     - PID not found (mock `execSync` throwing -- process doesn't exist)
     - PowerShell not available (mock `execSync` throwing with ENOENT-like error)
     - Empty output (process exists but no CommandLine)
     - PID validation (non-integer, negative, zero -- should return `null` without shelling out)
     - Windows CRLF line ending handling
   - Why: TDD -- tests first
   - Dependencies: None
   - Risk: Low

2. **Write tests for `findOrphanedClaudeProcesses`** (File: `tests/utils/windows-process.test.ts`)
   - Action: Add test cases for the batch query function:
     - Returns PIDs of `claude.*haiku|claude.*output-format` processes whose parent is dead
     - Skips processes whose parent is alive
     - Handles empty output (no matching processes)
     - Handles PowerShell failure gracefully (returns empty array)
     - Parses multi-line PowerShell CSV/table output correctly
     - Validates parent-alive check via `isProcessAlive`
   - Why: TDD -- tests first
   - Dependencies: None
   - Risk: Low

3. **Write tests for `isProcessAlive`** (File: `tests/utils/windows-process.test.ts`)
   - Action: Add test cases for a helper that checks if a given PID still exists:
     - Returns `true` when `process.kill(pid, 0)` succeeds
     - Returns `false` when `process.kill(pid, 0)` throws ESRCH
     - Validates PID input (rejects non-integer, negative, zero)
   - Why: This replaces the Unix `ppid=1` orphan concept. On Windows, orphan = parent process is dead.
   - Dependencies: None
   - Risk: Low

4. **Implement `windows-process.ts` utility module** (File: `src/utils/windows-process.ts`)
   - Action: Create module with three exported functions:

   ```typescript
   /**
    * Get the CommandLine for a specific PID using PowerShell Get-CimInstance.
    * Returns null if the PID doesn't exist, PowerShell is unavailable,
    * or CommandLine cannot be determined.
    *
    * Uses execSync (blocking) because crash-recovery runs during startup
    * before the event loop is fully active, matching the Unix branch
    * which also uses execSync.
    */
   export function getProcessCommandLine(pid: number): string | null

   /**
    * Find Claude subprocess PIDs whose parent process is dead.
    * Uses a single PowerShell batch query with Get-CimInstance Win32_Process
    * to enumerate all claude-related processes, then filters for orphans
    * by checking if each parent PID is still alive.
    *
    * Returns array of orphaned PIDs to kill.
    */
   export async function findOrphanedClaudeProcesses(): Promise<number[]>

   /**
    * Check if a process with the given PID is still alive.
    * Uses process.kill(pid, 0) signal-zero check (works cross-platform).
    */
   export function isProcessAlive(pid: number): boolean
   ```

   - Implementation details:
     - `getProcessCommandLine`: Runs `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<PID>' | Select-Object -ExpandProperty CommandLine"` via `execSync` with `HOOK_TIMEOUTS.POWERSHELL_COMMAND` timeout. Returns trimmed stdout or null.
     - `findOrphanedClaudeProcesses`: Runs `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claude.*(haiku|output-format)' } | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation"` via `execAsync`. Parses CSV, checks each `ParentProcessId` with `isProcessAlive`, returns PIDs where parent is dead.
     - `isProcessAlive`: Wraps `process.kill(pid, 0)` in try/catch.
   - Why: Centralizes PowerShell interaction, reusable by both call sites, testable in isolation
   - Dependencies: Step 1 tests must exist (TDD)
   - Risk: Low

5. **Run tests -- verify GREEN** (Command: `npx vitest run tests/utils/windows-process.test.ts`)
   - Action: Ensure all tests pass
   - Dependencies: Steps 1-4
   - Risk: Low

### Phase 2: Crash-Recovery Integration (worker-service.ts)

6. **Write integration-level test for Windows crash-recovery path** (File: `tests/utils/windows-process.test.ts`)
   - Action: Add a describe block that tests the decision logic:
     - When `getProcessCommandLine(pid)` returns a string containing `'claude'`, the PID should be killed
     - When it returns a string NOT containing `'claude'`, the PID should NOT be killed (recycled PID)
     - When it returns `null`, the PID should NOT be killed (already dead or PowerShell unavailable)
   - Why: Tests the contract that `worker-service.ts` will rely on
   - Dependencies: Phase 1 complete
   - Risk: Low

7. **Modify worker-service.ts crash-recovery Windows branch** (File: `src/services/worker-service.ts`, lines 308-311)
   - Action: Replace the Windows skip block with:

   ```typescript
   if (isWindows) {
     // Windows: use PowerShell Get-CimInstance to validate PID identity
     const { getProcessCommandLine } = await import('../../utils/windows-process.js');
     const cmdline = getProcessCommandLine(pid);
     if (cmdline !== null && cmdline.includes('claude')) {
       process.kill(pid, 'SIGKILL');
       killedCount++;
       logger.info('SYSTEM', `Killed stale subprocess PID ${String(pid)} from session ${String(sessionDbId)}`);
     } else if (cmdline !== null) {
       logger.info('SYSTEM', `Skipping stale PID ${String(pid)} - recycled to unrelated process: ${cmdline.substring(0, 80)}`);
     } else {
       logger.info('SYSTEM', `Stale PID ${String(pid)} no longer exists or PowerShell unavailable`);
     }
   }
   ```

   - Why: Mirrors the Unix branch logic exactly but uses PowerShell instead of `ps`
   - Dependencies: Phase 1 complete
   - Risk: Low -- the `try/catch` block at line 323 already handles `process.kill` failures

### Phase 3: Orphan Reaper Integration (ProcessRegistry.ts)

8. **Modify `killSystemOrphans` in ProcessRegistry.ts** (File: `src/services/worker/ProcessRegistry.ts`, lines 139-168)
   - Action: Replace the early return for Windows with orphan detection:

   ```typescript
   async function killSystemOrphans(): Promise<number> {
     if (process.platform === 'win32') {
       // Windows: find Claude subprocesses whose parent died
       try {
         const { findOrphanedClaudeProcesses } = await import('../../utils/windows-process.js');
         const orphanPids = await findOrphanedClaudeProcesses();
         let killed = 0;
         for (const orphanPid of orphanPids) {
           logger.warn('PROCESS', `Killing system orphan PID ${String(orphanPid)} (Windows)`, { pid: orphanPid });
           try {
             process.kill(orphanPid, 'SIGKILL');
             killed++;
           } catch {
             // Already dead or permission denied
           }
         }
         return killed;
       } catch {
         return 0; // PowerShell unavailable or error
       }
     }

     // Unix: original ppid=1 logic unchanged
     try {
       const { stdout } = await execAsync(
         'ps -eo pid,ppid,args 2>/dev/null | grep -E "claude.*haiku|claude.*output-format" | grep -v grep'
       );
       // ... rest of existing Unix code ...
     }
   }
   ```

   - Why: Windows has no ppid=1 convention, but we can detect orphans by checking if the parent PID is dead
   - Dependencies: Phase 1 complete
   - Risk: Low -- wrapped in try/catch, falls back to returning 0

9. **Write tests for Windows orphan reaper path** (File: `tests/utils/windows-process.test.ts`)
   - Action: Add tests that verify the full flow:
     - `findOrphanedClaudeProcesses` returns correct PIDs when parent is dead
     - Returns empty array when all parents are alive
     - Returns empty array on PowerShell failure
   - Dependencies: Phase 1 complete
   - Risk: Low

### Phase 4: Verification and Cleanup

10. **Run full test suite** (Command: `npm test`)
    - Action: Ensure no regressions
    - Dependencies: All previous steps
    - Risk: Low

11. **Consider renaming wmic-parsing.test.ts** (File: `tests/infrastructure/wmic-parsing.test.ts`)
    - Action: The file already tests PowerShell parsing, not WMIC. Consider renaming to `powershell-parsing.test.ts` for clarity. This is optional cleanup.
    - Why: Consistency with the project's shift from WMIC to PowerShell
    - Dependencies: None
    - Risk: Low

## Testing Strategy

- **Unit tests** (`tests/utils/windows-process.test.ts`):
  - `getProcessCommandLine`: 6 test cases (success, PID not found, PowerShell unavailable, empty output, invalid PID, CRLF handling)
  - `findOrphanedClaudeProcesses`: 5 test cases (orphans found, no orphans, no matching processes, PowerShell failure, CSV parsing edge cases)
  - `isProcessAlive`: 3 test cases (alive, dead, invalid PID)
  - Decision logic: 3 test cases (matches claude, doesn't match, null)

- **Mocking approach**: All tests mock `execSync`/`execAsync` from `child_process` and `process.kill`. Tests also mock `process.platform` to `'win32'` using the `Object.defineProperty` pattern already established in the codebase (see `tests/infrastructure/wmic-parsing.test.ts` lines 176-183).

- **No integration/E2E tests**: These functions shell out to PowerShell which is only available on native Windows. The unit tests with mocks provide sufficient coverage.

## Risks & Mitigations

- **Risk**: PowerShell output format varies between versions (5.1 vs 7.x)
  - Mitigation: Use `Select-Object -ExpandProperty` for single-value queries (consistent format). Use `ConvertTo-Csv -NoTypeInformation` for structured output (consistent across versions).

- **Risk**: `Get-CimInstance Win32_Process` latency (~850ms) could slow crash-recovery startup
  - Mitigation: The query runs once per stale PID during crash recovery only (rare path). For the batch query in the reaper, a single query fetches all processes at once.

- **Risk**: `process.kill(pid, 'SIGKILL')` on Windows doesn't send SIGKILL (Windows has no signals)
  - Mitigation: Node.js on Windows translates `SIGKILL` to `TerminateProcess()` which is the desired behavior. Already used in the Unix branch.

- **Risk**: PowerShell not available on minimal Windows Server Core installations
  - Mitigation: All PowerShell calls are wrapped in try/catch. Falls back to current behavior (skip killing, log warning).

## Success Criteria

- [ ] `getProcessCommandLine` correctly queries PowerShell and returns CommandLine string or null
- [ ] `findOrphanedClaudeProcesses` batch-queries all Claude processes and filters for dead parents
- [ ] `isProcessAlive` correctly detects alive vs dead processes
- [ ] `worker-service.ts` Windows branch kills stale PIDs after identity validation (no longer skips)
- [ ] `ProcessRegistry.ts killSystemOrphans` detects and kills orphans on Windows (no longer returns 0)
- [ ] All error paths fall back gracefully without crashing
- [ ] Unix code paths are completely unchanged (no performance impact)
- [ ] All existing tests continue to pass
- [ ] New tests cover success, failure, and edge cases with 80%+ coverage on the new module
