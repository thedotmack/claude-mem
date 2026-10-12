# Phase 03: Windows Platform Hardening

This phase addresses the second-largest issue cluster: 12 Windows-specific bugs covering hook hangs, zombie ports/sockets, PowerShell quoting failures, CRLF shebang breakage, and process cleanup issues. Windows users represent a significant user segment, and these bugs make claude-mem essentially unusable on Windows for many users. The fixes are mostly platform-conditional code paths that need proper timeout handling, escaping, and process lifecycle management.

## Tasks

- [x] Fix Windows hook timeout and hang issues. Hooks can hang indefinitely on Windows because `AbortSignal.timeout()` crashes Bun with a libuv assertion and `Promise.race` fallbacks sometimes leak timers. To fix:
  - Read `src/shared/worker-utils.ts` to find all HTTP request functions (`fetchWithTimeout`, `workerHttpRequest`, etc.) and how they handle timeouts on Windows
  - Read `src/shared/hook-constants.ts` for `WINDOWS_MULTIPLIER` and timeout values
  - Read `plugin/scripts/bun-runner.js` (lines 124-149) for the stdin buffering timeout logic
  - Audit every `fetch()` call in hook code paths for proper timeout handling. Ensure ALL use `Promise.race` with `setTimeout` (not `AbortSignal.timeout`) on Windows
  - Add a hard process-level timeout to `bun-runner.js`: if the child Bun process hasn't exited within 30 seconds (configurable), kill it and exit with code 0 to prevent terminal tab accumulation
  - Ensure leaked `setTimeout` references are cleaned up via `clearTimeout` on success paths

- [x] Fix Windows zombie port cleanup timing. The worker's server shutdown leaves ports bound for several seconds on Windows due to TIME_WAIT, causing "EADDRINUSE" on restart. To fix:
  - Read `src/services/server/Server.ts` for the shutdown sequence and existing Windows delay logic (around lines 115-127, currently 500ms + 500ms = 1000ms total)
  - Read `src/services/infrastructure/GracefulShutdown.ts` for the full shutdown flow
  - Read `src/services/infrastructure/ProcessManager.ts` `waitForPortFree()` function
  - Increase Windows-specific port release delays: change from 500ms+500ms to 1500ms+1000ms (2.5s total). Windows TCP stack needs up to 4 seconds for TIME_WAIT on localhost
  - In `waitForPortFree()`, increase the Windows timeout from 3 seconds to 6 seconds (use the existing `getPlatformTimeout()` with `2.0x` multiplier)
  - Add a retry loop to port binding in `Server.ts` `listen()`: if `EADDRINUSE` on Windows, wait 2 seconds and retry up to 3 times before failing
  - **Done**: Increased Server.ts and GracefulShutdown.ts Windows delays from 500ms+500ms to 1500ms+1000ms (2.5s total). Increased PORT_IN_USE_WAIT from 3000ms to 6000ms (Windows gets 12s via 2.0x multiplier). Added EADDRINUSE retry loop (3 retries, 2s delay) to Server.ts listen(). Updated hook-constants test and added server EADDRINUSE test.

- [ ] Fix PowerShell quoting and escaping in process spawning. Windows daemon spawning uses PowerShell `Start-Process` which has different quoting rules than Unix shells. To fix:
  - Read `src/services/infrastructure/ProcessManager.ts` lines 624-700 for the `spawnDaemon()` Windows implementation
  - Read the PowerShell `Get-CimInstance` process enumeration code (around lines 185-212)
  - Audit all `execAsync()` and `spawnSync()` calls that construct PowerShell commands:
    - Paths with spaces must be double-quoted inside single-quoted PowerShell strings
    - Backslashes in paths need `\\\\` escaping for JSON serialization, but NOT for PowerShell direct invocation
    - Dollar signs in paths (e.g., `$HOME`) must be escaped or wrapped in single quotes to prevent PowerShell variable expansion
  - Review `src/services/integrations/CursorHooksInstaller.ts` lines 322-333 for hook command generation — the `escapedBunPath.replace(/\\/g, '\\\\')` pattern is correct for JSON but verify it doesn't double-escape when read back
  - Add a `escapeForPowerShell(path: string)` utility in `src/utils/` if one doesn't exist, and use it consistently

- [ ] Fix CRLF shebang issues for Windows Git checkouts. When Git on Windows checks out files with `autocrlf=true`, shebangs get `\r\n` line endings which break script execution. To fix:
  - Check if a `.gitattributes` file exists at the repo root. If not, create one
  - Add entries to ensure shell scripts and JavaScript entry points use LF line endings:
    ```
    *.sh text eol=lf
    *.js text eol=lf
    plugin/scripts/*.js text eol=lf
    plugin/scripts/*.cjs text eol=lf
    install/public/*.sh text eol=lf
    ```
  - Read `plugin/scripts/bun-runner.js` line 1 — if it has a shebang, verify it uses LF
  - Check `plugin/hooks/hooks.json` — JSON files should also use LF to prevent parsing issues with `\r` in string values

- [ ] Fix Windows process enumeration edge cases in `ProcessManager.ts`:
  - Read `src/services/infrastructure/ProcessManager.ts` for `getChildProcesses()` (around line 185) and `cleanupOrphanedProcesses()` (around line 314)
  - The current implementation uses `Get-CimInstance Win32_Process -Filter` with WQL LIKE clauses. Edge cases to handle:
    - Processes with very long command lines (>8000 chars) — WQL truncates CommandLine. Add a fallback using `wmic process` if `Get-CimInstance` returns no results
    - `Get-CimInstance` can fail with "Access denied" for system processes — wrap in try-catch at the PowerShell level
    - The `taskkill /PID /T /F` command can fail silently if the process tree has already exited — check exit code and suppress the error
  - Add a `isProcessAlive(pid: number)` utility that works cross-platform: `process.kill(pid, 0)` on Unix, `tasklist /FI "PID eq ${pid}"` on Windows

- [ ] Write tests for Windows-specific fixes:
  - Find the existing test directory structure and conventions (search for `*.test.ts`)
  - Test `escapeForPowerShell()`: paths with spaces, dollar signs, backslashes, Unicode characters
  - Test port retry logic: mock `EADDRINUSE` error, verify retry with delay, verify success after port freed
  - Test process-level timeout in bun-runner: mock a hung child process, verify it's killed after timeout
  - Mock tests should work on all platforms (don't require actual Windows to run)

- [ ] Run build and verify:
  - Run `npm run build-and-sync`
  - Run the test suite and fix any failures
  - Verify `.gitattributes` is properly committed
  - Grep the built output for any remaining Windows-unsafe patterns (unescaped `$` in PowerShell strings, missing timeout fallbacks)
