# Changelog

All notable changes to claude-mem.

## [v10.1.0] - 2026-02-16

## SessionStart System Message & Cleaner Defaults

### New Features

- **SessionStart `systemMessage` support** — Hooks can now display user-visible ANSI-colored messages directly in the CLI via a new `systemMessage` field on `HookResult`. The SessionStart hook uses this to render a colored timeline summary (separate from the markdown context injected for Claude), giving users an at-a-glance view of recent activity every time they start a session.

- **"View Observations Live" link** — Each session start now appends a clickable `http://localhost:{port}` URL so users can jump straight to the live observation viewer.

### Performance

- **Truly parallel context fetching** — The SessionStart handler now uses `Promise.all` to fetch both the markdown context (for Claude) and the ANSI-colored timeline (for user display) simultaneously, eliminating the serial fetch overhead.

### Defaults Changes

- **Cleaner out-of-box experience** — New installs now default to a streamlined context display:
  - Read tokens column: hidden (`CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: false`)
  - Work tokens column: hidden (`CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: false`)
  - Savings amount: hidden (`CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: false`)
  - Full observation expansion: disabled (`CLAUDE_MEM_CONTEXT_FULL_COUNT: 0`)
  - Savings percentage remains visible by default

  Existing users are unaffected — your `~/.claude-mem/settings.json` overrides these defaults.

### Technical Details

- Added `systemMessage?: string` to `HookResult` interface (`src/cli/types.ts`)
- Claude Code adapter now forwards `systemMessage` in hook output (`src/cli/adapters/claude-code.ts`)
- Context handler refactored for parallel fetch with graceful fallback (`src/cli/handlers/context.ts`)
- Default settings tuned in `SettingsDefaultsManager` (`src/shared/SettingsDefaultsManager.ts`)

## [v10.0.8] - 2026-02-16

## Bug Fixes

### Orphaned Subprocess Cleanup
- Add explicit subprocess cleanup after SDK query loop using existing `ProcessRegistry` infrastructure (`getProcessBySession` + `ensureProcessExit`), preventing orphaned Claude subprocesses from accumulating
- Closes #1010, #1089, #1090, #1068

### Chroma Binary Resolution
- Replace `npx chroma run` with absolute binary path resolution via `require.resolve`, falling back to `npx` with explicit `cwd` when the binary isn't found directly
- Closes #1120

### Cross-Platform Embedding Fix
- Remove `@chroma-core/default-embed` which pulled in `onnxruntime` + `sharp` native binaries that fail on many platforms
- Use WASM backend for Chroma embeddings, eliminating native binary compilation issues
- Closes #1104, #1105, #1110

## [v10.0.7] - 2026-02-14

## Chroma HTTP Server Architecture

- **Persistent HTTP server**: Switched from in-process Chroma to a persistent HTTP server managed by the new `ChromaServerManager` for better reliability and performance
- **Local embeddings**: Added `DefaultEmbeddingFunction` for local vector embeddings — no external API required
- **Pinned chromadb v3.2.2**: Fixed compatibility with v2 API heartbeat endpoint
- **Server lifecycle improvements**: Addressed PR review feedback for proper start/stop/health check handling

## Bug Fixes

- Fixed SDK spawn failures and sharp native binary crashes
- Added `plugin.json` to root `.claude-plugin` directory for proper plugin structure
- Removed duplicate else block from merge artifact

## Infrastructure

- Added multi-tenancy support for claude-mem Pro
- Updated OpenClaw install URLs to `install.cmem.ai`
- Added Vercel deploy workflow for install scripts
- Added `.claude/plans` and `.claude/worktrees` to `.gitignore`

## [v10.0.6] - 2026-02-13

## Bug Fixes

- **OpenClaw: Fix MEMORY.md project query mismatch** — `syncMemoryToWorkspace` now includes both the base project name and the agent-scoped project name (e.g., both "openclaw" and "openclaw-main") when querying for context injection, ensuring the correct observations are pulled into MEMORY.md.

- **OpenClaw: Add feed botToken support for Telegram** — Feeds can now configure a dedicated `botToken` for direct Telegram message delivery, bypassing the OpenClaw gateway channel. This fixes scenarios where the gateway bot token couldn't be used for feed messages.

## Other

- Changed OpenClaw plugin kind from "integration" to "memory" for accuracy.

## [v10.0.5] - 2026-02-13

## OpenClaw Installer & Distribution

This release introduces the OpenClaw one-liner installer and fixes several OpenClaw plugin issues.

### New Features

- **OpenClaw Installer** (`openclaw/install.sh`): Full cross-platform installer script with `curl | bash` support
  - Platform detection (macOS, Linux, WSL)
  - Automatic dependency management (Bun, uv, Node.js)
  - Interactive AI provider setup with settings writer
  - OpenClaw gateway detection, plugin install, and memory slot configuration
  - Worker startup and health verification with rich diagnostics
  - TTY detection, `--provider`/`--api-key` CLI flags
  - Error recovery and upgrade handling for existing installations
  - jq/python3/node fallback chain for JSON config writing
- **Distribution readiness tests** (`openclaw/test-install.sh`): Comprehensive test suite for the installer
- **Enhanced `/api/health` endpoint**: Now returns version, uptime, workerPath, and AI status

### Bug Fixes

- Fix: use `event.prompt` instead of `ctx.sessionKey` for prompt storage in OpenClaw plugin
- Fix: detect both `openclaw` and `openclaw.mjs` binary names in gateway discovery
- Fix: pass file paths via env vars instead of bash interpolation in `node -e` calls
- Fix: handle stale plugin config that blocks OpenClaw CLI during reinstall
- Fix: remove stale memory slot reference during reinstall cleanup
- Fix: remove opinionated filters from OpenClaw plugin

## [v10.0.4] - 2026-02-12

## Revert: v10.0.3 chroma-mcp spawn storm fix

v10.0.3 introduced regressions. This release reverts the codebase to the stable v10.0.2 state.

### What was reverted

- Connection mutex via promise memoization
- Pre-spawn process count guard
- Hardened `close()` with try-finally + Unix `pkill -P` fallback
- Count-based orphan reaper in `ProcessManager`
- Circuit breaker (3 failures → 60s cooldown)
- `etime`-based sorting for process guards

### Files restored to v10.0.2

- `src/services/sync/ChromaSync.ts`
- `src/services/infrastructure/GracefulShutdown.ts`
- `src/services/infrastructure/ProcessManager.ts`
- `src/services/worker-service.ts`
- `src/services/worker/ProcessRegistry.ts`
- `tests/infrastructure/process-manager.test.ts`
- `tests/integration/chroma-vector-sync.test.ts`

## [v10.0.3] - 2026-02-11

## Fix: Prevent chroma-mcp spawn storm (PR #1065)

Fixes a critical bug where killing the worker daemon during active sessions caused **641 chroma-mcp Python processes** to spawn in ~5 minutes, consuming 75%+ CPU and ~64GB virtual memory.

### Root Cause

`ChromaSync.ensureConnection()` had no connection mutex. Concurrent fire-and-forget `syncObservation()` calls from multiple sessions raced through the check-then-act guard, each spawning a chroma-mcp subprocess via `StdioClientTransport`. Error-driven reconnection created a positive feedback loop.

### 5-Layer Defense

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **0** | Connection mutex via promise memoization | Coalesces concurrent callers onto a single spawn attempt |
| **1** | Pre-spawn process count guard (`execFileSync('ps')`) | Kills excess chroma-mcp processes before spawning new ones |
| **2** | Hardened `close()` with try-finally + Unix `pkill -P` fallback | Guarantees state reset even on error, kills orphaned children |
| **3** | Count-based orphan reaper in `ProcessManager` | Kills by count (not age), catches spawn storms where all processes are young |
| **4** | Circuit breaker (3 failures → 60s cooldown) | Stops error-driven reconnection positive feedback loop |

### Additional Fix

