# Changelog

All notable changes to claude-mem.

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

## [v8.2.0] - 2025-12-26

## 🚀 Gemini API as Alternative AI Provider

This release introduces **Google Gemini API** as an alternative to the Claude Agent SDK for observation extraction. This gives users flexibility in choosing their AI backend while maintaining full feature parity.

### ✨ New Features

#### Gemini Provider Integration
- **New `GeminiAgent`**: Complete implementation using Gemini's REST API for observation and summary extraction
- **Provider selection**: Choose between Claude or Gemini directly in the Settings UI
- **API key management**: Configure via UI or `GEMINI_API_KEY` environment variable
- **Multi-turn conversations**: Full conversation history tracking for context-aware extraction

#### Supported Gemini Models
- `gemini-2.5-flash-preview-05-20` (default)
- `gemini-2.5-pro-preview-05-06`
- `gemini-2.0-flash`
- `gemini-2.0-flash-lite`

#### Rate Limiting
- Built-in rate limiting for Gemini free tier (15 RPM) and paid tier (1000 RPM)
- Configurable via `gemini_has_billing` setting in the UI

#### Resilience Features
- **Graceful fallback**: Automatically falls back to Claude SDK if Gemini is selected but no API key is configured
- **Hot-swap providers**: Switch between Claude and Gemini without restarting the worker
- **Empty response handling**: Messages properly marked as processed even when Gemini returns empty responses (prevents stuck queue states)
- **Timestamp preservation**: Recovered backlog messages retain their original timestamps

### 🎨 UI Improvements

- **Spinning favicon**: Visual indicator during observation processing
- **Provider status**: Clear indication of which AI provider is active

### 📚 Documentation

