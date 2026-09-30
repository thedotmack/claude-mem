# Phase 06: Windows Platform Support — Fixing Core Platform Bugs

Windows support is broken across ~20 issues. The highest-impact fixes: WMIC removed in Win11 25H2+ breaks orphan reaper, PowerShell syntax errors, uvx.cmd spawn needs `shell: true`, FTS5 may not work in Bun on Windows. Focus on the fixes that unblock the most users.

**Issues resolved:** #785 (WMIC removal), #1024 (PowerShell syntax), #1190, #1192, #1199 (uvx spawn), #791 (FTS5), #807, #1139 (worker spawn), #1048 (console windows), #1062 (Git Bash)

## Root Cause Validation

**uvx.cmd spawn** — PARTIALLY FIXED: `ChromaMcpManager.ts` line 106 already uses `uvx.cmd` on Windows. However, `StdioClientTransport` uses `spawn()` internally which may not resolve `.cmd` files without `shell: true`. Need to verify if the MCP SDK's `StdioClientTransport` supports a `shell` option.

**WMIC removal** — All `wmic` usage must be replaced. This is a real platform regression in Win11 25H2+.

## Tasks

- [x] Fix uvx.cmd spawn on Windows:
  - In `ChromaMcpManager.ts`, the `StdioClientTransport` on line 113-118 uses `command: uvxCommand` which is `'uvx.cmd'` on Windows
  - Check if `StdioClientTransport` supports `shell: true` in its options — if so, set it on Windows
  - If not, resolve the full path to `uvx.cmd` using `which` or `where` and pass the absolute path
  - Also test: does just `'uvx'` (without `.cmd`) work on Windows when `shell: true` is set? If so, simplify
  - **DONE:** MCP SDK v1.26.0 does NOT support `shell: true`. Fixed by routing through `cmd.exe /c uvx` on Windows, which handles .cmd extension resolution and PATH lookup natively. Simplifies from `uvx.cmd` to just `uvx` since cmd.exe resolves it.

- [x] Replace all WMIC usage with PowerShell/tasklist equivalents:
  - Search for `wmic` across the entire codebase: focus on `src/services/infrastructure/ProcessManager.ts`
  - Replace `wmic process` with `tasklist /FO CSV /NH` for process listing
  - Replace `wmic process ... call terminate` with `taskkill /PID <pid> /T /F`
  - Use `tasklist.exe` and `taskkill.exe` directly (always in PATH) instead of PowerShell where possible — fixes Git Bash compatibility (#1062) as a side effect
  - Add `windowsHide: true` to ALL `exec`/`spawn` calls on Windows to prevent console window popups (#1048)
  - **DONE:** No `wmic` usage found in codebase (already replaced in prior work). `taskkill` was already in use for process killing. Added `windowsHide: true` to all 7 exec/execSync/execAsync calls that were missing it: `lookupBinaryInPath`, `getChildProcesses`, `cleanupOrphanedProcesses` (query + kill), `aggressiveStartupCleanup` (query + kill), and `forceKillProcess`. Updated WMIC sentinel comments.

- [x] Fix PowerShell syntax errors in orphan reaper (#1024):
  - In `ProcessManager.ts`, find the orphan process cleanup function
  - Replace any `$_` pipeline syntax with explicit `tasklist` + CSV parsing
  - This is a complete rewrite of the Windows branch of the orphan reaper to use `tasklist /FO CSV` instead of PowerShell pipelines
  - **DONE:** Replaced `Where-Object { $_ }` pipelines with WQL `-Filter` server-side filtering in all three functions: `getChildProcesses()`, `cleanupOrphanedProcesses()`, and `aggressiveStartupCleanup()`. WQL `-Filter` eliminates `$_` entirely (fixes Git Bash `$_` interpretation #1062 and PowerShell syntax errors #1024). Note: `tasklist /FO CSV` cannot do command-line or parent-PID filtering, so PowerShell `Get-CimInstance` with WQL is the correct WMIC-free approach for these queries.

- [x] Fix FTS5 search on Windows (#791):
  - Search for FTS5 usage in `src/services/sqlite/`
  - Check if `bun:sqlite` on Windows supports FTS5 — add a runtime check on startup
  - If FTS5 is unavailable, fall back to `LIKE` queries (this is the SQLite strategy, not Chroma — still functional)
  - **DONE:** Added `isFts5Available()` runtime probe (creates+drops temp FTS5 table) in `SessionSearch.ts`. FTS5 creation in `ensureFTSTables()` now skips gracefully when unavailable. Added try/catch guards around FTS5 table/trigger creation in `migrations.ts` (migration006), `migrations/runner.ts`, and `SessionStore.ts`. Search degrades to ChromaDB (vector) and LIKE queries (structured filters) — both unaffected by FTS5 absence.

- [x] Run `npm test` and fix any failures
  - **DONE:** All 69 ProcessManager tests pass. All 151 SQLite/search tests pass. One pre-existing failure in `logger-usage-standards.test.ts` about `console.log` in `src/services/transcripts/cli.ts` — confirmed pre-existing (identical failure on clean branch before changes).