- Process guards now use `etime`-based sorting instead of PID ordering for reliable age determination (PIDs wrap and don't guarantee ordering)

### Testing

- 16 new tests for mutex, circuit breaker, close() hardening, and count guard
- All tests pass (947 pass, 3 skip)

Closes #1063, closes #695. Relates to #1010, #707.

**Contributors:** @rodboev

## [v10.0.2] - 2026-02-11

## Bug Fixes

- **Prevent daemon silent death from SIGHUP + unhandled errors** — Worker process could silently die when receiving SIGHUP signals or encountering unhandled errors, leaving hooks without a backend. Now properly handles these signals and prevents silent crashes.
- **Hook resilience and worker lifecycle improvements** — Comprehensive fixes for hook command error classification, addressing issues #957, #923, #984, #987, and #1042. Hooks now correctly distinguish between worker unavailability errors and other failures.
- **Clarify TypeError order dependency in error classifier** — Fixed error classification logic to properly handle TypeError ordering edge cases.

## New Features

- **Project-scoped statusline counter utility** — Added `statusline-counts.js` for tracking observation counts per project in the Claude Code status line.

## Internal

- Added test coverage for hook command error classification and process manager
- Worker service and MCP server lifecycle improvements
- Process manager enhancements for better cross-platform stability

### Contributors
- @rodboev — Hook resilience and worker lifecycle fixes (PR #1056)

## [v10.0.1] - 2026-02-11

## What's Changed

### OpenClaw Observation Feed
- Enabled SSE observation feed for OpenClaw agent sessions, allowing real-time streaming of observations to connected OpenClaw clients
- Fixed `ObservationSSEPayload.project` type to be nullable, preventing type errors when project context is unavailable
- Added `EnvManager` support for OpenClaw environment configuration

### Build Artifacts
- Rebuilt worker service and MCP server with latest changes

## [v10.0.0] - 2026-02-11

## OpenClaw Plugin — Persistent Memory for OpenClaw Agents

Claude-mem now has an official [OpenClaw](https://openclaw.ai) plugin, bringing persistent memory to agents running on the OpenClaw gateway. This is a major milestone — claude-mem's memory system is no longer limited to Claude Code sessions.

### What It Does

The plugin bridges claude-mem's observation pipeline with OpenClaw's embedded runner (`pi-embedded`), which calls the Anthropic API directly without spawning a `claude` process. Three core capabilities:

1. **Observation Recording** — Captures every tool call from OpenClaw agents and sends it to the claude-mem worker for AI-powered compression and storage
2. **MEMORY.md Live Sync** — Writes a continuously-updated memory timeline to each agent's workspace, so agents start every session with full context from previous work
3. **Observation Feed** — Streams new observations to messaging channels (Telegram, Discord, Slack, Signal, WhatsApp, LINE) in real-time via SSE

### Quick Start

Add claude-mem to your OpenClaw gateway config:

```json
{
  "plugins": {
    "claude-mem": {
      "enabled": true,
      "config": {
        "project": "my-project",
        "syncMemoryFile": true,
        "observationFeed": {
          "enabled": true,
          "channel": "telegram",
          "to": "your-chat-id"
        }
      }
    }
  }
}
```

The claude-mem worker service must be running on the same machine (`localhost:37777`).

### Commands

- `/claude-mem-status` — Worker health check, active sessions, feed connection state
- `/claude-mem-feed` — Show/toggle observation feed status
- `/claude-mem-feed on|off` — Enable/disable feed

### How the Event Lifecycle Works

```
OpenClaw Gateway
  ├── session_start ──────────→ Init claude-mem session
  ├── before_agent_start ─────→ Sync MEMORY.md + track workspace
  ├── tool_result_persist ────→ Record observation + re-sync MEMORY.md
  ├── agent_end ──────────────→ Summarize + complete session
  ├── session_end ────────────→ Clean up session tracking
  └── gateway_start ──────────→ Reset all tracking
```

All observation recording and MEMORY.md syncs are fire-and-forget — they never block the agent.

📖 Full documentation: [OpenClaw Integration Guide](https://docs.claude-mem.ai/docs/openclaw-integration)

---

## Windows Platform Improvements

- **ProcessManager**: Migrated daemon spawning from deprecated WMIC to PowerShell `Start-Process` with `-WindowStyle Hidden`
- **ChromaSync**: Re-enabled vector search on Windows (was previously disabled entirely)
- **Worker Service**: Added unified DB-ready gate middleware — all DB-dependent endpoints now wait for initialization instead of returning "Database not initialized" errors
- **EnvManager**: Switched from fragile allowlist to simple blocklist for subprocess env vars (only strips `ANTHROPIC_API_KEY` per Issue #733)

## Session Management Fixes

- Fixed unbounded session tracking map growth — maps are now cleaned up on `session_end`
- Session init moved to `session_start` and `after_compaction` hooks for correct lifecycle handling

## SSE Fixes

- Fixed stream URL consistency across the codebase
- Fixed multi-line SSE data frame parsing (concatenates `data:` lines per SSE spec)

## Issue Triage

Closed 37+ duplicate/stale/invalid issues across multiple triage phases, significantly cleaning up the issue tracker.

## [v9.1.1] - 2026-02-07

## Critical Bug Fix: Worker Initialization Failure

**v9.1.0 was unable to initialize its database on existing installations.** This patch fixes the root cause and several related issues.

### Bug Fixes

- **Fix FOREIGN KEY constraint failure during migration** — The `addOnUpdateCascadeToForeignKeys` migration (schema v21) crashed when orphaned observations existed (observations whose `memory_session_id` has no matching row in `sdk_sessions`). Fixed by disabling FK checks (`PRAGMA foreign_keys = OFF`) during table recreation, following SQLite's recommended migration pattern.

- **Remove hardcoded CHECK constraints on observation type column** — Multiple locations enforced `CHECK(type IN ('decision', 'bugfix', ...))` but the mode system (v8.0.0+) allows custom observation types, causing constraint violations. Removed all 5 occurrences across `SessionStore.ts`, `migrations.ts`, and `migrations/runner.ts`.

- **Fix Express middleware ordering for initialization guard** — The `/api/*` guard middleware that waits for DB initialization was registered AFTER routes, so Express matched routes before the guard. Moved guard middleware registration BEFORE route registrations. Added dedicated early handler for `/api/context/inject` to fail-open during init.

### New

- **Restored mem-search skill** — Recreated `plugin/skills/mem-search/SKILL.md` with the 3-layer workflow (search → timeline → batch fetch) updated for the current MCP tool set.

## [v9.1.0] - 2026-02-07

## v9.1.0 — The Great PR Triage

100 open PRs reviewed, triaged, and resolved. 157 commits, 123 files changed, +6,104/-721 lines. This release focuses on stability, security, and community contributions.

### Highlights

- **100 PR triage**: Reviewed every open PR — merged 48, cherry-picked 13, closed 39 (stale/duplicate/YAGNI)
- **Fail-open hook architecture**: Hooks no longer block Claude Code prompts when the worker is starting up
- **DB initialization guard**: All API endpoints now wait for database initialization instead of crashing with "Database not initialized"
- **Security hardening**: CORS restricted to localhost, XSS defense-in-depth via DOMPurify
- **3 new features**: Manual memory save, project exclusion, folder exclude setting

---

### Security

- **CORS restricted to localhost** — Worker API no longer accepts cross-origin requests from arbitrary websites. Only localhost/127.0.0.1 origins allowed. (PR #917 by @Spunky84)
- **XSS defense-in-depth** — Added DOMPurify sanitization to TerminalPreview.tsx viewer component (concept from PR #896)

### New Features

- **Manual memory storage** — New \`save_memory\` MCP tool and \`POST /api/memory/save\` endpoint for explicit memory capture (PR #662 by @darconada, closes #645)
- **Project exclusion setting** — \`CLAUDE_MEM_EXCLUDED_PROJECTS\` glob patterns to exclude entire projects from tracking (PR #920 by @Spunky84)
- **Folder exclude setting** — \`CLAUDE_MEM_FOLDER_MD_EXCLUDE\` JSON array to exclude paths from CLAUDE.md generation, fixing Xcode/drizzle build conflicts (PR #699 by @leepokai, closes #620)
- **Folder CLAUDE.md opt-in** — \`CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED\` now defaults to \`false\` (opt-in) instead of always-on (PR #913 by @superbiche)
- **Generate/clean CLI commands** — \`generate\` and \`clean\` commands for CLAUDE.md management with \`--dry-run\` support (PR #657 by @thedotmack)
- **Ragtime email investigation** — Batch processor for email investigation workflows (PR #863 by @thedotmack)

### Hook Resilience (Fail-Open Architecture)

Hooks no longer block Claude Code when the worker is unavailable or slow:

- **Graceful hook failures** — Hooks exit 0 with empty responses instead of crashing with exit 2 (PR #973 by @farikh)
- **Fail-open context injection** — Returns empty context during initialization instead of 503 (PR #959 by @rodboev)
- **Fetch timeouts** — All hook fetch calls have timeouts via \`fetchWithTimeout()\` helper (PR #964 by @rodboev)
- **Removed stale user-message hook** — Eliminated startup error from incorrectly bundled hook (PR #960 by @rodboev)
- **DB initialization middleware** — All \`/api/*\` routes now wait for DB init with 30s timeout instead of crashing

### Windows Stability

- **Path spaces fix** — bun-runner.js no longer fails for Windows usernames with spaces (PR #972 by @farikh)
- **Spawn guard** — 2-minute cooldown prevents repeated worker popup windows on startup failure

### Process & Zombie Management

- **Daemon children cleanup** — Orphan reaper now catches idle daemon child processes (PR #879 by @boaz-robopet)
- **Expanded orphan cleanup** — Startup cleanup now targets mcp-server.cjs and worker-service.cjs processes
- **Session-complete hook** — New Stop phase 2 hook removes sessions from active map, enabling effective orphan reaper cleanup (PR #844 by @thusdigital, fixes #842)

### Session Management

- **Prompt-too-long termination** — Sessions terminate cleanly instead of infinite retry loops (PR #934 by @jayvenn21)
- **Infinite restart prevention** — Max 3 restart attempts with exponential backoff, prevents runaway API costs (PR #693 by @ajbmachon)
- **Orphaned message fallback** — Messages from terminated sessions drain via Gemini/OpenRouter fallback (PR #937 by @jayvenn21, fixes #936)
- **Project field backfill** — Sessions correctly scoped when PostToolUse creates session before UserPromptSubmit (PR #940 by @miclip)
- **Provider-aware recovery** — Startup recovery uses correct provider instead of hardcoding SDKAgent (PR #741 by @licutis)
- **AbortController reset** — Prevents infinite "Generator aborted" loops after session abort (PR #627 by @TranslateMe)
- **Stateless provider IDs** — Synthetic memorySessionId generation for Gemini/OpenRouter (concept from PR #615 by @JiehoonKwak)
- **Duplicate generator prevention** — Legacy init endpoint uses idempotent \`ensureGeneratorRunning()\` (PR #932 by @jayvenn21)
- **DB readiness wait** — Session-init endpoint waits for database initialization (PR #828 by @rajivsinclair)
- **Image-only prompt support** — Empty/media prompts use \`[media prompt]\` placeholder (concept from PR #928 by @iammike)

### CLAUDE.md Path & Generation

- **Race condition fix** — Two-pass detection prevents corruption when Claude Code edits CLAUDE.md (concept from PR #974 by @cheapsteak)
- **Duplicate path prevention** — Detects \`frontend/frontend/\` style nested duplicates (concept from PR #836 by @Glucksberg)
- **Unsafe directory exclusion** — Blocks generation in \`res/\`, \`.git/\`, \`build/\`, \`node_modules/\`, \`__pycache__/\` (concept from PR #929 by @jayvenn21)

### Chroma/Vector Search

- **ID/metadata alignment fix** — Search results no longer misaligned after deduplication (PR #887 by @abkrim)
- **Transport zombie prevention** — Connection error handlers now close transport (PR #769 by @jenyapoyarkov)
- **Zscaler SSL support** — Enterprise environments with SSL inspection now work via combined cert path (PR #884 by @RClark4958)

### Parser & Config

- **Nested XML tag handling** — Parser correctly extracts fields with nested XML content (PR #835 by @Glucksberg)
- **Graceful empty transcripts** — Transcript parser returns empty string instead of crashing (PR #862 by @DennisHartrampf)
- **Gemini model name fix** — Corrected \`gemini-3-flash\` → \`gemini-3-flash-preview\` (PR #831 by @Glucksberg)
- **CLAUDE_CONFIG_DIR support** — Plugin paths respect custom config directory (PR #634 by @Kuroakira, fixes #626)
- **Env var priority** — \`env > file > defaults\` ordering via \`applyEnvOverrides()\` (PR #712 by @cjpeterein)
- **Minimum Bun version check** — smart-install.js enforces Bun 1.1.14+ (PR #524 by @quicktime, fixes #519)
- **Stdin timeout** — JSON self-delimiting detection with 30s safety timeout prevents hook hangs (PR #771 by @rajivsinclair, fixes #727)
- **FK constraint prevention** — \`ensureMemorySessionIdRegistered()\` guard + \`ON UPDATE CASCADE\` schema migration (PR #889 by @Et9797, fixes #846)
- **Cursor bun runtime** — Cursor hooks use bun instead of node, fixing bun:sqlite crashes (PR #721 by @polux0)

### Documentation

- **9 README PRs merged**: formatting fixes, Korean/Japanese/Chinese render fixes, documentation link updates, Traditional Chinese + Urdu translations (PRs #953, #898, #864, #637, #636, #894, #907, #691 by @Leonard013, @youngsu5582, @eltociear, @WuMingDao, @fengluodb, @PeterDaveHello, @yasirali646)
- **Windows setup note** — npm PATH instructions (PR #919 by @kamran-khalid-v9)
- **Issue templates** — Duplicate check checkbox added (PR #970 by @bmccann36)

### Community Contributors

Thank you to the 35+ contributors whose PRs were reviewed in this release:

@Spunky84, @farikh, @rodboev, @boaz-robopet, @jayvenn21, @ajbmachon, @miclip, @licutis, @TranslateMe, @JiehoonKwak, @rajivsinclair, @iammike, @cheapsteak, @Glucksberg, @abkrim, @jenyapoyarkov, @RClark4958, @DennisHartrampf, @Kuroakira, @cjpeterein, @quicktime, @polux0, @Et9797, @thusdigital, @superbiche, @darconada, @leepokai, @Leonard013, @youngsu5582, @eltociear, @WuMingDao, @fengluodb, @PeterDaveHello, @yasirali646, @kamran-khalid-v9, @bmccann36

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.17...v9.1.0

## [v9.0.17] - 2026-02-05

## Bug Fixes

### Fix Fresh Install Bun PATH Resolution (#818)

On fresh installations, hooks would fail because Bun wasn't in PATH until terminal restart. The `smart-install.js` script installs Bun to `~/.bun/bin/bun`, but the current shell session doesn't have it in PATH.

**Fix:** Introduced `bun-runner.js` — a Node.js wrapper that searches common Bun installation locations across all platforms:
- PATH (via `which`/`where`)
- `~/.bun/bin/bun` (default install location)
- `/usr/local/bin/bun`
- `/opt/homebrew/bin/bun` (macOS Homebrew)
- `/home/linuxbrew/.linuxbrew/bin/bun` (Linuxbrew)
- Windows: `%LOCALAPPDATA%\bun` or fallback paths

All 9 hook definitions updated to use `node bun-runner.js` instead of direct `bun` calls.

**Files changed:**
- `plugin/scripts/bun-runner.js` — New 88-line Bun discovery script
- `plugin/hooks/hooks.json` — All hook commands now route through bun-runner

Fixes #818 | PR #827 by @bigphoot

## [v9.0.16] - 2026-02-05

## Bug Fixes

### Fix Worker Startup Timeout (#811, #772, #729)

Resolves the "Worker did not become ready within 15 seconds" timeout error that could prevent hooks from communicating with the worker service.

**Root cause:** `isWorkerHealthy()` and `waitForHealth()` were checking `/api/readiness`, which returns 503 until full initialization completes — including MCP connection setup that can take 5+ minutes. Hooks only have a 15-second timeout window.

**Fix:** Switched to `/api/health` (liveness check), which returns 200 as soon as the HTTP server is listening. This is sufficient for hook communication since the worker accepts requests while background initialization continues.

**Files changed:**
- `src/shared/worker-utils.ts` — `isWorkerHealthy()` now checks `/api/health`
- `src/services/infrastructure/HealthMonitor.ts` — `waitForHealth()` now checks `/api/health`
- `tests/infrastructure/health-monitor.test.ts` — Updated test expectations

### PR Merge Tasks
- PR #820 merged with full verification pipeline (rebase, code review, build verification, test, manual verification)

## [v9.0.15] - 2026-02-05

## Security Fix

### Isolated Credentials (#745)
- **Prevents API key hijacking** from random project `.env` files
- Credentials now sourced exclusively from `~/.claude-mem/.env`
- Only whitelisted environment variables passed to SDK `query()` calls
- Authentication method logging shows whether using Claude Code CLI subscription billing or explicit API key

This is a security-focused patch release that hardens credential handling to prevent unintended API key usage from project directories.

## [v9.0.14] - 2026-02-05

## In-Process Worker Architecture

This release includes the merged in-process worker architecture from PR #722, which fundamentally improves how hooks interact with the worker service.

### Changes

- **In-process worker architecture** - Hook processes now become the worker when port 37777 is available, eliminating Windows spawn issues
- **Hook command improvements** - Added `skipExit` option to `hook-command.ts` for chained command execution
- **Worker health checks** - `worker-utils.ts` now returns boolean status for cleaner health monitoring
- **Massive CLAUDE.md cleanup** - Removed 76 redundant documentation files (4,493 lines removed)
- **Chained hook configuration** - `hooks.json` now supports chained commands for complex workflows

### Technical Details

The in-process architecture means hooks no longer need to spawn separate worker processes. When port 37777 is available, the hook itself becomes the worker, providing:
- Faster startup times
- Better resource utilization
- Elimination of process spawn failures on Windows

Full PR: https://github.com/thedotmack/claude-mem/pull/722

## [v9.0.13] - 2026-02-05

## Bug Fixes

### Zombie Observer Prevention (#856)

Fixed a critical issue where observer processes could become "zombies" - lingering indefinitely without activity. This release adds:

- **3-minute idle timeout**: SessionQueueProcessor now automatically terminates after 3 minutes of inactivity
- **Race condition fix**: Resolved spurious wakeup issues by resetting `lastActivityTime` on queue activity
- **Comprehensive test coverage**: Added 11 new tests for the idle timeout mechanism

This fix prevents resource leaks from orphaned observer processes that could accumulate over time.

## [v9.0.12] - 2026-01-28

## Fix: Authentication failure from observer session isolation

**Critical bugfix** for users who upgraded to v9.0.11.

### Problem

v9.0.11 introduced observer session isolation using `CLAUDE_CONFIG_DIR` override, which inadvertently broke authentication:

```
Invalid API key · Please run /login
```

This happened because Claude Code stores credentials in the config directory, and overriding it prevented access to existing auth tokens.

### Solution

Observer sessions now use the SDK's `cwd` option instead:
- Sessions stored under `~/.claude-mem/observer-sessions/` project
- Auth credentials in `~/.claude/` remain accessible
- Observer sessions still won't pollute `claude --resume` lists

### Affected Users

Anyone running v9.0.11 who saw "Invalid API key" errors should upgrade immediately.

---

🤖 Generated with [Claude Code](https://claude.ai/code)

## [v9.0.11] - 2026-01-28

## Bug Fixes

### Observer Session Isolation (#837)
Observer sessions created by claude-mem were polluting the `claude --resume` list, cluttering it with internal plugin sessions that users never intend to resume. In one user's case, 74 observer sessions out of ~220 total (34% noise).

**Solution**: Observer processes now use a dedicated config directory (`~/.claude-mem/observer-config/`) to isolate their session files from user sessions.

Thanks to @Glucksberg for this fix! Fixes #832.

### Stale memory_session_id Crash Prevention (#839)
After a worker restart, stale `memory_session_id` values in the database could cause crashes when attempting to resume SDK conversations. The existing guard didn't protect against this because session data was loaded from the database.

**Solution**: Clear `memory_session_id` when loading sessions from the database (not from cache). The key insight: if a session isn't in memory, any database `memory_session_id` is definitely stale.

Thanks to @bigph00t for this fix! Fixes #817.

---
**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.10...v9.0.11

## [v9.0.10] - 2026-01-26

## Bug Fix

**Fixed path format mismatch causing folder CLAUDE.md files to show "No recent activity" (#794)** - Thanks @bigph00t!

The folder-level CLAUDE.md generation was failing to find observations due to a path format mismatch between how API queries used absolute paths and how the database stored relative paths. The `isDirectChild()` function's simple prefix match always returned false in these cases.

**Root cause:** PR #809 (v9.0.9) only masked this bug by skipping file creation when "no activity" was detected. Since ALL folders were affected, this prevented file creation entirely. This PR provides the actual fix.

**Changes:**
- Added new shared module `src/shared/path-utils.ts` with robust path normalization and matching utilities
- Updated `SessionSearch.ts`, `regenerate-claude-md.ts`, and `claude-md-utils.ts` to use shared path utilities
- Added comprehensive test coverage (61 new tests) for path matching edge cases

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v9.0.9] - 2026-01-26

## Bug Fixes

### Prevent Creation of Empty CLAUDE.md Files (#809)

Previously, claude-mem would create new `CLAUDE.md` files in project directories even when there was no activity to display, cluttering codebases with empty context files showing only "*No recent activity*".

**What changed:** The `updateFolderClaudeMdFiles` function now checks if the formatted content contains no activity before writing. If a `CLAUDE.md` file doesn't already exist and there's nothing to show, it will be skipped entirely. Existing files will still be updated to reflect "No recent activity" if that's the current state.

**Impact:** Cleaner project directories - only folders with actual activity will have `CLAUDE.md` context files created.

Thanks to @maxmillienjr for this contribution!

## [v9.0.8] - 2026-01-26

## Fix: Prevent Zombie Process Accumulation (Issue #737)

This release fixes a critical issue where Claude haiku subprocesses spawned by the SDK weren't terminating properly, causing zombie process accumulation. One user reported 155 processes consuming 51GB RAM.

### Root Causes Addressed
- SDK's SpawnedProcess interface hides subprocess PIDs
- `deleteSession()` didn't verify subprocess exit
- `abort()` was fire-and-forget with no confirmation
- No mechanism to track or clean up orphaned processes

### Solution
- **ProcessRegistry module**: Tracks spawned Claude subprocesses via PID
- **Custom spawn**: Uses SDK's `spawnClaudeCodeProcess` option to capture PIDs
- **Signal propagation**: Passes signal parameter to enable AbortController integration
- **Graceful shutdown**: Waits for subprocess exit in `deleteSession()` with 5s timeout
- **SIGKILL escalation**: Force-kills processes that don't exit gracefully
- **Orphan reaper**: Safety net running every 5 minutes to clean up any missed processes
- **Race detection**: Warns about multiple processes per session (race condition indicator)

### Files Changed
- `src/services/worker/ProcessRegistry.ts` (new): PID registry and reaper
- `src/services/worker/SDKAgent.ts`: Use custom spawn to capture PIDs
- `src/services/worker/SessionManager.ts`: Verify subprocess exit on delete
- `src/services/worker-service.ts`: Start/stop orphan reaper

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.7...v9.0.8

Fixes #737

## [v9.0.6] - 2026-01-22

## Windows Console Popup Fix

This release eliminates the annoying console window popups that Windows users experienced when claude-mem spawned background processes.

### Fixed
- **Windows console popups eliminated** - Daemon spawn and Chroma operations no longer create visible console windows (#748, #708, #681, #676)
- **Race condition in PID file writing** - Worker now writes its own PID file after listen() succeeds, ensuring reliable process tracking on all platforms

### Changed
- **Chroma temporarily disabled on Windows** - Vector search is disabled on Windows while we migrate to a popup-free architecture. Keyword search and all other memory features continue to work. A follow-up release will re-enable Chroma.
- **Slash command discoverability** - Added YAML frontmatter to `/do` and `/make-plan` commands

### Technical Details
- Uses WMIC for detached process spawning on Windows
- PID file location unchanged, but now written by worker process
- Cross-platform: Linux/macOS behavior unchanged

### Contributors
- @bigph00t (Alexander Knigge)

## [v9.0.5] - 2026-01-14

## Major Worker Service Cleanup

This release contains a significant refactoring of `worker-service.ts`, removing ~216 lines of dead code and simplifying the architecture.

### Refactoring
- **Removed dead code**: Deleted `runInteractiveSetup` function (defined but never called)
- **Cleaned up imports**: Removed unused imports (fs namespace, spawn, homedir, readline, existsSync, writeFileSync, readFileSync, mkdirSync)
- **Removed fallback agent concept**: Users who choose Gemini/OpenRouter now get those providers directly without hidden fallback behavior
- **Eliminated re-export indirection**: ResponseProcessor now imports directly from CursorHooksInstaller instead of through worker-service

### Security Fix
- **Removed dangerous ANTHROPIC_API_KEY check**: Claude Code uses CLI authentication, not direct API calls. The previous check could accidentally use a user's API key (from other projects) which costs 20x more than Claude Code's pricing

### Build Improvements
- **Dynamic MCP version management**: MCP server and client versions now use build-time injected values from package.json instead of hardcoded strings, ensuring version synchronization

### Documentation
- Added Anti-Pattern Czar Generalization Analysis report
- Updated README with $CMEM links and contract address
- Added comprehensive cleanup and validation plans for worker-service.ts

## [v9.0.4] - 2026-01-10

## What's New

This release adds the `/do` and `/make-plan` development commands to the plugin distribution, making them available to all users who install the plugin from the marketplace.

### Features

- **Development Commands Now Distributed with Plugin** (#666)
  - `/do` command - Execute tasks with structured workflow
  - `/make-plan` command - Create detailed implementation plans
  - Commands now available at `plugin/commands/` for all users

### Documentation

- Revised Arabic README for clarity and corrections (#661)

### Full Changelog

https://github.com/thedotmack/claude-mem/compare/v9.0.3...v9.0.4

## [v9.0.3] - 2026-01-10

## Bug Fixes

### Hook Framework JSON Status Output (#655)

Fixed an issue where the worker service startup wasn't producing proper JSON status output for the Claude Code hook framework. This caused hooks to appear stuck or unresponsive during worker initialization.

**Changes:**
- Added `buildStatusOutput()` function for generating structured JSON status output
- Worker now outputs JSON with `status`, `message`, and `continue` fields on stdout
- Proper exit code 0 ensures Windows Terminal compatibility (no tab accumulation)
- `continue: true` flag ensures Claude Code continues processing after hook execution

**Technical Details:**
- Extracted status output generation into a pure, testable function
- Added comprehensive test coverage in `tests/infrastructure/worker-json-status.test.ts`
- 23 passing tests covering unit, CLI integration, and hook framework compatibility

## Housekeeping

- Removed obsolete error handling baseline file

## [v9.0.2] - 2026-01-10

## Bug Fixes

- **Windows Terminal Tab Accumulation (#625, #628)**: Fixed terminal tab accumulation on Windows by implementing graceful exit strategy. All expected failure scenarios (port conflicts, version mismatches, health check timeouts) now exit with code 0 instead of code 1.
- **Windows 11 Compatibility (#625)**: Replaced deprecated WMIC commands with PowerShell `Get-Process` and `Get-CimInstance` for process enumeration. WMIC is being removed from Windows 11.

## Maintenance

- **Removed Obsolete CLAUDE.md Files**: Cleaned up auto-generated CLAUDE.md files from `~/.claude/plans/` and `~/.claude/plugins/marketplaces/` directories.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.1...v9.0.2

## [v9.0.1] - 2026-01-08

## Bug Fixes

### Claude Code 2.1.1 Compatibility
- Fixed hook architecture for compatibility with Claude Code 2.1.0/2.1.1
- Context is now injected silently via SessionStart hook
- Removed deprecated `user-message-hook` (no longer used in CC 2.1.0+)

### Path Validation for CLAUDE.md Distribution
- Added `isValidPathForClaudeMd()` to reject malformed paths:
  - Tilde paths (`~`) that Node.js doesn't expand
  - URLs (`http://`, `https://`)
  - Paths with spaces (likely command text or PR references)
  - Paths with `#` (GitHub issue/PR references)
  - Relative paths that escape project boundary
- Cleaned up 12 invalid CLAUDE.md files created by bug artifacts
- Updated `.gitignore` to prevent future accidents

### Log-Level Audit
- Promoted 38+ WARN messages to ERROR level for improved debugging:
  - Parser: observation type errors, data contamination
  - SDK/Agents: empty init responses (Gemini, OpenRouter)
  - Worker/Queue: session recovery, auto-recovery failures
  - Chroma: sync failures, search failures
  - SQLite: search failures
  - Session/Generator: failures, missing context
  - Infrastructure: shutdown, process management failures

## Internal Changes
- Removed hardcoded fake token counts from context injection
- Standardized Claude Code 2.1.0 note wording across documentation

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.0...v9.0.1

## [v9.0.0] - 2026-01-06

## 🚀 Live Context System

Version 9.0.0 introduces the **Live Context System** - a major new capability that provides folder-level activity context through auto-generated CLAUDE.md files.

### ✨ New Features

#### Live Context System
- **Folder CLAUDE.md Files**: Each directory now gets an auto-generated CLAUDE.md file containing a chronological timeline of recent development activity
- **Activity Timelines**: Tables show observation ID, time, type, title, and estimated token cost for relevant work in each folder
- **Worktree Support**: Proper detection of git worktrees with project-aware filtering to show only relevant observations per worktree
- **Configurable Limits**: Control observation count via `CLAUDE_MEM_CONTEXT_OBSERVATIONS` setting

#### Modular Architecture Refactor
- **Service Layer Decomposition**: Major refactoring from monolithic worker-service to modular domain services
- **SQLite Module Extraction**: Database operations split into dedicated modules (observations, sessions, summaries, prompts, timeline)
- **Context Builder System**: New modular context generation with TimelineRenderer, FooterRenderer, and ObservationCompiler
- **Error Handler Centralization**: Unified Express error handling via ErrorHandler module

#### SDK Agent Improvements
- **Session Resume**: Memory sessions can now resume across Claude conversations using SDK session IDs
- **Memory Session ID Tracking**: Proper separation of content session IDs from memory session IDs
- **Response Processor Refactor**: Cleaner message handling and observation extraction

### 🔧 Improvements

#### Windows Stability
- Fixed Windows PowerShell variable escaping in hook execution
- Improved IPC detection for Windows managed mode
- Better PATH handling for Bun and uv on Windows

#### Settings & Configuration
- **Auto-Creation**: Settings file automatically created with defaults on first run
- **Worker Host Configuration**: `CLAUDE_MEM_WORKER_HOST` setting for custom worker endpoints
- Settings validation with helpful error messages

#### MCP Tools
- Standardized naming: "MCP tools" terminology instead of "mem-search skill"
- Improved tool descriptions for better Claude integration
- Context injection API now supports worktree parameter

### 📚 Documentation
- New **Folder Context Files** documentation page
- **Worktree Support** section explaining git worktree behavior
- Updated architecture documentation reflecting modular refactor
- v9.0 release notes in introduction page

### 🐛 Bug Fixes
- Fixed stale session resume crash when SDK session is orphaned
- Fixed logger serialization bug causing silent ChromaSync failures
- Fixed CLAUDE.md path resolution in worktree environments
- Fixed date preservation in folder timeline generation
- Fixed foreign key constraint issues in observation storage
- Resolved multiple TypeScript type errors across codebase

### 🗑️ Removed
- Deprecated context-generator.ts (functionality moved to modular system)
- Obsolete queue analysis documents
- Legacy worker wrapper scripts

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.10...v9.0.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v8.5.10] - 2026-01-06

## Bug Fixes

- **#545**: Fixed `formatTool` crash when parsing non-JSON tool inputs (e.g., raw Bash commands)
- **#544**: Fixed terminology in context hints - changed "mem-search skill" to "MCP tools"
- **#557**: Settings file now auto-creates with defaults on first run (no more "module loader" errors)
- **#543**: Fixed hook execution by switching runtime from `node` to `bun` (resolves `bun:sqlite` issues)

## Code Quality

- Fixed circular dependency between Logger and SettingsDefaultsManager
- Added 72 integration tests for critical coverage gaps
- Cleaned up mock-heavy tests causing module cache pollution

## Full Changelog

See PR #558 for complete details and diagnostic reports.

## [v8.5.9] - 2026-01-04

## What's New

### Context Header Timestamp

The context injection header now displays the current date and time, making it easier to understand when context was generated.

**Example:** `[claude-mem] recent context, 2026-01-04 2:46am EST`

This appears in both terminal (colored) output and markdown format, including empty state messages.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.8...v8.5.9

## [v8.5.8] - 2026-01-04

## Bug Fixes

- **#511**: Add `gemini-3-flash` model to GeminiAgent with proper rate limits and validation
- **#517**: Fix Windows process management by replacing PowerShell with WMIC (fixes Git Bash/WSL compatibility)
- **#527**: Add Apple Silicon Homebrew paths (`/opt/homebrew/bin`) for `bun` and `uv` detection
- **#531**: Remove duplicate type definitions from `export-memories.ts` using shared bridge file

## Tests

- Added regression tests for PR #542 covering Gemini model support, WMIC parsing, Apple Silicon paths, and export type refactoring

## Documentation

- Added detailed analysis reports for GitHub issues #511, #514, #517, #520, #527, #531, #532

## [v8.5.7] - 2026-01-04

## Modular Architecture Refactor

This release refactors the monolithic service architecture into focused, single-responsibility modules with comprehensive test coverage.

### Architecture Improvements

- **SQLite Repositories** (`src/services/sqlite/`) - Modular repositories for sessions, observations, prompts, summaries, and timeline
- **Worker Agents** (`src/services/worker/agents/`) - Extracted response processing, error handling, and session cleanup
- **Search Strategies** (`src/services/worker/search/`) - Modular search with Chroma, SQLite, and Hybrid strategies plus orchestrator
- **Context Generation** (`src/services/context/`) - Separated context building, token calculation, formatters, and renderers
- **Infrastructure** (`src/services/infrastructure/`) - Graceful shutdown, health monitoring, and process management
- **Server** (`src/services/server/`) - Express server setup, middleware, and error handling

### Test Coverage

- **595 tests** across 36 test files
- **1,120 expect() assertions**
- Coverage for SQLite repos, worker agents, search, context, infrastructure, and server modules

### Session ID Refactor

- Aligned tests with NULL-based memory session initialization pattern
- Updated `SESSION_ID_ARCHITECTURE.md` documentation

### Other Improvements

- Added missing logger imports to 34 files for better observability
- Updated esbuild and MCP SDK to latest versions
- Removed `bun.lock` from version control

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.6...v8.5.7

## [v8.5.6] - 2026-01-04

## Major Architectural Refactoring

Decomposes monolithic services into modular, maintainable components:

### Worker Service
Extracted infrastructure (GracefulShutdown, HealthMonitor, ProcessManager), server layer (ErrorHandler, Middleware, Server), and integrations (CursorHooksInstaller)

### Context Generator
Split into ContextBuilder, ContextConfigLoader, ObservationCompiler, TokenCalculator, formatters (Color/Markdown), and section renderers (Header/Footer/Summary/Timeline)

### Search System
Extracted SearchOrchestrator, ResultFormatter, TimelineBuilder, and strategy pattern (Chroma/SQLite/Hybrid search strategies) with dedicated filters (Date/Project/Type)

### Agent System
Extracted shared logic into ResponseProcessor, ObservationBroadcaster, FallbackErrorHandler, and SessionCleanupHelper

### SQLite Layer
Decomposed SessionStore into domain modules (observations, prompts, sessions, summaries, timeline) with proper type exports

## Bug Fixes
- Fixed duplicate observation storage bug (observations stored multiple times when messages were batched)
- Added duplicate observation cleanup script for production database remediation
- Fixed FOREIGN KEY constraint and missing `failed_at_epoch` column issues

## Coming Next
Comprehensive test suite in a new PR, targeting **v8.6.0**

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v8.5.5] - 2026-01-03

## Improved Error Handling and Logging

This patch release enhances error handling and logging across all worker services for better debugging and reliability.

### Changes
- **Enhanced Error Logging**: Improved error context across SessionStore, SearchManager, SDKAgent, GeminiAgent, and OpenRouterAgent
- **SearchManager**: Restored error handling for Chroma calls with improved logging
- **SessionStore**: Enhanced error logging throughout database operations
- **Bug Fix**: Fixed critical bug where `memory_session_id` could incorrectly equal `content_session_id`
- **Hooks**: Streamlined error handling and loading states for better maintainability

### Investigation Reports
- Added detailed analysis documents for generator failures and observation duplication regressions

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.4...v8.5.5

## [v8.5.4] - 2026-01-02

## Bug Fixes

### Chroma Connection Error Handling
Fixed a critical bug in ChromaSync where connection-related errors were misinterpreted as missing collections. The `ensureCollection()` method previously caught ALL errors and assumed they meant the collection doesn't exist, which caused connection errors to trigger unnecessary collection creation attempts. Now connection-related errors like "Not connected" are properly distinguished and re-thrown immediately, preventing false error handling paths and inappropriate fallback behavior.

### Removed Dead last_user_message Code
Cleaned up dead code related to `last_user_message` handling in the summary flow. This field was being extracted from transcripts but never used anywhere - in Claude Code transcripts, "user" type messages are mostly tool_results rather than actual user input, and the user's original request is already stored in the user_prompts table. Removing this unused field eliminates confusing warnings like "Missing last_user_message when queueing summary". Changes span summary-hook, SessionRoutes, SessionManager, interface definitions, and all agent implementations.

## Improvements

### Enhanced Error Handling Across Services
Comprehensive improvement to error handling across 8 core services:
- **BranchManager** - Now logs recovery checkout failures
- **PaginationHelper** - Logs when file paths are plain strings instead of valid JSON
- **SDKAgent** - Enhanced logging for Claude executable detection failures
- **SearchManager** - Logs plain string handling for files read and edited
- **paths.ts** - Improved logging for git root detection failures
- **timeline-formatting** - Enhanced JSON parsing errors with input previews
- **transcript-parser** - Logs summary of parse errors after processing
- **ChromaSync** - Logs full error context before attempting collection creation

### Error Handling Documentation & Tooling
- Created `error-handling-baseline.txt` establishing baseline error handling practices
- Documented error handling anti-pattern rules in CLAUDE.md
- Added `detect-error-handling-antipatterns.ts` script to identify empty catch blocks, improper logging practices, and oversized try-catch blocks

## New Features

### Console Filter Bar with Log Parsing
Implemented interactive log filtering in the viewer UI:
- **Structured Log Parsing** - Extracts timestamp, level, component, correlation ID, and message content using regex pattern matching
- **Level Filtering** - Toggle visibility for DEBUG, INFO, WARN, ERROR log levels
- **Component Filtering** - Filter by 9 component types: HOOK, WORKER, SDK, PARSER, DB, SYSTEM, HTTP, SESSION, CHROMA
- **Color-Coded Rendering** - Visual distinction with component-specific icons and log level colors
- **Special Message Detection** - Recognizes markers like → (dataIn), ← (dataOut), ✓ (success), ✗ (failure), ⏱ (timing), [HAPPY-PATH]
- **Smart Auto-Scroll** - Maintains scroll position when reviewing older logs
- **Responsive Design** - Filter bar adapts to smaller screens

## [v8.5.3] - 2026-01-02

# 🛡️ Error Handling Hardening & Developer Tools

Version 8.5.3 introduces comprehensive error handling improvements that prevent silent failures and reduce debugging time from hours to minutes. This release also adds new developer tools for queue management and log monitoring.

---

## 🔴 Critical Error Handling Improvements

### The Problem
A single overly-broad try-catch block caused a **10-hour debugging session** by silently swallowing errors. This pattern was pervasive throughout the codebase, creating invisible failure modes.

### The Solution

**Automated Anti-Pattern Detection** (`scripts/detect-error-handling-antipatterns.ts`)
- Detects 7 categories of error handling anti-patterns
- Enforces zero-tolerance policy for empty catch blocks
- Identifies large try-catch blocks (>10 lines) that mask specific errors
- Flags missing error logging that causes silent failures
- Supports approved overrides with justification comments
- Exit code 1 if critical issues detected (enforceable in CI)

**New Error Handling Standards** (Added to `CLAUDE.md`)
- **5-Question Pre-Flight Checklist**: Required before writing any try-catch
  1. What SPECIFIC error am I catching?
  2. Show documentation proving this error can occur
  3. Why can't this error be prevented?
  4. What will the catch block DO?
  5. Why shouldn't this error propagate?
- **Forbidden Patterns**: Empty catch, catch without logging, large try blocks, promise catch without handlers
- **Allowed Patterns**: Specific errors, logged failures, minimal scope, explicit recovery
- **Meta-Rule**: Uncertainty triggers research, NOT try-catch

### Fixes Applied

**Wave 1: Empty Catch Blocks** (5 files)
- `import-xml-observations.ts` - Log skipped invalid JSON
- `bun-path.ts` - Log when bun not in PATH
- `cursor-utils.ts` - Log failed registry reads & corrupt MCP config
- `worker-utils.ts` - Log failed health checks

**Wave 2: Promise Catches on Critical Paths** (8 locations)
- `worker-service.ts` - Background initialization failures
- `SDKAgent.ts` - Session processor errors (2 locations)
- `GeminiAgent.ts` - Finalization failures (2 locations)
- `OpenRouterAgent.ts` - Finalization failures (2 locations)
- `SessionManager.ts` - Generator promise failures

**Wave 3: Comprehensive Audit** (29 catch blocks)
- Added logging to 16 catch blocks (UI, servers, worker, routes, services)
- Documented 13 intentional exceptions with justification comments
- All patterns now follow error handling guidelines with appropriate log levels

### Approved Override System

For justified exceptions (performance-critical paths, expected failures), use:
```typescript
// [APPROVED OVERRIDE]: Brief technical justification
try {
  // code
} catch {
  // allowed exception
}
```

**Progress**: 163 anti-patterns → 26 approved overrides (84% reduction in silent failures)

---

## 🗂️ Queue Management Features

**New Commands**
- `npm run queue:clear` - Interactive removal of failed messages
- `npm run queue:clear -- --all` - Clear all messages (pending, processing, failed)
- `npm run queue:clear -- --force` - Non-interactive mode

**HTTP API Endpoints**
- `DELETE /api/pending-queue/failed` - Remove failed messages
- `DELETE /api/pending-queue/all` - Complete queue reset

Failed messages exceed max retry count and remain for debugging. These commands provide clean queue maintenance.

---

## 🪵 Developer Console (Chrome DevTools Style)

**UI Improvements**
- Bottom drawer console (slides up from bottom-left corner)
- Draggable resize handle for height adjustment
- Auto-refresh toggle (2s interval)
- Clear logs button with confirmation
- Monospace font (SF Mono/Monaco/Consolas)
- Minimum height: 150px, adjustable to window height - 100px

**API Endpoints**
- `GET /api/logs` - Fetch last 1000 lines of current day's log
- `DELETE /api/logs` - Clear current log file

Logs viewer accessible via floating console button in UI.

---

## 📚 Architecture Documentation

**Session ID Architecture** (`docs/SESSION_ID_ARCHITECTURE.md`)
- Comprehensive documentation of 1:1 session mapping guarantees
- 19 validation tests proving UNIQUE constraints and resume consistency
- Documents single-transition vulnerability (application-level enforcement)
- Complete reference for session lifecycle management

---

## 📊 Impact Summary

- **Debugging Time**: 10 hours → minutes (proper error visibility)
- **Test Coverage**: +19 critical architecture validation tests
- **Silent Failures**: 84% reduction (163 → 26 approved exceptions)
- **Protection**: Automated detection prevents regression
- **Developer UX**: Console logs, queue management, comprehensive docs

---

## 🔧 Technical Details

**Files Changed**: 25+ files across error handling, queue management, UI, and documentation

**Critical Path Protection**
These files now have strict error propagation (no catch-and-continue):
- `SDKAgent.ts`
- `GeminiAgent.ts`
- `OpenRouterAgent.ts`
- `SessionStore.ts`
- `worker-service.ts`

**Build Verification**: All changes tested, build successful

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.2...v8.5.3

## [v8.5.2] - 2025-12-31

## Bug Fixes

### Fixed SDK Agent Memory Leak (#499)

Fixed a critical memory leak where Claude SDK child processes were never terminated after sessions completed. Over extended usage, this caused hundreds of orphaned processes consuming 40GB+ of RAM.

**Root Cause:**
- When the SDK agent generator completed naturally (no more messages to process), the `AbortController` was never aborted
- Child processes spawned by the Agent SDK remained running indefinitely
- Sessions stayed in memory (by design for future events) but underlying processes were never cleaned up

**Fix:**
- Added proper cleanup to SessionRoutes finally block
- Now calls `abortController.abort()` when generator completes with no pending work
- Creates new `AbortController` when crash recovery restarts generators
- Ensures cleanup happens even if recovery logic fails

**Impact:**
- Prevents orphaned `claude` processes from accumulating
- Eliminates multi-gigabyte memory leaks during normal usage
- Maintains crash recovery functionality with proper resource cleanup

Thanks to @yonnock for the detailed bug report and investigation in #499!

## [v8.5.1] - 2025-12-30

## Bug Fix

**Fixed**: Migration 17 column rename failing for databases in intermediate states (#481)

### Problem
Migration 17 renamed session ID columns but used a single check to determine if ALL tables were migrated. This caused errors for databases in partial migration states:
- `no such column: sdk_session_id` (when columns already renamed)
- `table observations has no column named memory_session_id` (when not renamed)

### Solution
- Rewrote migration 17 to check **each table individually** before renaming
- Added `safeRenameColumn()` helper that handles all edge cases gracefully
- Handles all database states: fresh, old, and partially migrated

### Who was affected
- Users upgrading from pre-v8.2.6 versions
- Users whose migration was interrupted (crash, restart, etc.)
- Users who restored database from backup

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v8.5.0] - 2025-12-30

# Cursor Support Now Available 🎉

This is a major release introducing **full Cursor IDE support**. Claude-mem now works with Cursor, bringing persistent AI memory to Cursor users with or without a Claude Code subscription.

## Highlights

**Give Cursor persistent memory.** Every Cursor session starts fresh - your AI doesn't remember what it worked on yesterday. Claude-mem changes that. Your agent builds cumulative knowledge about your codebase, decisions, and patterns over time.

### Works Without Claude Code

You can now use claude-mem with Cursor using free AI providers:
- **Gemini** (recommended): 1,500 free requests/day, no credit card required
- **OpenRouter**: Access to 100+ models including free options
- **Claude SDK**: For Claude Code subscribers

### Cross-Platform Support

Full support for all major platforms:
- **macOS**: Bash scripts with `jq` and `curl`
- **Linux**: Same toolchain as macOS
- **Windows**: Native PowerShell scripts, no WSL required

## New Features

### Interactive Setup Wizard (`bun run cursor:setup`)
A guided installer that:
- Detects your environment (Claude Code present or not)
- Helps you choose and configure an AI provider
- Installs Cursor hooks automatically
- Starts the worker service
- Verifies everything is working

### Cursor Lifecycle Hooks
Complete hook integration with Cursor's native hook system:
- `session-init.sh/.ps1` - Session start with context injection
- `user-message.sh/.ps1` - User prompt capture
- `save-observation.sh/.ps1` - Tool usage logging
- `save-file-edit.sh/.ps1` - File edit tracking
- `session-summary.sh/.ps1` - Session end summary
- `context-inject.sh/.ps1` - Load relevant history

### Context Injection via `.cursor/rules`
Relevant past context is automatically injected into Cursor sessions via the `.cursor/rules/claude-mem-context.mdc` file, giving your AI immediate awareness of prior work.

### Project Registry
Multi-project support with automatic project detection:
- Projects registered in `~/.claude-mem/cursor-projects.json`
- Context automatically scoped to current project
- Works across multiple workspaces simultaneously

### MCP Search Tools
Full MCP server integration for Cursor:
- `search` - Find observations by query, date, type
- `timeline` - Get context around specific observations
- `get_observations` - Fetch full details for filtered IDs

## New Commands

| Command | Description |
|---------|-------------|
| `bun run cursor:setup` | Interactive setup wizard |
| `bun run cursor:install` | Install Cursor hooks |
| `bun run cursor:uninstall` | Remove Cursor hooks |
| `bun run cursor:status` | Check hook installation status |

## Documentation

Full documentation available at [docs.claude-mem.ai/cursor](https://docs.claude-mem.ai/cursor):
- Cursor Integration Overview
- Gemini Setup Guide (free tier)
- OpenRouter Setup Guide
- Troubleshooting

## Getting Started

### For Cursor-Only Users (No Claude Code)

```bash
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem && bun install && bun run build
bun run cursor:setup
```

### For Claude Code Users

```bash
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
claude-mem cursor install
```

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.10...v8.5.0

## [v8.2.10] - 2025-12-30

## Bug Fixes

- **Auto-restart worker on version mismatch** (#484): When the plugin updates but the worker was already running on the old version, the worker now automatically restarts instead of failing with 400 errors.

### Changes
- `/api/version` endpoint now returns the built-in version (compiled at build time) instead of reading from disk
- `worker-service start` command checks for version mismatch and auto-restarts if needed
- Downgraded hook version mismatch warning to debug logging (now handled by auto-restart)

Thanks @yungweng for the detailed bug report!

## [v8.2.9] - 2025-12-29

## Bug Fixes

- **Worker Service**: Remove file-based locking and improve Windows stability
  - Replaced file-based locking with health-check-first approach for cleaner mutual exclusion
  - Removed AbortSignal.timeout() calls to reduce Bun libuv assertion errors on Windows
  - Added 500ms shutdown delays on Windows to prevent zombie ports
  - Reduced hook timeout values for improved responsiveness
  - Increased worker readiness polling duration from 5s to 15s

## Internal Changes

- Updated worker CLI scripts to reference worker-service.cjs directly
- Simplified hook command configurations

## [v8.2.8] - 2025-12-29

## Bug Fixes

- Fixed orphaned chroma-mcp processes during shutdown (#489)
  - Added graceful shutdown handling with signal handlers registered early in WorkerService lifecycle
  - Ensures ChromaSync subprocess cleanup even when interrupted during initialization
  - Removes PID file during shutdown to prevent stale process tracking

## Technical Details

This patch release addresses a race condition where SIGTERM/SIGINT signals arriving during ChromaSync initialization could leave orphaned chroma-mcp processes. The fix moves signal handler registration from the start() method to the constructor, ensuring cleanup handlers exist throughout the entire initialization lifecycle.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.7...v8.2.8

## [v8.2.7] - 2025-12-29

## What's Changed

### Token Optimizations
- Simplified MCP server tool definitions for reduced token usage
- Removed outdated troubleshooting and mem-search skill documentation
- Enhanced search parameter descriptions for better clarity
- Streamlined MCP workflows for improved efficiency

This release significantly reduces the token footprint of the plugin's MCP tools and documentation.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.6...v8.2.7

## [v8.2.6] - 2025-12-29

## What's Changed

### Bug Fixes & Improvements
- Session ID semantic renaming for clarity (content_session_id, memory_session_id)
- Queue system simplification with unified processing logic
- Memory session ID capture for agent resume functionality
- Comprehensive test suite for session ID refactoring

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.5...v8.2.6

## [v8.2.5] - 2025-12-28

## Bug Fixes

- **Logger**: Enhanced Error object handling in debug mode to prevent empty JSON serialization
- **ChromaSync**: Refactored DatabaseManager to initialize ChromaSync lazily, removing background backfill on startup
- **SessionManager**: Simplified message handling and removed linger timeout that was blocking completion

## Technical Details

This patch release addresses several issues discovered after the session continuity fix:

1. Logger now properly serializes Error objects with stack traces in debug mode
2. ChromaSync initialization is now lazy to prevent silent failures during startup
3. Session linger timeout removed to eliminate artificial 5-second delays on session completion

Full changelog: https://github.com/thedotmack/claude-mem/compare/v8.2.4...v8.2.5

## [v8.2.4] - 2025-12-28

Patch release v8.2.4

## [v8.2.3] - 2025-12-27

## Bug Fixes

- Fix worker port environment variable in smart-install script
- Implement file-based locking mechanism for worker operations to prevent race conditions
- Fix restart command references in documentation (changed from `claude-mem restart` to `npm run worker:restart`)

## [v8.2.2] - 2025-12-27

## What's Changed

### Features
- Add OpenRouter provider settings and documentation
- Add modal footer with save button and status indicators
- Implement self-spawn pattern for background worker execution

### Bug Fixes
- Resolve critical error handling issues in worker lifecycle
- Handle Windows/Unix kill errors in orphaned process cleanup
- Validate spawn pid before writing PID file
- Handle process exit in waitForProcessesExit filter
- Use readiness endpoint for health checks instead of port check
- Add missing OpenRouter and Gemini settings to settingKeys array

### Other Changes
- Enhance error handling and validation in agents and routes
- Delete obsolete process management files (ProcessManager, worker-wrapper, worker-cli)
- Update hooks.json to use worker-service.cjs CLI
- Add comprehensive tests for hook constants and worker spawn functionality

## [v8.2.1] - 2025-12-27

## 🔧 Worker Lifecycle Hardening

This patch release addresses critical bugs discovered during PR review of the self-spawn pattern introduced in 8.2.0. The worker daemon now handles edge cases robustly across both Unix and Windows platforms.

### 🐛 Critical Bug Fixes

#### Process Exit Detection Fixed
The `waitForProcessesExit` function was crashing when processes exited during monitoring. The `process.kill(pid, 0)` call throws when a process no longer exists, which was not being caught. Now wrapped in try/catch to correctly identify exited processes.

#### Spawn PID Validation
The worker daemon now validates that `spawn()` actually returned a valid PID before writing to the PID file. Previously, spawn failures could leave invalid PID files that broke subsequent lifecycle operations.

#### Cross-Platform Orphan Cleanup
- **Unix**: Replaced single `kill` command with individual `process.kill()` calls wrapped in try/catch, so one already-exited process doesn't abort cleanup of remaining orphans
- **Windows**: Wrapped `taskkill` calls in try/catch for the same reason

#### Health Check Reliability
Changed `waitForHealth` to use the `/api/readiness` endpoint (returns 503 until fully initialized) instead of just checking if the port is in use. Callers now wait for *actual* worker readiness, not just network availability.

### 🔄 Refactoring

#### Code Consolidation (-580 lines)
Deleted obsolete process management infrastructure that was replaced by the self-spawn pattern:
- `src/services/process/ProcessManager.ts` (433 lines) - PID management now in worker-service
- `src/cli/worker-cli.ts` (81 lines) - CLI handling now in worker-service
- `src/services/worker-wrapper.ts` (157 lines) - Replaced by `--daemon` flag

#### Updated Hook Commands
All hooks now use `worker-service.cjs` CLI directly instead of the deleted `worker-cli.js`.

### ⏱️ Timeout Adjustments

Increased timeouts throughout for compatibility with slow systems:

| Component | Before | After |
|-----------|--------|-------|
| Default hook timeout | 120s | 300s |
| Health check timeout | 1s | 30s |
| Health check retries | 15 | 300 |
| Context initialization | 30s | 300s |
| MCP connection | 15s | 300s |
| PowerShell commands | 5s | 60s |
| Git commands | 30s | 300s |
| NPM install | 120s | 600s |
| Hook worker commands | 30s | 180s |

### 🧪 Testing

Added comprehensive test suites:
- `tests/hook-constants.test.ts` - Validates timeout configurations
- `tests/worker-spawn.test.ts` - Tests worker CLI and health endpoints

### 🛡️ Additional Robustness

- PID validation in restart command (matches start command behavior)
- Try/catch around `forceKillProcess()` for graceful shutdown
- Try/catch around `getChildProcesses()` for Windows failures
- Improved logging for PID file operations and HTTP shutdown

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.0...v8.2.1