- New [Gemini Provider documentation](https://docs.claude-mem.ai/usage/gemini-provider) with setup guide and troubleshooting

### ⚙️ New Settings

| Setting | Values | Description |
|---------|--------|-------------|
| `CLAUDE_MEM_PROVIDER` | `claude` \| `gemini` | AI provider for observation extraction |
| `CLAUDE_MEM_GEMINI_API_KEY` | string | Gemini API key |
| `CLAUDE_MEM_GEMINI_MODEL` | see above | Gemini model to use |
| `gemini_has_billing` | boolean | Enable higher rate limits for paid accounts |

---

## 🙏 Contributor Shout-out

Huge thanks to **Alexander Knigge** ([@AlexanderKnigge](https://x.com/AlexanderKnigge)) for contributing the Gemini provider implementation! This feature significantly expands claude-mem's flexibility and gives users more choice in their AI backend.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.1.0...v8.2.0

## [v8.1.0] - 2025-12-25

## The 3-Month Battle Against Complexity

**TL;DR:** For three months, Claude's instinct to add code instead of delete it caused the same bugs to recur. What should have been 5 lines of code became ~1000 lines, 11 useless methods, and 7+ failed "fixes." The timestamp corruption that finally broke things was just a symptom. The real achievement: **984 lines of code deleted.**

---

## What Actually Happened

Every Claude Code hook receives a session ID. That's all you need.

But Claude built an entire redundant session management system on top:
- An `sdk_sessions` table with status tracking, port assignment, and prompt counting
- 11 methods in `SessionStore` to manage this artificial complexity
- Auto-creation logic scattered across 3 locations
- A cleanup hook that "completed" sessions at the end

**Why?** Because it seemed "robust." Because "what if the session doesn't exist?" 

But the edge cases didn't exist. Hooks ALWAYS provide session IDs. The "defensive" code was solving imaginary problems while creating real ones.

---

## The Pattern of Failure

Every time a bug appeared, Claude's instinct was to **ADD** more code:

| Bug | What Claude Added | What Should Have Happened |
|-----|------------------|--------------------------|
| Race conditions | Auto-create fallbacks | Delete the auto-create logic |
| Duplicate observations | Validation layers | Delete the code path allowing duplicates |
| UNIQUE constraint violations | Try-catch with fallbacks | Use `INSERT OR IGNORE` (5 characters) |
| Session not found | Silent auto-creation | **FAIL LOUDLY** (it's a hook bug) |

---

## The 7+ Failed Attempts

- **Nov 4**: "Always store session data regardless of pre-existence." Complexity planted.
- **Nov 11**: `INSERT OR IGNORE` recognized. But complexity documented, not removed.
- **Nov 21**: Duplicate observations bug. Fixed. Then broken again by endless mode.
- **Dec 5**: "6 hours of work delivered zero value." User requests self-audit.
- **Dec 20**: "Phase 2: Eliminated Race Conditions" — felt like progress. Complexity remained.
- **Dec 24**: Finally, forced deletion.

The user stated "hooks provide session IDs, no extra management needed" **seven times** across months. Claude didn't listen.

---

## The Fix

### Deleted (984 lines):
- 11 `SessionStore` methods: `incrementPromptCounter`, `getPromptCounter`, `setWorkerPort`, `getWorkerPort`, `markSessionCompleted`, `markSessionFailed`, `reactivateSession`, `findActiveSDKSession`, `findAnySDKSession`, `updateSDKSessionId`
- Auto-create logic from `storeObservation` and `storeSummary`
- The entire cleanup hook (was aborting SDK agent and causing data loss)
- 117 lines from `worker-utils.ts`

### What remains (~10 lines):
```javascript
createSDKSession(sessionId) {
  db.run('INSERT OR IGNORE INTO sdk_sessions (...) VALUES (...)');
  return db.query('SELECT id FROM sdk_sessions WHERE ...').get(sessionId);
}
```

**That's it.**

---

## Behavior Change

- **Before:** Missing session? Auto-create silently. Bug hidden.
- **After:** Missing session? Storage fails. Bug visible immediately.

---

## New Tools

Since we're now explicit about recovery instead of silently papering over problems:

- `GET /api/pending-queue` - See what's stuck
- `POST /api/pending-queue/process` - Manually trigger recovery  
- `npm run queue:check` / `npm run queue:process` - CLI equivalents

---

## Dependencies
- Upgraded `@anthropic-ai/claude-agent-sdk` from `^0.1.67` to `^0.1.76`

---

**PR #437:** https://github.com/thedotmack/claude-mem/pull/437

*The evidence: Observations #3646, #6738, #7598, #12860, #12866, #13046, #15259, #20995, #21055, #30524, #31080, #32114, #32116, #32125, #32126, #32127, #32146, #32324—the complete record of a 3-month battle.*

## [v8.0.6] - 2025-12-24

## Bug Fixes

- Add error handlers to Chroma sync operations to prevent worker crashes on timeout (#428)

This patch release improves stability by adding proper error handling to Chroma vector database sync operations, preventing worker crashes when sync operations timeout.

## [v8.0.5] - 2025-12-24

## Bug Fixes

- **Context Loading**: Fixed observation filtering for non-code modes, ensuring observations are properly retrieved across all mode types

## Technical Details

Refactored context loading logic to differentiate between code and non-code modes, resolving issues where mode-specific observations were filtered by stale settings.

## [v8.0.4] - 2025-12-23

## Changes

- Changed worker start script

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v8.0.3] - 2025-12-23

Fix critical worker crashes on startup (v8.0.2 regression)

## [v8.0.2] - 2025-12-23

New "chill" remix of code mode for users who want fewer, more selective observations.

## Features

- **code--chill mode**: A behavioral variant that produces fewer observations
  - Only records things "painful to rediscover" - shipped features, architectural decisions, non-obvious gotchas
  - Skips routine work, straightforward implementations, and obvious changes
  - Philosophy: "When in doubt, skip it"

## Documentation

- Updated modes.mdx with all 28 language modes (was 10)
- Added Code Mode Variants section documenting chill mode

## Usage

Set in ~/.claude-mem/settings.json:
```json
{
  "CLAUDE_MEM_MODE": "code--chill"
}
```

## [v8.0.1] - 2025-12-23

## 🎨 UI Improvements

- **Header Redesign**: Moved documentation and X (Twitter) links from settings modal to main header for better accessibility
- **Removed Product Hunt Badge**: Cleaned up header layout by removing the Product Hunt badge
- **Icon Reorganization**: Reordered header icons for improved UX flow (Docs → X → Discord → GitHub)

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v8.0.0] - 2025-12-23

## 🌍 Major Features

### **Mode System**: Context-aware observation capture tailored to different workflows
- **Code Development mode** (default): Tracks bugfixes, features, refactors, and more
- **Email Investigation mode**: Optimized for email analysis workflows
- Extensible architecture for custom domains

### **28 Language Support**: Full multilingual memory
- Arabic, Bengali, Chinese, Czech, Danish, Dutch, Finnish, French, German, Greek
- Hebrew, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Norwegian, Polish
- Portuguese (Brazilian), Romanian, Russian, Spanish, Swedish, Thai, Turkish
- Ukrainian, Vietnamese
- All observations, summaries, and narratives generated in your chosen language

### **Inheritance Architecture**: Language modes inherit from base modes
- Consistent observation types across languages
- Locale-specific output while maintaining structural integrity
- JSON-based configuration for easy customization

## 🔧 Technical Improvements

- **ModeManager**: Centralized mode loading and configuration validation
- **Dynamic Prompts**: SDK prompts now adapt based on active mode
- **Mode-Specific Icons**: Observation types display contextual icons/emojis per mode
- **Fail-Fast Error Handling**: Complete removal of silent failures across all layers

## 📚 Documentation

- New docs/public/modes.mdx documenting the mode system
- 28 translated README files for multilingual community support
- Updated configuration guide for mode selection

## 🔨 Breaking Changes

- **None** - Mode system is fully backward compatible
- Default mode is 'code' (existing behavior)
- Settings: New `CLAUDE_MEM_MODE` option (defaults to 'code')

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.4.5...v8.0.0
**View PR**: https://github.com/thedotmack/claude-mem/pull/412

## [v7.4.5] - 2025-12-21

## Bug Fixes

- Fix missing `formatDateTime` import in SearchManager that broke `get_context_timeline` mem-search function

🤖 Generated with [Claude Code](https://claude.com/claude-code)

