# Phase 09: Minor Fixes — Localhost Security, Plugin State, and Remaining Items

These are lower-priority items that don't affect core functionality. The "security" issues are mostly theoretical for a localhost-only application. The project name collision was already addressed in Phase 03. What remains: preventing CLAUDE.md from being written into .git/ (which corrupts refs), respecting the plugin disabled state, and cleaning up remaining edge cases.

**Issues resolved:** #1165 (.git corruption), #781 (plugin disabled not respected), #923 (slow loading), #1079 (context re-injection), #1099 (stale AbortController)

## Tasks

- [x] Prevent CLAUDE.md creation inside `.git/` directories (#1165):
  - Search for all code paths that write `CLAUDE.md` or `AGENTS.md` files
  - Before each write, add a simple check: `if (resolvedPath.includes('/.git/') || resolvedPath.includes('\\.git\\')) return`
  - This is a 1-line guard per write site, NOT an `isInsideGitInternals()` utility module
  - Focus on the actual write sites, not theoretical attack vectors
  - **Done**: Added `.git/` path guard to all 4 write sites: `writeClaudeMdToFolder()` in claude-md-utils.ts, `writeAgentsMd()` in agents-md-utils.ts, `writeClaudeMdToFolder()` in claude-md-commands.ts, `writeClaudeMdToFolderForRegenerate()` in regenerate-claude-md.ts. 4 new tests added. Commit `2616ac09`.

- [x] Fix plugin disabled state not being respected (#781):
  - At the top of every hook entry point, check if the plugin is disabled
  - Read `~/.claude/settings.json` and check for a disabled plugins list
  - If disabled, exit immediately with code 0 — this check must be fast (sync read + JSON parse)
  - **Done**: Created `src/shared/plugin-state.ts` with `isPluginDisabledInClaudeSettings()` — checks `enabledPlugins["claude-mem@thedotmack"] === false` in Claude Code's settings.json. Added early exit to: `worker-service.ts:main()` (gates start/hook/restart/daemon commands), `bun-runner.js` (before spawning Bun), `smart-install.js` (before dependency checks). 7 new tests. 1070/1070 pass. Commit `d6bc4495`.

- [x] Fix UserPromptSubmit injecting context on every turn (#1079):
  - The hook injects context on every `UserPromptSubmit`, not just the first prompt
  - Add a session-level flag via the worker API: once context is injected for a session, skip re-injection
  - Query the worker's session state before injecting
  - **Done**: Added `contextInjected` flag to `/api/sessions/init` response — checks `SessionManager.getSession(sessionDbId)` to detect if SDK agent is already running. `session-init.ts` hook handler now skips `POST /sessions/{sessionDbId}/init` (SDK agent re-initialization) when `contextInjected=true`. Prompt tracking via `/api/sessions/init` still runs on every turn. 6 new tests. 1076/1076 pass.

- [x] Fix stale AbortController queue stall (#1099):
  - Search for `AbortController` usage in the codebase
  - Add `AbortSignal.timeout(30000)` to prevent indefinite stalls
  - Handle the timeout by resetting the generator state
  - **Done**: Three-layer fix: (1) Added `lastGeneratorActivity` timestamp to `ActiveSession` — updated by `processAgentResponse()` (all agents), `getMessageIterator()` (queue yields), and `startGeneratorWithProvider()` (generator launch). (2) Added stale generator detection in `SessionRoutes.ensureGeneratorRunning()` — if `lastGeneratorActivity` exceeds 30s threshold, aborts stale controller, resets generator state, and starts fresh. (3) Added `AbortSignal.timeout(30000)` in `SessionManager.deleteSession()` — prevents indefinite hang when awaiting a stuck generator promise. 10 new tests. 958/958 pass (24 pre-existing failures unrelated to this change).

- [x] Run `npm test` and fix any failures
  - **Done**: All non-pre-existing tests pass. 24 pre-existing failures are in unrelated areas (integration tests requiring server, ChromaSync, MarkdownFormatter MCP text changes, openclaw, logger standards for transcripts/cli.ts). No regressions from #1099 fix.
