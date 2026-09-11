# Phase 02: Critical — Process & Resource Stability

These are the highest-severity bugs in the project: runaway CPU, unbounded memory growth, and orphaned processes. Each one degrades the user's entire system, not just claude-mem. The root causes are well-understood from code analysis — HNSW index reconstruction on startup, unbounded pending_messages queue recovery, and saved_hook_context bloat in Claude Code session files.

**Issues addressed:** #1248, #1250, #1262, #1269, #1249

**Prerequisite:** Phase 01 must be complete (PR #1325 for zombie process fix should already be merged).

## Tasks

- [x] Fix chroma-mcp CPU runaway on Apple Silicon (#1248, #1250). The root cause is HNSW index reconstruction at startup when the Chroma collection has many documents. In `src/services/sync/ChromaMcpManager.ts`:
  > **Already implemented.** `CLAUDE_MEM_CHROMA_LAZY_INIT` (default `'true'`) and `CLAUDE_MEM_CHROMA_STARTUP_DELAY_MS` (default `'5000'`) exist in `SettingsDefaultsManager.ts`. The `worker-service.ts` `initializeBackground()` (lines 438-457) skips eager backfill when lazy init is enabled (default), and uses the startup delay when lazy init is disabled. `ChromaMcpManager` already lazy-connects on first `callTool()` use. Tests at `tests/shared/settings-defaults-manager.test.ts` cover these settings (35/35 pass).
  - Read `buildCommandArgs()` (around line 177-221) and the startup sequence
  - Add a `--hnsw-batch-size` argument to the uvx command args to limit HNSW index build parallelism. If chroma-mcp doesn't support this flag, the alternative is to add startup throttling
  - If the flag doesn't exist, implement a startup delay: in `src/services/worker-service.ts` `initializeBackground()` (line 377+), add a configurable delay before calling `chromaBackfill()` — use setting `CLAUDE_MEM_CHROMA_STARTUP_DELAY_MS` with default `'5000'`
  - Add the new setting to `src/shared/SettingsDefaultsManager.ts` defaults and interface
  - The goal is to prevent chroma-mcp from consuming 250-380% CPU for minutes after every session start. If throttling isn't feasible, add a `CLAUDE_MEM_CHROMA_LAZY_INIT` setting (default `'true'`) that defers Chroma initialization until first search request rather than eager startup
  - Search the codebase for existing lazy init patterns before implementing

- [x] Fix unbounded pending_messages queue growth (#1262). The `PendingMessageStore` in `src/services/sqlite/PendingMessageStore.ts` recovers ALL pending messages on startup, which can cause 100%+ CPU when hundreds of messages accumulated during crashes:
  > **Implemented.** Added `MAX_RECOVERY_BATCH_SIZE` (50) and `MAX_PENDING_AGE_MS` (24h) constants. `resetStaleProcessingMessages()` now deletes messages older than 24h. New `pruneExcessPendingMessages()` caps recovery to 50 most recent per session. Worker startup calls both. 8 new tests pass (13 total in file). Commit: dd29c043.
  - In `PendingMessageStore.ts`, find the recovery/startup path where stale messages are reset to `'pending'`
  - Add a `MAX_RECOVERY_BATCH_SIZE` constant (value: 50) — on startup, only recover the N most recent pending messages per session. Delete messages older than the batch limit
  - Add a `MAX_PENDING_AGE_MS` constant (value: `24 * 60 * 60 * 1000` — 24 hours) — delete pending messages older than this threshold during recovery instead of re-queuing them
  - In `resetStaleProcessingMessages()` (around line 160), add the age check: `DELETE FROM pending_messages WHERE created_at_epoch < ?` with `Date.now() - MAX_PENDING_AGE_MS`
  - Search for `SessionQueueProcessor` to ensure it handles the reduced queue gracefully

- [x] Fix CPU 100% from saved_hook_context bloat (#1269). Claude Code saves hook context to session files, and large observations cause the session file to grow, slowing all subsequent hook invocations:
  > **Implemented.** Added `MAX_CONTEXT_SIZE_BYTES` (50,000) constant in `src/cli/handlers/context.ts`. When `additionalContext` exceeds 50KB, it's truncated with `[Context truncated — exceeded 50KB limit. Use mem-search for full history.]` before returning `hookSpecificOutput`. The observation handler (`observation.ts`) confirmed not to return `hookSpecificOutput`, so no changes needed there. 7 new tests in `tests/hooks/context-truncation.test.ts` (all pass).
  - Search the codebase for `hookSpecificOutput`, `additionalContext`, and `saved_hook_context` to understand what data is being saved
  - In the SessionStart context handler (`src/cli/handlers/context.ts`), find where `additionalContext` is constructed
  - Add a size limit: if the context string exceeds 50KB, truncate it with a message like `[Context truncated — exceeded 50KB limit. Use mem-search for full history.]`
  - The truncation should happen BEFORE returning `hookSpecificOutput` so the bloated data never reaches Claude Code's session file
  - Also check if the observation handler (`src/cli/handlers/observation.ts`) contributes to saved context size — if it returns large `hookSpecificOutput`, apply the same truncation

- [x] Investigate bun SIGKILL in Claude Code sandbox (#1249). When Claude Code spawns node→bun as a grandchild process, the sandbox may SIGKILL the bun process:
  > **Investigated and fixed.** Root cause confirmed: spawn chain is `Claude Code → sh -c → node (bun-runner.js) → bun (worker-service.cjs)`, making bun a grandchild that gets SIGKILL'd by the sandbox. Fix: created `plugin/scripts/bun-exec-runner.sh` which finds bun and uses `exec` to replace the shell process, so bun becomes a direct child of Claude Code. Updated all 8 hook commands in `plugin/hooks/hooks.json` to use `bun-exec-runner.sh` instead of `node bun-runner.js`. On Linux, falls back to `node bun-runner.js` for stdin pipe compatibility (#646). `bun-runner.js` retained for backward compatibility. 25 distribution tests pass including 7 new tests for the fix. Full suite: 1142 pass, 0 fail.
  - Read the worker startup code in `src/cli/hook-command.ts` to understand the spawn chain
  - Check `src/services/infrastructure/ProcessManager.ts` `resolveWorkerRuntimePath()` for how bun is resolved
  - The fix may be to ensure the worker is spawned as a direct child (not grandchild) OR to add `detached: true` to the spawn options
  - If `detached: true` is already used, check if the sandbox is killing based on process group. An alternative is to use `setsid` on Unix to create a new session
  - Document findings even if a complete fix isn't possible — this may require upstream Claude Code changes

- [x] Run tests and build to verify stability fixes:
  > **Verified.** `npm test`: 1132 pass, 3 skip, 0 fail across 65 files. `npm run build-and-sync`: all artifacts built successfully (worker-service 1843KB, mcp-server 350KB, context-generator 71KB, React viewer). Worker health check confirmed: `status: ok`, v10.5.5, initialized, MCP ready. No CPU spike observed.
  - Run `npm test` — all tests must pass
  - Run `npm run build-and-sync`
  - If chroma-mcp changes were made, verify with `curl http://localhost:37777/api/health` that the worker starts without CPU spike
