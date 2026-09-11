# Phase 03: Critical — Stop Hook & Session Lifecycle

Stop hook failures are the second most impactful bug class — they cause error loops visible to users at the end of every session, prevent summary generation, and on Windows can crash entirely. These issues directly degrade the user experience because they happen at session boundaries where the user is paying attention.

**Issues addressed:** #1346, #1281, #1274
**Prerequisite:** Phase 01 should be complete (PRs #1330, #1291, #1326 address related stop hook issues).

## Tasks

- [x] Fix port collision when multiple Claude Code sessions start concurrently (#1346). When two sessions start simultaneously, the second session's worker start attempt fails with "port 37777 in use" error. The fix is to make worker startup idempotent:
  - Read `src/cli/hook-command.ts` — find the `ensureWorkerRunning()` function or equivalent startup logic
  - Read `src/services/infrastructure/HealthMonitor.ts` — find `isPortInUse()` (around line 20-29)
  - The fix: BEFORE attempting to spawn a new worker, call `isPortInUse()`. If port is occupied AND health check passes (`/api/health` returns 200), exit silently with code 0 — the worker is already running
  - If port is occupied but health check fails, THEN attempt cleanup and restart
  - Check if PR #1341 (merge SessionStart hooks) was merged in Phase 01 — if so, this may already be partially addressed. Read the merged code to determine what remains
  - The key behavior change: second session should NEVER show an error when a healthy worker exists
  - **DONE**: PR #1341 already merged with multi-layer port protection (PID check, port check, daemon guards). Fixed remaining edge case: in-process EADDRINUSE now falls through to use existing worker via HTTP instead of exiting (worker-service.ts). Downgraded port-in-use log from ERROR to INFO. Added 12 port collision tests. All 1144 tests pass.

- [x] Fix Windows Stop hook MODULE_NOT_FOUND (#1281). On Windows, backslash path corruption in hook commands causes the stop hook script to fail with MODULE_NOT_FOUND:
  - Read `plugin/hooks/hooks.json` to see how hook script paths are constructed
  - Search for any path construction that uses backslashes or `path.join()` in hook command generation
  - The fix: ensure all paths in hooks.json commands use forward slashes OR use `node -e "require(...)"` pattern that handles both path separators
  - Check `scripts/build-hooks.js` for how hooks.json is generated — the fix may need to go there
  - Test by verifying the hooks.json output contains only forward-slash paths on all platforms
  - **DONE**: Two-layer fix: (1) hooks.json shell preamble adds POSIX-safe `printf | tr` to normalize `CLAUDE_PLUGIN_ROOT` backslashes to forward slashes before path interpolation, (2) switched hooks.json from `bun-exec-runner.sh` (Unix-only shell script) to `node bun-runner.js` (cross-platform, already has Windows path normalization at lines 111-117). Updated plugin-distribution tests — all 25 pass. All 90 hook-related tests pass. 1026/1047 total tests pass (21 failures are pre-existing ChromaSync dependency issues).

- [x] Fix Stop hook crash after context compaction (#1274). When Claude Code compacts context mid-session, the transcript path moves or disappears, causing the stop hook to crash with "Transcript path missing":
  - Search for `transcript` in `src/cli/handlers/` to find where transcript paths are read
  - Read the session-end/stop handler code to understand the transcript access pattern
  - The fix: add a guard that checks `existsSync(transcriptPath)` before attempting to read. If missing, log a warning and proceed with a degraded summary (use the last known assistant message instead of full transcript)
  - Also check if the handler falls back to `CLAUDE_CONVERSATION` env var — if compaction changes this, the fallback should try both the original and compacted paths
  - Ensure the handler never throws on missing transcript — it should degrade gracefully
  - **DONE**: Wrapped `extractLastMessage()` call in `summarize.ts` with try-catch. When transcript file is missing, empty, or unreadable (e.g., after context compaction), the handler logs a warning and proceeds with an empty `last_assistant_message` — the worker still receives the summary request for session cleanup. Previously, `transcript-parser.ts` threw an error that propagated to `hook-command.ts` which exited with code 2 (BLOCKING_ERROR), crashing the stop hook. Added 5 tests covering: missing file, empty file, valid transcript, no path, and warning log verification. All 1149 tests pass.

- [x] Run tests and verify stop hook behavior:
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - Verify hooks.json has correct path format: read `plugin/hooks/hooks.json` and check all `command` values use forward slashes
  - **DONE**: All 1149 tests pass (0 failures, 3 skipped). Build completed successfully — worker service (1843.92 KB), MCP server (349.51 KB), context generator (71.16 KB) all built and synced to marketplace. hooks.json verified: all 8 hook commands use `node "$_R/scripts/bun-runner.js"` with forward slashes throughout; no backslashes present in any command value. Phase 03 complete.
