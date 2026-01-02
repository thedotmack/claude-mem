# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [8.5.3] - 2026-01-02

Release v8.5.3

## [8.5.2] - 2025-12-31

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

## [8.5.1] - 2025-12-30

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

## [8.5.0] - 2025-12-30

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

## [8.2.10] - 2025-12-30

## Bug Fixes

- **Auto-restart worker on version mismatch** (#484): When the plugin updates but the worker was already running on the old version, the worker now automatically restarts instead of failing with 400 errors.

### Changes
- `/api/version` endpoint now returns the built-in version (compiled at build time) instead of reading from disk
- `worker-service start` command checks for version mismatch and auto-restarts if needed
- Downgraded hook version mismatch warning to debug logging (now handled by auto-restart)

Thanks @yungweng for the detailed bug report!

## [8.2.9] - 2025-12-29

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

## [8.2.8] - 2025-12-29

## Bug Fixes

- Fixed orphaned chroma-mcp processes during shutdown (#489)
  - Added graceful shutdown handling with signal handlers registered early in WorkerService lifecycle
  - Ensures ChromaSync subprocess cleanup even when interrupted during initialization
  - Removes PID file during shutdown to prevent stale process tracking

## Technical Details

This patch release addresses a race condition where SIGTERM/SIGINT signals arriving during ChromaSync initialization could leave orphaned chroma-mcp processes. The fix moves signal handler registration from the start() method to the constructor, ensuring cleanup handlers exist throughout the entire initialization lifecycle.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.7...v8.2.8

## [8.2.7] - 2025-12-29

## What's Changed

### Token Optimizations
- Simplified MCP server tool definitions for reduced token usage
- Removed outdated troubleshooting and mem-search skill documentation
- Enhanced search parameter descriptions for better clarity
- Streamlined MCP workflows for improved efficiency

This release significantly reduces the token footprint of the plugin's MCP tools and documentation.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.6...v8.2.7

## [8.2.6] - 2025-12-29

## What's Changed

### Bug Fixes & Improvements
- Session ID semantic renaming for clarity (content_session_id, memory_session_id)
- Queue system simplification with unified processing logic
- Memory session ID capture for agent resume functionality
- Comprehensive test suite for session ID refactoring

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.5...v8.2.6

## [8.2.5] - 2025-12-28

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

## [8.2.4] - 2025-12-28

Patch release v8.2.4

## [8.2.3] - 2025-12-27

## Bug Fixes

- Fix worker port environment variable in smart-install script
- Implement file-based locking mechanism for worker operations to prevent race conditions
- Fix restart command references in documentation (changed from `claude-mem restart` to `npm run worker:restart`)

## [8.2.2] - 2025-12-27

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

## [8.2.1] - 2025-12-27

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

## [8.2.0] - 2025-12-26

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

## [8.1.0] - 2025-12-25

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

## [8.0.6] - 2025-12-24

## Bug Fixes

- Add error handlers to Chroma sync operations to prevent worker crashes on timeout (#428)

This patch release improves stability by adding proper error handling to Chroma vector database sync operations, preventing worker crashes when sync operations timeout.

## [8.0.5] - 2025-12-24

## Bug Fixes

- **Context Loading**: Fixed observation filtering for non-code modes, ensuring observations are properly retrieved across all mode types

## Technical Details

Refactored context loading logic to differentiate between code and non-code modes, resolving issues where mode-specific observations were filtered by stale settings.

## [8.0.4] - 2025-12-23

## Changes

- Changed worker start script

## [8.0.3] - 2025-12-23

Fix critical worker crashes on startup (v8.0.2 regression)

## [8.0.2] - 2025-12-23

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

## [8.0.1] - 2025-12-23

## 🎨 UI Improvements

- **Header Redesign**: Moved documentation and X (Twitter) links from settings modal to main header for better accessibility
- **Removed Product Hunt Badge**: Cleaned up header layout by removing the Product Hunt badge
- **Icon Reorganization**: Reordered header icons for improved UX flow (Docs → X → Discord → GitHub)

## [8.0.0] - 2025-12-23

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

## [7.4.5] - 2025-12-21

## Bug Fixes

- Fix missing `formatDateTime` import in SearchManager that broke `get_context_timeline` mem-search function

## [7.4.4] - 2025-12-21

## What's Changed

* Code quality: comprehensive nonsense audit cleanup (20 issues) by @thedotmack in #400

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.4.3...v7.4.4

## [7.4.3] - 2025-12-20

Added Discord notification script for release announcements.

### Added
- `scripts/discord-release-notify.js` - Posts formatted release notifications to Discord using webhook URL from `.env`
- `npm run discord:notify <version>` - New npm script to trigger Discord notifications
- Updated version-bump skill workflow to include Discord notification step

### Configuration
Set `DISCORD_UPDATES_WEBHOOK` in your `.env` file to enable release notifications.

## [7.4.2] - 2025-12-20

Patch release v7.4.2

## Changes
- Refactored worker commands from npm scripts to claude-mem CLI
- Added path alias script
- Fixed Windows worker stop/restart reliability (#395)
- Simplified build commands section in CLAUDE.md

## [7.4.1] - 2025-12-19

## Bug Fixes

- **MCP Server**: Redirect logs to stderr to preserve JSON-RPC protocol (#396)
  - MCP uses stdio transport where stdout is reserved for JSON-RPC messages
  - Console.log was writing startup logs to stdout, causing Claude Desktop to parse log lines as JSON and fail

## [7.4.0] - 2025-12-18

## What's New

### MCP Tool Token Reduction

Optimized MCP tool definitions for reduced token consumption in Claude Code sessions through progressive parameter disclosure.

**Changes:**
- Streamlined MCP tool schemas with minimal inline definitions
- Added `get_schema()` tool for on-demand parameter documentation
- Enhanced worker API with operation-based instruction loading

This release improves session efficiency by reducing the token overhead of MCP tool definitions while maintaining full functionality through progressive disclosure.

## [7.3.9] - 2025-12-18

## Fixes

- Fix MCP server compatibility and web UI path resolution

This patch release addresses compatibility issues with the MCP server and resolves path resolution problems in the web UI.

## [7.3.8] - 2025-12-18

## Security Fix

Added localhost-only protection for admin endpoints to prevent DoS attacks when worker service is bound to 0.0.0.0 for remote UI access.

### Changes
- Created `requireLocalhost` middleware to restrict admin endpoints
- Applied to `/api/admin/restart` and `/api/admin/shutdown`
- Returns 403 Forbidden for non-localhost requests

### Security Impact
Prevents unauthorized shutdown/restart of worker service when exposed on network.

Fixes security concern raised in #368.

## [7.3.7] - 2025-12-17

## Windows Platform Stabilization

This patch release includes comprehensive improvements for Windows platform stability and reliability.

### Key Improvements

- **Worker Readiness Tracking**: Added `/api/readiness` endpoint with MCP/SDK initialization flags to prevent premature connection attempts
- **Process Tree Cleanup**: Implemented recursive process enumeration on Windows to prevent zombie socket processes  
- **Bun Runtime Migration**: Migrated worker wrapper from Node.js to Bun for consistency and reliability
- **Centralized Project Name Utility**: Consolidated duplicate project name extraction logic with Windows drive root handling
- **Enhanced Error Messages**: Added platform-aware logging and detailed Windows troubleshooting guidance
- **Subprocess Console Hiding**: Standardized `windowsHide: true` across all child process spawns to prevent console window flashing

### Technical Details

- Worker service tracks MCP and SDK readiness states separately
- ChromaSync service properly tracks subprocess PIDs for Windows cleanup
- Worker wrapper uses Bun runtime with enhanced socket cleanup via process tree enumeration
- Increased timeouts on Windows platform (30s worker startup, 10s hook timeouts)
- Logger utility includes platform and PID information for better debugging

This represents a major reliability improvement for Windows users, eliminating common issues with worker startup failures, orphaned processes, and zombie sockets.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.6...v7.3.7

## [7.3.6] - 2025-12-17

## Bug Fixes

- Enhanced SDKAgent response handling and message processing

## [7.3.5] - 2025-12-17

## What's Changed
* fix(windows): solve zombie port problem with wrapper architecture by @ToxMox in https://github.com/thedotmack/claude-mem/pull/372
* chore: bump version to 7.3.5 by @thedotmack in https://github.com/thedotmack/claude-mem/pull/375

## New Contributors
* @ToxMox made their first contribution in https://github.com/thedotmack/claude-mem/pull/372

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.4...v7.3.5

## [7.3.4] - 2025-12-17

Patch release for bug fixes and minor improvements

## [7.3.3] - 2025-12-16

## What's Changed

- Remove all better-sqlite3 references from codebase (#357)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.2...v7.3.3

## [7.3.2] - 2025-12-16

## 🪟 Windows Console Fix

Fixes blank console windows appearing for Windows 11 users during claude-mem operations.

### What Changed

- **Windows**: Uses PowerShell `Start-Process -WindowStyle Hidden` to properly hide worker process
- **Security**: Added PowerShell string escaping to follow security best practices
- **Unix/Mac**: No changes (continues to work as before)

### Root Cause

The issue was caused by a Node.js limitation where `windowsHide: true` doesn't work with `detached: true` in `child_process.spawn()`. This affects both Bun and Node.js since Bun inherits Node.js process spawning semantics.

See: https://github.com/nodejs/node/issues/21825

### Security Note

While all paths in the PowerShell command are application-controlled (not user input), we've added proper escaping to follow security best practices. If an attacker could modify bun installation paths or plugin directories, they would already have full filesystem access including the database.

### Related

- Fixes #304 (Multiple visible console windows)
- Merged PR #339
- Testing documented in PR #315

### Breaking Changes

None - fully backward compatible.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.1...v7.3.2

## [7.3.1] - 2025-12-16

## 🐛 Bug Fixes

### Pending Messages Cleanup (Issue #353)

Fixed unbounded database growth in the `pending_messages` table by implementing proper cleanup logic:

- **Content Clearing**: `markProcessed()` now clears `tool_input` and `tool_response` when marking messages as processed, preventing duplicate storage of transcript data that's already saved in observations
- **Count-Based Retention**: `cleanupProcessed()` now keeps only the 100 most recent processed messages for UI display, deleting older ones automatically
- **Automatic Cleanup**: Cleanup runs automatically after processing messages in `SDKAgent.processSDKResponse()`

### What This Fixes

- Prevents database from growing unbounded with duplicate transcript content
- Keeps metadata (tool_name, status, timestamps) for recent messages
- Maintains UI functionality while optimizing storage

### Technical Details

**Files Modified:**
- `src/services/sqlite/PendingMessageStore.ts` - Cleanup logic implementation
- `src/services/worker/SDKAgent.ts` - Periodic cleanup calls

**Database Behavior:**
- Pending/processing messages: Keep full transcript data (needed for processing)
- Processed messages: Clear transcript, keep metadata only (observations already saved)
- Retention: Last 100 processed messages for UI feedback

### Related

- Fixes #353 - Observations not being saved
- Part of the pending messages persistence feature (from PR #335)

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.0...v7.3.1

## [7.3.0] - 2025-12-16

## Features

- **Table-based search output**: Unified timeline formatting with cleaner, more organized presentation of search results grouped by date and file
- **Simplified API**: Removed unused format parameter from MCP search tools for cleaner interface
- **Shared formatting utilities**: Extracted common timeline formatting logic into reusable module
- **Batch observations endpoint**: Added `/api/observations/batch` endpoint for efficient retrieval of multiple observations by ID array

## Changes

- **Default model upgrade**: Changed default model from Haiku to Sonnet for better observation quality
- **Removed fake URIs**: Replaced claude-mem:// pseudo-protocol with actual HTTP API endpoints for citations

## Bug Fixes

- Fixed undefined debug function calls in MCP server
- Fixed skillPath variable scoping bug in instructions endpoint
- Extracted magic numbers to named constants for better code maintainability

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.4...v7.3.0

## [7.2.4] - 2025-12-15

## What's Changed

### Documentation
- Updated endless mode setup instructions with improved configuration guidance for better user experience

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.3...v7.2.4

## [7.2.3] - 2025-12-15

## Bug Fixes

- **Fix MCP server failures on plugin updates**: Add 2-second pre-restart delay in `ensureWorkerVersionMatches()` to give files time to sync before killing the old worker. This prevents the race condition where the worker restart happened too quickly after plugin file updates, causing "Worker service connection failed" errors.

## Changes

- Add `PRE_RESTART_SETTLE_DELAY` constant (2000ms) to `hook-constants.ts`
- Add delay before `ProcessManager.restart()` call in `worker-utils.ts`
- Fix pre-existing bug where `port` variable was undefined in error logging

## [7.2.2] - 2025-12-15

## Changes

- **Refactor:** Consolidate mem-search skill, remove desktop-skill duplication
  - Delete separate `desktop-skill/` directory (was outdated)
  - Generate `mem-search.zip` during build from `plugin/skills/mem-search/`
  - Update docs with correct MCP tool list and new download path
  - Single source of truth for Claude Desktop skill

## [7.2.1] - 2025-12-14

## Translation Script Enhancements

This release adds powerful enhancements to the README translation system, supporting 35 languages with improved efficiency and caching.

### What's New

**Translation Script Improvements:**
- **Caching System**: Smart `.translation-cache.json` tracks content hashes to skip re-translating unchanged content
- **Parallel Processing**: `--parallel <n>` flag enables concurrent translations for faster execution
- **Force Re-translation**: `--force` flag to override cache when needed
- **Tier-Based Scripts**: Organized translation workflows by language priority
  - `npm run translate:tier1` - 7 major languages (Chinese, Japanese, Korean, etc.)
  - `npm run translate:tier2` - 8 strong tech scene languages (Hebrew, Arabic, Russian, etc.)
  - `npm run translate:tier3` - 7 emerging markets (Vietnamese, Indonesian, Thai, etc.)
  - `npm run translate:tier4` - 6 additional languages (Italian, Greek, Hungarian, etc.)
  - `npm run translate:all` - All 35 languages sequentially
- **Better Output Handling**: Automatically strips markdown code fences if Claude wraps output
- **Translation Disclaimer**: Adds community correction notice at top of translated files
- **Performance**: Uses Bun runtime for faster execution

### Supported Languages (35 Total)

Arabic, Bengali, Brazilian Portuguese, Bulgarian, Chinese (Simplified), Chinese (Traditional), Czech, Danish, Dutch, Estonian, Finnish, French, German, Greek, Hebrew, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Latvian, Lithuanian, Norwegian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Thai, Turkish, Ukrainian, Vietnamese

### Breaking Changes

None - fully backward compatible.

### Installation

```bash
# Update via npm
npm install -g claude-mem@7.2.1

# Or reinstall plugin
claude plugin install thedotmack/claude-mem
```

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.0...v7.2.1

## [7.2.0] - 2025-12-14

## 🎉 New Features

### Automated Bug Report Generator

Added comprehensive bug report tool that streamlines issue reporting with AI assistance:

- **Command**: `npm run bug-report`
- **🌎 Multi-language Support**: Write in ANY language, auto-translates to English
- **📊 Smart Diagnostics**: Automatically collects:
  - Version information (claude-mem, Claude Code, Node.js, Bun)
  - Platform details (OS, version, architecture)
  - Worker status (running state, PID, port, uptime, stats)
  - Last 50 lines of logs (worker + silent debug)
  - Database info and configuration settings
- **🤖 AI-Powered**: Uses Claude Agent SDK to generate professional GitHub issues
- **📝 Interactive**: Multiline input support with intuitive prompts
- **🔒 Privacy-Safe**: 
  - Auto-sanitizes all file paths (replaces home directory with ~)
  - Optional `--no-logs` flag to exclude logs
- **⚡ Streaming Progress**: Real-time character count and animated spinner
- **🌐 One-Click Submit**: Auto-opens GitHub with pre-filled title and body

### Usage

From the plugin directory:
```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

**Plugin Paths:**
- macOS/Linux: `~/.claude/plugins/marketplaces/thedotmack`
- Windows: `%USERPROFILE%\.claude\plugins\marketplaces\thedotmack`

**Options:**
```bash
npm run bug-report --no-logs    # Skip logs for privacy
npm run bug-report --verbose    # Show all diagnostics
npm run bug-report --help       # Show help
```

## 📚 Documentation

- Updated README with bug report section and usage instructions
- Enhanced GitHub issue template to feature automated tool
- Added platform-specific directory paths

## 🔧 Technical Details

**Files Added:**
- `scripts/bug-report/cli.ts` - Interactive CLI entry point
- `scripts/bug-report/index.ts` - Core logic with Agent SDK integration
- `scripts/bug-report/collector.ts` - System diagnostics collector

**Files Modified:**
- `package.json` - Added bug-report script
- `README.md` - New Bug Reports section
- `.github/ISSUE_TEMPLATE/bug_report.md` - Updated with automated tool instructions

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.15...v7.2.0

## [7.1.15] - 2025-12-14

## 🐛 Bug Fixes

**Worker Service Initialization**
- Fixed 404 error on `/api/context/inject` during worker startup
- Route is now registered immediately instead of after database initialization
- Prevents race condition on fresh installs and restarts
- Added integration test for early context inject route access

## Technical Details

The context hook was failing with `Cannot GET /api/context/inject` because the route was registered only after database initialization completed. This created a race condition where the hook could attempt to access the endpoint before it existed.

**Implementation:**
- Added `initializationComplete` Promise to track async background initialization
- Register `/api/context/inject` route immediately in `setupRoutes()`
- Early handler blocks requests until initialization resolves (30s timeout)
- Route handler duplicates logic from `SearchRoutes.handleContextInject` by design to prevent 404s

**Testing:**
- Added integration test verifying route registration and timeout handling

Fixes #305
Related: PR #310

## [7.1.14] - 2025-12-14

## Enhanced Error Handling & Logging

This patch release improves error message quality and logging across the claude-mem system.

### Error Message Improvements

**Standardized Hook Error Handling**
- Created shared error handlers (`handleFetchError`, `handleWorkerError`) for consistent error messages
- Platform-aware restart instructions (macOS, Linux, Windows) with correct commands
- Migrated all hooks (context, new, save, summary) to use standardized handlers
- Enhanced error logging with actionable context before throwing restart instructions

**ChromaSync Error Standardization**
- Consistent client initialization checks across all methods
- Enhanced error messages with troubleshooting steps and restart instructions
- Better context about which operation failed

**Worker Service Improvements**
- Enhanced version endpoint error logging with status codes and response text
- Improved worker restart error messages with PM2 commands
- Better context in all worker-related error scenarios

### Bug Fixes

- **Issue #260**: Fixed `happy_path_error__with_fallback` misuse in save-hook causing false "Missing cwd" errors
- Removed unnecessary `happy_path_error` calls from SDKAgent that were masking real error messages
- Cleaned up migration logging to use `console.log` instead of `console.error` for non-error events

### Logging Improvements

**Timezone-Aware Timestamps**
- Worker logs now use local machine timezone instead of UTC
- Maintains same format (`YYYY-MM-DD HH:MM:SS.mmm`) but reflects local time
- Easier debugging and log correlation with system events
- Enhanced worker-cli logging output format

### Test Coverage

Added comprehensive test suites:
- `tests/error-handling/hook-error-logging.test.ts` - 12 tests for hook error handler behavior
- `tests/services/chroma-sync-errors.test.ts` - ChromaSync error message consistency
- `tests/integration/hook-execution-environments.test.ts` - Bun PATH resolution across shells
- `docs/context/TEST_AUDIT_2025-12-13.md` - Comprehensive audit report

### Files Changed

27 files changed: 1,435 additions, 200 deletions

**What's Changed**
* Standardize and enhance error handling across hooks and worker service by @thedotmack in #295
* Timezone-aware logging for worker service and CLI
* Complete build with all plugin files included

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.12...v7.1.14

## [7.1.13] - 2025-12-14

## Enhanced Error Handling & Logging

This patch release improves error message quality and logging across the claude-mem system.

### Error Message Improvements

**Standardized Hook Error Handling**
- Created shared error handlers (`handleFetchError`, `handleWorkerError`) for consistent error messages
- Platform-aware restart instructions (macOS, Linux, Windows) with correct commands
- Migrated all hooks (context, new, save, summary) to use standardized handlers
- Enhanced error logging with actionable context before throwing restart instructions

**ChromaSync Error Standardization**
- Consistent client initialization checks across all methods
- Enhanced error messages with troubleshooting steps and restart instructions
- Better context about which operation failed

**Worker Service Improvements**
- Enhanced version endpoint error logging with status codes and response text
- Improved worker restart error messages with PM2 commands
- Better context in all worker-related error scenarios

### Bug Fixes

- **Issue #260**: Fixed `happy_path_error__with_fallback` misuse in save-hook causing false "Missing cwd" errors
- Removed unnecessary `happy_path_error` calls from SDKAgent that were masking real error messages
- Cleaned up migration logging to use `console.log` instead of `console.error` for non-error events

### Logging Improvements

**Timezone-Aware Timestamps**
- Worker logs now use local machine timezone instead of UTC
- Maintains same format (`YYYY-MM-DD HH:MM:SS.mmm`) but reflects local time
- Easier debugging and log correlation with system events

### Test Coverage

Added comprehensive test suites:
- `tests/error-handling/hook-error-logging.test.ts` - 12 tests for hook error handler behavior
- `tests/services/chroma-sync-errors.test.ts` - ChromaSync error message consistency
- `tests/integration/hook-execution-environments.test.ts` - Bun PATH resolution across shells
- `docs/context/TEST_AUDIT_2025-12-13.md` - Comprehensive audit report

### Files Changed

27 files changed: 1,435 additions, 200 deletions

**What's Changed**
* Standardize and enhance error handling across hooks and worker service by @thedotmack in #295
* Timezone-aware logging for worker service

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.12...v7.1.13

## [7.1.12] - 2025-12-14

## What's Fixed

- **Fix data directory creation**: Ensure `~/.claude-mem/` directory exists before writing PM2 migration marker file
  - Fixes ENOENT errors on first-time installation (issue #259)
  - Adds `mkdirSync(dataDir, { recursive: true })` in `startWorker()` before marker file write
  - Resolves Windows installation failures introduced in f923c0c and exposed in 5d4e71d

## Changes

- Added directory creation check in `src/shared/worker-utils.ts`
- All 52 tests passing

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.11...v7.1.12

## [7.1.11] - 2025-12-14

## What's Changed

**Refactor: Simplified hook execution by removing bun-wrapper indirection**

Hooks are compiled to standard JavaScript and work perfectly with Node. The bun-wrapper was solving a problem that doesn't exist - hooks don't use Bun-specific APIs, they're just HTTP clients to the worker service.

**Benefits:**
- Removes ~100 lines of code
- Simpler cross-platform support (especially Windows)
- No PATH resolution needed for hooks
- Worker still uses Bun where performance matters
- Follows YAGNI and Simple First principles

**Fixes:**
- Fish shell compatibility issue (#264)

**Full Changelog:** https://github.com/thedotmack/claude-mem/compare/v7.1.10...v7.1.11

## [7.1.10] - 2025-12-14

## Enhancement

This release adds automatic orphan cleanup to complement the process leak fix from v7.1.9.

### Added

- **Auto-Cleanup on Startup**: Worker now automatically detects and kills orphaned chroma-mcp processes before starting
  - Scans for existing chroma-mcp processes on worker startup
  - Kills all found processes before creating new ones
  - Logs cleanup activity (process count and PIDs)
  - Non-fatal error handling (continues on cleanup failure)

### Benefits

- Automatically recovers from pre-7.1.9 process leaks without manual intervention
- Ensures clean slate on every worker restart
- Prevents accumulation even if v7.1.9's close() method fails
- No user action required - works transparently

### Example Logs

```
[INFO] [SYSTEM] Cleaning up orphaned chroma-mcp processes {count=2, pids=33753,33750}
[INFO] [SYSTEM] Orphaned processes cleaned up {count=2}
```

### Recommendation

Upgrade from v7.1.9 to get automatic orphan cleanup. Combined with v7.1.9's proper subprocess cleanup, this provides comprehensive protection against process leaks.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.9...v7.1.10

## [7.1.9] - 2025-12-14

## Critical Bugfix

This patch release fixes a critical memory leak that caused chroma-mcp processes to accumulate with each worker restart, leading to memory exhaustion and silent backfill failures.

### Fixed

- **Process Leak Prevention**: ChromaSync now properly cleans up chroma-mcp subprocesses when the worker is restarted
  - Store reference to StdioClientTransport subprocess
  - Explicitly close transport to kill subprocess on shutdown
  - Add error handling to ensure cleanup even on failures
  - Reset all state in finally block

### Impact

- Eliminates process accumulation (16+ orphaned processes seen in production)
- Prevents memory exhaustion from leaked subprocesses (900MB+ RAM usage)
- Fixes silent backfill failures caused by OOM kills
- Ensures graceful cleanup on worker shutdown

### Recommendation

**All users should upgrade immediately** to prevent memory leaks and ensure reliable backfill operation.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.8...v7.1.9

## [7.1.8] - 2025-12-13

## Memory Export/Import Scripts

Added portable memory export and import functionality with automatic duplicate prevention.

### New Features
- **Export memories** to JSON format with search filtering and project-based filtering
- **Import memories** with automatic duplicate detection via composite keys
- Complete documentation in docs/public/usage/export-import.mdx

### Use Cases
- Share memory sets between developers working on the same project
- Backup and restore specific project memories
- Collaborate on domain knowledge across teams
- Migrate memories between different claude-mem installations

### Example Usage
```bash
# Export Windows-related memories
npx tsx scripts/export-memories.ts "windows" windows-work.json

# Export only claude-mem project memories
npx tsx scripts/export-memories.ts "bugfix" fixes.json --project=claude-mem

# Import memories (with automatic duplicate prevention)
npx tsx scripts/import-memories.ts windows-work.json
```

### Technical Improvements
- Fixed JSON format response in /api/search endpoint for consistent structure
- Enhanced project filtering in ChromaDB hybrid search result hydration
- Duplicate detection using composite keys (session ID + title + timestamp)

## [7.1.7] - 2025-12-13

## Fixed
- Removed Windows workaround that was causing libuv assertion failures
- Prioritized stability over cosmetic console window issue

## Known Issue
- On Windows, a console window may briefly appear when the worker starts (cosmetic only, does not affect functionality)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.6...v7.1.7

## [7.1.6] - 2025-12-13

## What's Changed

Improved error messages with platform-specific worker restart instructions for better troubleshooting experience.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.5...v7.1.6

## [7.1.5] - 2025-12-13

## What's Changed

* fix: Use getWorkerHost() instead of hardcoded localhost in MCP server (#276)

### Bug Fix
Fixes Windows IPv6 issue where `localhost` resolves to `::1` (IPv6) but worker binds to `127.0.0.1` (IPv4), causing MCP tool connections to fail.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.4...v7.1.5

## [7.1.4] - 2025-12-13

## What's Changed

* fix: add npm fallback when bun install fails with alias packages (#265)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.3...v7.1.4

## [7.1.3] - 2025-12-13

## Bug Fixes

### Smart Install Script Refactoring

Refactored the smart-install.js script to improve code quality and maintainability:
- Extracted common installation paths as top-level constants (BUN_COMMON_PATHS, UV_COMMON_PATHS)
- Simplified installation check functions to delegate to dedicated path-finding helpers
- Streamlined installation verification logic with clearer error messages
- Removed redundant post-installation verification checks
- Improved error propagation by removing unnecessary retry logic

This refactoring reduces code duplication and makes the installation process more maintainable while preserving the same functionality for detecting Bun and uv binaries across platforms.

## [7.1.2] - 2025-12-13

## 🐛 Bug Fixes

### Windows Installation
- Fixed Bun PATH detection on Windows after fresh install
- Added fallback to check common install paths before PATH reload  
- Improved smart-install.js to use full Bun path when not in PATH
- Added proper path quoting for Windows usernames with spaces

### Worker Startup
- Fixed worker connection failures in Stop hook
- Added health check retry loop (5 attempts, 500ms intervals)
- Worker now waits up to 2.5s for responsiveness before returning
- Improved error detection for Bun's ConnectionRefused error format

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.1...v7.1.2

## [7.1.1] - 2025-12-13

## 🚨 Critical Fixes

### Windows 11 Bun Auto-Install Fixed
- **Problem**: v7.1.0 had a chicken-and-egg bug where `bun smart-install.js` failed if Bun wasn't installed
- **Solution**: SessionStart hook now uses `node` (always available) for smart-install.js
- **Impact**: Fresh Windows installations now work out-of-box

### Path Quoting for Windows
- Fixed `hooks.json` to quote all paths
- Prevents SyntaxError for usernames with spaces (e.g., "C:\Users\John Doe\")

## ✨ New Feature

### Automatic Worker Restart on Version Updates
- Worker now automatically restarts when plugin version changes
- No more manual `npm run worker:restart` needed after upgrades
- Eliminates connection errors from running old worker code

## 📝 Notes

- **No manual actions required** - worker auto-restarts on next session start
- All future upgrades will automatically restart the worker
- Fresh installs on Windows 11 work correctly

## 🔗 Links

- [Full Changelog](https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md#711---2025-12-12)
- [Documentation](https://docs.claude-mem.ai)

## [7.1.0] - 2025-12-13

## Major Architectural Migration

This release completely replaces PM2 with native Bun-based process management and migrates from better-sqlite3 to bun:sqlite.

### Key Changes

**Process Management**
- Replace PM2 with custom Bun-based ProcessManager
- PID file-based process tracking
- Automatic legacy PM2 process cleanup on all platforms

**Database Driver**
- Migrate from better-sqlite3 npm package to bun:sqlite runtime module
- Zero native compilation required
- Same API compatibility

**Auto-Installation**
- Bun runtime auto-installed if missing
- uv (Python package manager) auto-installed for Chroma vector search
- Smart installer with platform-specific methods (curl/PowerShell)

### Migration

**Automatic**: First hook trigger after update performs one-time PM2 cleanup and transitions to new architecture. No user action required.

### Documentation

Complete technical documentation in `docs/PM2-TO-BUN-MIGRATION.md`

## [7.0.11] - 2025-12-12

Patch release adding feature/bun-executable to experimental branch selector for testing Bun runtime integration.

## [7.0.9] - 2025-12-10

## Bug Fixes

- Fixed MCP response format in search route handlers - all 14 search endpoints now return complete response objects with error status instead of just content arrays, restoring MCP protocol compatibility

## Changes

- `SearchRoutes.ts`: Updated all route handlers to return full result object instead of extracted content property

## [7.0.8] - 2025-12-10

## Bug Fixes

- **Critical**: Filter out meta-observations for session-memory files to prevent recursive timeline pollution
  - Memory agent was creating observations about editing Agent SDK's session-memory/summary.md files
  - This created a recursive loop where investigating timeline pollution caused more pollution
  - Filter now skips Edit/Write/Read/NotebookEdit operations on any file path containing 'session-memory'
  - Eliminates 91+ meta-observations that were polluting the timeline

## Technical Details

Added filtering logic in SessionRoutes.ts to detect and skip file operations on session-memory files before observations are queued to the SDK agent. This prevents the memory agent from observing its own observation metadata files.

## [7.0.7] - 2025-12-10

## What's Changed

### Code Quality Improvements
- Refactored hooks codebase to reduce complexity and improve maintainability (#204)
- Net reduction of 78 lines while adding new functionality
- Improved type safety across all hook input interfaces

### New Features
- Added `CLAUDE_MEM_SKIP_TOOLS` configuration setting for controlling which tools are excluded from observations
- Default skip tools: `ListMcpResourcesTool`, `SlashCommand`, `Skill`, `TodoWrite`, `AskUserQuestion`

### Technical Improvements
- Created shared utilities: `transcript-parser.ts`, `hook-constants.ts`, `hook-error-handler.ts`
- Migrated business logic from hooks to worker service for better separation of concerns
- Enhanced error handling and spinner management
- Removed dead code and unnecessary abstractions

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.6...v7.0.7

## [7.0.6] - 2025-12-10

## Bug Fixes

- Fixed Windows terminal spawning to hide terminal windows when spawning child processes (#203, thanks @CrystallDEV)
- Improved worker service process management on Windows

## Contributors

Thanks to @CrystallDEV for this contribution!

## [7.0.5] - 2025-12-09

## What's Changed

### Bug Fixes
- Fixed settings schema inconsistency between write and read operations
- Fixed PowerShell command injection vulnerability in worker-utils.ts
- Enhanced PM2 existence check with clear error messages
- Added error logging to silent tool serialization handlers

### Improvements
- Settings centralization: Migrated to SettingsDefaultsManager across codebase
- Auto-creation of settings.json file with defaults on first run
- Settings schema migration from nested to flat format
- Refactored HTTP-only new-hook implementation
- Cross-platform worker service improvements

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.4...v7.0.5

## [7.0.4] - 2025-12-09

## What's Changed

### Bug Fixes
- **Windows**: Comprehensive fixes for Windows plugin installation
- **Cache**: Add package.json to plugin directory for cache dependency resolution

Thanks to @kat-bell for the excellent contributions!

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.3...v7.0.4

## [7.0.3] - 2025-12-09

## What's Changed

**Refactoring:**
- Completed rename of `search-server` to `mcp-server` throughout codebase
- Updated all documentation references from search-server to mcp-server
- Updated debug log messages to use `[mcp-server]` prefix
- Removed legacy `search-server.cjs` file

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.2...v7.0.3

## [7.0.2] - 2025-12-09

## What's Changed

**Bug Fixes:**
- Improved auto-start worker functionality for better reliability

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.1...v7.0.2

## [7.0.1] - 2025-12-09

## Bug Fixes

- **Hook Execution**: Ensure worker is running at the beginning of all hook files
- **Context Hook**: Replace waitForPort with ensureWorkerRunning for better error handling
- **Reliability**: Move ensureWorkerRunning to start of all hook functions to ensure worker is started before any logic executes

## Technical Changes

- context-hook.ts: Replace waitForPort logic with ensureWorkerRunning
- summary-hook.ts: Move ensureWorkerRunning before input validation
- new-hook.ts: Move ensureWorkerRunning before debug logging
- save-hook.ts: Move ensureWorkerRunning before SKIP_TOOLS check
- cleanup-hook.ts: Move ensureWorkerRunning before silentDebug calls

This ensures more reliable worker startup and clearer error messages when the worker fails to start.

## [7.0.0] - 2025-12-08

# Major Architectural Refactor

This major release represents a complete architectural transformation of claude-mem from a monolithic design to a clean, modular HTTP-based architecture.

## Breaking Changes

**None** - Despite being a major version bump due to the scope of changes, this release maintains full backward compatibility. All existing functionality works exactly as before.

## What Changed

### Hooks → HTTP Clients
- All 5 lifecycle hooks converted from direct database access to lightweight HTTP clients
- Each hook reduced from 400-800 lines to ~75 lines
- Hooks now make simple HTTP calls to the worker service
- Eliminates SQL duplication across hooks - single source of truth in worker

### Worker Service Modularization
- `worker-service.ts` reduced from 1600+ lines to clean orchestration layer
- New route-based HTTP architecture:
  - `SessionRoutes` - Session lifecycle management
  - `DataRoutes` - Database queries (observations, sessions, timeline)
  - `SearchRoutes` - Full-text and semantic search
  - `SettingsRoutes` - Configuration management
  - `ViewerRoutes` - UI endpoints

### New Service Layer
- `BaseRouteHandler` - Centralized error handling, response formatting (used 46x)
- `SessionEventBroadcaster` - Semantic SSE event broadcasting
- `SessionCompletionHandler` - Consolidated session completion logic
- `SettingsDefaultsManager` - Single source of truth for configuration defaults
- `PrivacyCheckValidator` - Centralized privacy tag validation
- `FormattingService` - Dual-format result rendering
- `TimelineService` - Complex markdown timeline formatting
- `SearchManager` - Extracted search logic from context generation

### Database Improvements
- Migrated from \`bun:sqlite\` to \`better-sqlite3\` for broader compatibility
- SQL queries moved from route handlers to \`SessionStore\` for separation of concerns
- \`PaginationHelper\` centralizes paginated queries with LIMIT+1 optimization

### Testing Infrastructure
- New comprehensive happy path tests for full session lifecycle
- Integration tests covering session init, observation capture, search, summaries, cleanup
- Test helpers and mocks for consistent testing patterns

### Type Safety
- Removed 'as any' casts throughout codebase
- New \`src/types/database.ts\` with proper type definitions
- Enhanced null safety in SearchManager

## Stats
- **60 files changed**
- **8,671 insertions, 5,585 deletions**
- Net: ~3,000 lines of new code (mostly tests and new modular services)

## Migration Notes

No migration required! Update and continue using claude-mem as before.

## [6.5.3] - 2025-12-05

## Bug Fixes

- **Windows**: Hide console window when spawning child processes (#166)
  - Adds `windowsHide: true` to `spawnSync` and `execSync` calls
  - Prevents empty terminal windows from appearing on Windows when hooks execute

Reference: https://nodejs.org/api/child_process.html (windowsHide option)

## [6.5.2] - 2025-12-04

## What's Changed

- **Upgraded better-sqlite3** from `^11.0.0` to `^12.5.0` for Node.js 25 compatibility

### Fixes
- Resolves compilation errors when installing on Node.js 25.x (#164)

## [6.5.1] - 2025-12-04

## What's New

- Decorative Product Hunt announcement in terminal with rocket borders
- Product Hunt badge in viewer header with theme-aware switching (light/dark)
- Badge uses separate tracking URL for analytics

## Changes

This is a temporary launch day update. The announcement will auto-expire at midnight EST.

## [6.5.0] - 2025-12-04

## Documentation Overhaul

This release brings comprehensive documentation updates to reflect all features added in v6.4.x and standardize version references across the codebase.

### Changes

**Updated "What's New" Sections:**
- Highlights v6.4.9 Context Configuration Settings (11 new settings)
- Highlights v6.4.0 Dual-Tag Privacy System (`<private>` tags)
- Highlights v6.3.0 Version Channel (beta toggle in UI)

**Key Features Updated:**
- Added 🔒 Privacy Control (`<private>` tags)
- Added ⚙️ Context Configuration settings

**Clarifications:**
- Fixed lifecycle hook count: 5 lifecycle events with 6 hook scripts
- Fixed default model: `claude-haiku-4-5` (not sonnet)
- Removed outdated MCP search server references (replaced by skills in v5.4.0)

**Files Updated:**
- README.md - version badge, features, What's New, default model
- docs/public/introduction.mdx - features, hook count, What's New
- docs/public/installation.mdx - removed MCP reference
- docs/public/configuration.mdx - default model corrections
- plugin/skills/mem-search/operations/help.md - version references

---

📚 Full documentation available at [docs.claude-mem.ai](https://docs.claude-mem.ai)

## [6.4.9] - 2025-12-02

## New Features

This release adds comprehensive context configuration settings, giving users fine-grained control over how memory context is injected at session start.

### Context Configuration (11 new settings)

**Token Economics Display:**
- Control visibility of read tokens, work tokens, savings amount, and savings percentage

**Observation Filtering:**
- Filter by observation types (bugfix, feature, refactor, discovery, decision, change)
- Filter by observation concepts (how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off)

**Display Configuration:**
- Configure number of full observations to include
- Choose which field to show in full (narrative/facts)
- Set number of recent sessions to include

**Feature Toggles:**
- Control inclusion of last session summary
- Control inclusion of final messages from prior session

All settings have sensible defaults and are fully backwards compatible.

### What's Next

**Settings UI enhancements coming very shortly in the next release!** We're working on improving the settings interface for even better user experience.

## Technical Details

- 10 files changed (+825, -212)
- New centralized observation metadata constants
- Enhanced context hook with SQL-based filtering
- Worker service settings validation
- Viewer UI controls for all settings

## [6.4.1] - 2025-12-01

## Hey there, claude-mem community! 👋

We're doing something new and exciting: **our first-ever Live AMA**! 

### 🔴 When You'll See Us Live

**December 1st-5th, 2025**  
**Daily from 5-7pm EST**

During these times, you'll see a live indicator (🔴) when you start a new session, letting you know we're available right now to answer questions, discuss ideas, or just chat about what you're building with claude-mem.

### What Changed in This Release

We've added a smart announcement system that:
- Shows upcoming AMA schedule before/after live hours
- Displays a live indicator (🔴) when we're actively available
- Automatically cleans up after the event ends

### Why We're Doing This

We want to hear from **you**! Whether you're:
- Just getting started with claude-mem
- A power user with feature ideas
- Curious about how memory compression works
- Running into any issues
- Or just want to say hi 👋

This is your chance to connect directly with the developer (@thedotmack) and fellow community members.

### Join the Community

Can't make the live times? No worries! Join our Discord to stay connected:  
**https://discord.gg/J4wttp9vDu**

We're excited to meet you and hear what you're building!

---

## Technical Details

**Changed Files:**
- `src/hooks/user-message-hook.ts` - Added time-aware announcement logic
- Version bumped across all manifests (6.4.0 → 6.4.1)

**Built Artifacts:**
- `plugin/scripts/user-message-hook.js` - Updated compiled hook

---

Looking forward to seeing you at the AMA! 🎉

## [6.4.0] - 2025-12-01

## 🎯 Highlights

This release introduces a powerful **dual-tag privacy system** that gives you fine-grained control over what gets stored in your observation history, along with significant search API improvements.

## ✨ New Features

### Dual-Tag Privacy System
- **`<private>` tags**: User-level privacy control - wrap any sensitive content to prevent storage in observation history
- **`<claude-mem-context>` tags**: System-level tags for auto-injected observations to prevent recursive storage
- Tag stripping happens at the hook layer (edge processing) before data reaches worker/database
- Comprehensive documentation in `docs/public/usage/private-tags.mdx`

### User Experience
- New inline help message in context hook highlighting the `<private>` tag feature
- Improved Community link formatting in startup messages

## 🔧 Improvements

### Search API
- Simplified search endpoint parameters to eliminate bracket encoding issues (#154)
- Cleaner API interface for mem-search skill

### Performance
- Added composite index for user prompts lookup optimization
- Shared tag-stripping utilities in `src/utils/tag-stripping.ts`

## 📚 Documentation

- Updated CLAUDE.md with Privacy Tags section
- Enhanced private-tags.mdx with implementation details
- Added comprehensive test coverage for tag stripping

## 🔗 Related PRs

- #153: Dual-tag system for meta-observation control
- #154: Eliminate bracket encoding in search API parameters

---

💡 **Try it now**: Wrap sensitive data with `<private>your-secret-data</private>` in any message to Claude Code!

## [6.3.7] - 2025-12-01

## Bug Fixes

- **fix: Remove orphaned closing brace in smart-install.js** - Fixes SyntaxError "Missing catch or finally after try" that was preventing the plugin from loading correctly

## What Changed

Fixed a syntax error in `scripts/smart-install.js` where an extra closing brace on line 392 caused the SessionStart hook to fail. The PM2 worker startup try/catch block was properly formed but had an orphaned closing brace that didn't match any opening brace.

This bug was introduced in a recent release and prevented the plugin from loading correctly for users.

## [6.3.6] - 2025-11-30

## Auto-detect and rebuild native modules on Node.js version changes

### Bug Fixes
- **Native Module Compatibility**: Auto-detects Node.js version changes and rebuilds better-sqlite3 when needed
- **Self-healing Recovery**: Gracefully handles ERR_DLOPEN_FAILED errors with automatic reinstall on next session
- **Version Tracking**: Enhanced .install-version marker now tracks both package and Node.js versions (JSON format)
- **Runtime Verification**: Added verifyNativeModules() to catch ABI mismatches and corrupted builds

### Technical Details
This release fixes a critical issue where upgrading Node.js (e.g., v22 → v25) would cause native module failures that the plugin couldn't auto-recover from. The smart-install script now:
- Tracks Node.js version in addition to package version
- Verifies native modules actually load (not just file existence)
- Triggers rebuild when either version changes
- Handles runtime failures gracefully with helpful user messaging

### Contributors
- @dreamiurg - Thank you for the comprehensive fix and thorough testing!

### Merged PRs
- #149 - feat: Auto-detect and rebuild native modules on Node.js version changes

## [6.3.5] - 2025-11-30

## Changes

- ✨ Restored Discord community button in viewer header
- 📱 Added responsive mobile navigation menu
- 🔄 Reorganized Sidebar component for better mobile UX
- 🐛 Fixed missing props being passed to Sidebar component

## Technical Details

- Community button visible in header on desktop (> 600px width)
- Mobile menu icon appears on small screens (≤ 600px width)  
- Sidebar toggles via hamburger menu on mobile
- Both buttons positioned in header for consistent UX

Full changelog: https://github.com/thedotmack/claude-mem/compare/v6.3.4...v6.3.5

## [6.3.4] - 2025-11-30

## Bug Fixes

### Worker Startup Improvements

Fixed critical issues with worker service startup on fresh installations:

- **Auto-start worker after installation** - The PM2 worker now starts automatically during plugin installation
- **Local PM2 resolution** - Plugin now uses local PM2 from node_modules/.bin instead of requiring global installation
- **Improved error messages** - Clear, actionable instructions with full paths when worker fails to start
- **Cross-platform support** - Proper handling of Windows platform differences (pm2.cmd)
- **Security enhancement** - Switched from execSync to spawnSync with array arguments to prevent command injection

These changes significantly improve the first-time installation experience, eliminating the need for manual PM2 setup.

**Special thanks to @dreamiurg for identifying and fixing this critical UX issue!** 🙏

## [6.3.3] - 2025-11-30

Bug fixes and improvements to timeline context feature:

- Added session ID validation to filterTimelineByDepth
- Added timestamp fallback warning
- Exported filterTimelineByDepth function for unit testing
- Fixed type breakdown display in timeline item count

Full changes: https://github.com/thedotmack/claude-mem/compare/v6.3.2...v6.3.3

## [6.3.2] - 2025-11-25

## What's Changed

### Improvements
- Add search query support to `/api/decisions` endpoint - now supports semantic search within decisions using Chroma with `{ type: 'decision' }` metadata filter

### Usage
```bash
# Search within decisions (new)
curl "http://localhost:37777/api/decisions?query=architecture&format=full&limit=5"

# All decisions (existing behavior preserved)
curl "http://localhost:37777/api/decisions?format=index&limit=10"
```

## [6.3.1] - 2025-11-25

## What's New

- Add script to help estimate token savings from on-the-fly replacements

## [6.3.0] - 2025-11-25

## What's New

### Branch-Based Beta Toggle
Added Version Channel section to Settings sidebar allowing users to switch between stable and beta versions directly from the UI.

**Features:**
- See current branch (main or beta/7.0) and stability status
- Switch to beta branch to access Endless Mode features
- Switch back to stable for production use
- Pull updates for current branch

**Implementation:**
- `BranchManager.ts`: Git operations for branch detection/switching
- `worker-service.ts`: `/api/branch/*` endpoints (status, switch, update)
- `Sidebar.tsx`: Version Channel UI with branch state and handlers

## Installation
To update, restart Claude Code or run the plugin installer.

## [6.2.1] - 2025-11-23

## 🐛 Bug Fixes

### Critical: Empty Project Names Breaking Context Injection

**Problem:**
- Observations and summaries created with empty project names
- Context-hook couldn't find recent context (queries `WHERE project = 'claude-mem'`)
- Users saw no observations or summaries in SessionStart since Nov 22

**Root Causes:**

1. **Sessions:** `createSDKSession()` used `INSERT OR IGNORE` for idempotency, but never updated project field when session already existed
2. **In-Memory Cache:** `SessionManager` cached sessions with stale empty project values, even after database was updated

**Fixes:**

- `5d23c60` - fix: Update project name when session already exists in createSDKSession
- `54ef149` - fix: Refresh in-memory session project when updated in database

**Impact:**
- ✅ 364 observations backfilled with correct project names
- ✅ 13 summaries backfilled with correct project names  
- ✅ Context injection now works (shows recent observations and summaries)
- ✅ Future sessions will always have correct project names

## 📦 Full Changelog

**Commits since v6.2.0:**
- `634033b` - chore: Bump version to 6.2.1
- `54ef149` - fix: Refresh in-memory session project when updated in database
- `5d23c60` - fix: Update project name when session already exists in createSDKSession

## [6.2.0] - 2025-11-22

## Major Features

### Unified Search API (#145, #133)
- **Vector-first search architecture**: All text queries now use ChromaDB semantic search
- **Unified /api/search endpoint**: Single endpoint with filter parameters (type, concepts, files)
- **ID-based fetch endpoints**: New GET /api/observation/:id, /api/session/:id, /api/prompt/:id
- **90-day recency filter**: Automatic relevance filtering for search results
- **Backward compatibility**: Legacy endpoints still functional, routing through unified infrastructure

### Search Architecture Cleanup
- **Removed FTS5 fallback code**: Eliminated ~300 lines of deprecated full-text search code
- **Removed experimental contextualize endpoint**: Will be reimplemented as LLM-powered skill (see #132)
- **Simplified mem-search skill**: Streamlined to prescriptive 3-step workflow (Search → Review IDs → Fetch by ID)
- **Better error messages**: Clear guidance when ChromaDB/UVX unavailable

## Bug Fixes

### Search Improvements
- Fixed parameter handling in searchUserPrompts method
- Improved dual-path logic for filter-only vs text queries
- Corrected missing debug output in search API

## Documentation

- Updated CLAUDE.md to reflect vector-first architecture
- Clarified FTS5 tables maintained for backward compatibility only (removal planned for v7.0.0)
- Enhanced mem-search skill documentation with clearer usage patterns
- Added comprehensive test results for search functionality

## Breaking Changes

None - all changes maintain backward compatibility.

## Installation

Users with auto-update enabled will receive this update automatically. To manually update:

\`\`\`bash
# Restart Claude Code or run:
npm run sync-marketplace
\`\`\`

## [6.1.1] - 2025-11-21

## Bug Fixes

### Dynamic Project Name Detection (#142)
- Fixed hardcoded "claude-mem" project name in ChromaSync and search-server
- Now uses `getCurrentProjectName()` to dynamically detect the project based on working directory
- Resolves #140 where all observations were incorrectly tagged with "claude-mem"

### Viewer UI Scrolling
- Simplified overflow CSS to enable proper scrolling in viewer UI
- Removed overcomplicated nested overflow containers
- Fixed issue where feed content wouldn't scroll

## Installation

Users with auto-update enabled will receive this patch automatically. To manually update:

\`\`\`bash
# Restart Claude Code or run:
npm run sync-marketplace
\`\`\`

## [6.1.0] - 2025-11-19

## Viewer UI: Responsive Layout Improvements

The viewer UI now handles narrow screens better with responsive breakpoints:

- Community button relocates to sidebar below 600px width
- Projects dropdown relocates to sidebar below 480px width
- Sidebar constrained to 400px max width

Makes the viewer usable on phones and narrow browser windows.

## [6.0.9] - 2025-11-17

## Queue Depth Indicator Feature

Added a real-time queue depth indicator to the viewer UI that displays the count of active work items (queued + currently processing).

### Features
- Visual badge next to claude-mem logo
- Shows count of pending messages + active SDK generators
- Only displays when queueDepth > 0
- Subtle pulse animation for visual feedback
- Theme-aware styling
- Real-time updates via SSE

### Implementation
- Backend: Added `getTotalActiveWork()` method to SessionManager
- Backend: Updated worker-service to broadcast queueDepth via SSE
- Frontend: Enhanced Header component to display queue bubble
- Frontend: Updated useSSE hook to track queueDepth state
- Frontend: Added CSS styling with pulse animation

### Closes
- #122 - Implement queue depth indicator feature
- #96 - Add real-time queue depth indicator to viewer UI
- #97 - Fix inconsistent queue depth calculation

### Credit
Original implementation by @thedotmack in PR #96
Bug fix by @copilot-swe-agent in PR #97

## [6.0.8] - 2025-11-17

## Critical Fix

This patch release fixes a critical bug where the PM2 worker process would start from the wrong directory (development folder instead of marketplace folder), causing the plugin to malfunction when installed via the marketplace.

### What's Fixed

- **Worker Startup Path Resolution** (`src/shared/worker-utils.ts:61`)  
  Added `cwd: pluginRoot` option to `execSync` when starting PM2
  
  This ensures the worker always starts from the correct marketplace directory (`~/.claude/plugins/marketplaces/thedotmack/`), regardless of where the hook is invoked from.

### Impact

Users will no longer experience issues with the worker starting from the wrong location. The plugin now works correctly when installed via marketplace without manual intervention.

### Verification

Run `pm2 info claude-mem-worker` to verify:
- **exec cwd** should be: `/Users/[username]/.claude/plugins/marketplaces/thedotmack`
- **script path** should be: `/Users/[username]/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs`

## [6.0.7] - 2025-11-17

## Critical Hotfix: Database Migration Issue (#121)

This is an emergency hotfix addressing a critical database migration bug that prevented claude-mem from loading for some users.

### What was fixed

**Issue**: Users were seeing `SqliteError: no such column: discovery_tokens` when starting Claude Code.

**Root Cause**: The `ensureDiscoveryTokensColumn` migration was using version number 7, which was already taken by another migration (`removeSessionSummariesUniqueConstraint`). This duplicate version number caused migration tracking issues in databases that were upgraded through multiple versions.

**Fix**: 
- Changed migration version from 7 to 11 (next available)
- Added explicit schema_versions check to prevent unnecessary re-runs
- Improved error propagation and documentation

### Upgrade Instructions

**If you're experiencing the error:**

Option 1 - Manual fix (preserves history):
```bash
sqlite3 ~/.claude-mem/claude-mem.db "ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0; ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0;"
```

Option 2 - Delete and recreate (loses history):
```bash
rm ~/.claude-mem/claude-mem.db
# Restart Claude Code - database will recreate with correct schema
```

Option 3 - Fresh install:
Just upgrade to v6.0.7 and the migration will work correctly.

### Changes

- **Fixed**: Database migration version conflict (migration 7 → 11) (#121)
- **Improved**: Migration error handling and schema_versions tracking

### Full Changelog

See [CHANGELOG.md](https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md) for complete version history.

---

**Affected Users**: @liadtigloo @notmyself - this release fixes your reported issue. Please try one of the upgrade options above and let me know if the issue persists.

Thanks to everyone who reported this issue with detailed error logs! 🙏

## [6.0.6] - 2025-11-17

## Critical Bugfix Release

### Fixed
- **Database Migration**: Fixed critical bug where `discovery_tokens` migration logic trusted `schema_versions` table without verifying actual column existence (#121)
- Migration now always checks if columns exist before queries, preventing "no such column" errors
- Safe for all users - auto-migrates on next Claude Code session without data loss

### Technical Details
- Removed early return based on `schema_versions` check that could skip actual column verification
- Migration now uses `PRAGMA table_info()` to verify column existence before every query
- Ensures idempotent, safe schema migrations for SQLite databases

### Impact
- Users experiencing "SqliteError: no such column: discovery_tokens" will be automatically fixed
- No manual intervention or database backup required
- Update to v6.0.6 via marketplace or `git pull` and restart Claude Code

**Affected Users**: All users who upgraded to v6.0.5 and experienced the migration error

## [6.0.5] - 2025-11-17

## Changes

### Automatic MCP Server Cleanup
- Automatic cleanup of orphaned MCP server processes on worker startup
- Self-healing maintenance runs on every worker restart
- Prevents orphaned process accumulation and resource leaks

### Improvements
- Removed manual cleanup notice from session context
- Streamlined worker initialization process

## What's Fixed
- Memory leaks from orphaned uvx/python processes are now prevented automatically
- Workers self-heal on every restart without manual intervention

---

**Release Date**: November 16, 2025
**Plugin Version**: 6.0.5

## [6.0.4] - 2025-11-17

**Patch Release**

Fixes memory leaks from orphaned uvx/python processes that could accumulate during ChromaDB operations.

**Changes:**
- Fixed process cleanup in ChromaDB sync operations to prevent orphaned processes
- Improved resource management for external process spawning

**Full Changelog:** https://github.com/thedotmack/claude-mem/compare/v6.0.3...v6.0.4

## [6.0.3] - 2025-11-16

## What's Changed

Documentation alignment release - merged PR #116 fixing hybrid search architecture documentation.

### Documentation Updates
- Added comprehensive  guide
- Updated technical architecture documentation to reflect hybrid ChromaDB + SQLite + timeline context flow
- Fixed skill operation guides to accurately describe semantic search capabilities

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v6.0.2...v6.0.3

## [6.0.2] - 2025-11-14

## Changes

- Updated user message hook with Claude-Mem community discussion link for better user engagement and support

## What's Changed
- Enhanced startup context messaging with community connection information

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v6.0.1...v6.0.2

## [6.0.1] - 2025-11-14

## UI Enhancements

### Changes
- Refined color theme with warmer tones for better visual hierarchy
- New observation card blue/teal theme with distinct light/dark mode values
- Added 8 SVG icon assets for summary card sections (thick and thin variants)
- Enhanced summary card component with icon support for completed, investigated, learned, and next-steps sections
- Updated build system to handle icon asset copying

### Visual Improvements
- Unified color palette refinements across all UI components
- Improved card type differentiation: gold/amber for summaries, purple for prompts, blue/teal for observations
- Better visual consistency in viewer UI

Full changelog: https://github.com/thedotmack/claude-mem/compare/v6.0.0...v6.0.1

## [6.0.0] - 2025-11-13

## What's New

### Major Enhancements

**Session Management**
- Enhanced session initialization to accept userPrompt and promptNumber
- Live userPrompt updates for multi-turn conversations
- Improved SessionManager with better context handling

**Transcript Processing**
- Added comprehensive transcript processing scripts for analysis
- New transcript data structures and parsing utilities
- Rich context extraction capabilities

**Architecture Improvements**
- Refactored hooks and SDKAgent for improved observation handling
- Added silent debug logging utilities
- Better error handling and debugging capabilities

### Documentation
- Added implementation plan for ROI metrics feature
- Added rich context examples and documentation
- Multiple transcript processing examples

### Files Changed
- 39 files changed, 4584 insertions(+), 2809 deletions(-)

## Breaking Changes

This is a major version bump due to significant architectural changes in session management and observation handling. Existing sessions will continue to work, but the internal APIs have evolved.

---

📦 Install via Claude Code: `~/.claude/plugins/marketplaces/thedotmack/`
📖 Documentation: [CLAUDE.md](https://github.com/thedotmack/claude-mem/blob/main/CLAUDE.md)

## [5.5.1] - 2025-11-11

**Breaking Changes**: None (patch version)

**Improvements**:
- Enhanced summary hook to capture last user message from Claude Code session transcripts
- Improved activity indicator that tracks both active sessions and queue depth
- Better user feedback during prompt processing
- More accurate processing status broadcasting

**Technical Details**:
- Modified files:
  - src/hooks/summary-hook.ts (added transcript parser for extracting last user message)
  - src/services/worker-service.ts (enhanced processing status broadcasting)
  - src/services/worker/SessionManager.ts (queue depth tracking for activity indicators)
  - src/services/worker-types.ts (added last_user_message field to SDKSession)
  - src/sdk/prompts.ts (updated summary prompt to include last user message context)
  - src/services/worker/SDKAgent.ts (pass through last user message to SDK)
- Built outputs updated:
  - plugin/scripts/summary-hook.js
  - plugin/scripts/worker-service.cjs

**What Changed**:
The summary hook now reads Claude Code transcript files to extract the last user message before generating session summaries. This provides better context for AI-powered session summarization. The activity indicator now accurately reflects both active sessions and queued work, giving users better feedback about what's happening behind the scenes.

## [5.5.0] - 2025-11-11

**Breaking Changes**: None (minor version)

**Improvements**:
- Merged PR #91: Replace generic "search" skill with enhanced "mem-search" skill
- Improved skill effectiveness from 67% to 100% (Anthropic standards)
- Enhanced scope differentiation to prevent confusion with native conversation memory
- Increased concrete triggers from 44% to 85%
- Added 5+ unique identifiers and explicit exclusion patterns
- Comprehensive documentation reorganization (17 total files)

**Technical Changes**:
- New mem-search skill with system-specific naming
- Explicit temporal keywords ("previous sessions", "weeks/months ago")
- Technical anchors referencing FTS5 full-text index and typed observations
- Documentation moved from /context/ to /docs/context/
- Detailed technical architecture documentation added
- 12 operation guides + 2 principle directories

**Credits**:
- Skill design and enhancement by @basher83

## [5.4.5] - 2025-11-11

**Patch Release**: Bugfixes and minor improvements

## [5.4.4] - 2025-11-10

**Breaking Changes**: None (patch version)

**Bugfix**:
- Fixed duplicate observations and summaries appearing in viewer with different IDs and timestamps
- Root cause: `handleSessionInit` spawned an SDK agent but didn't save the promise to `session.generatorPromise`, causing `handleObservations` to spawn a second agent for the same session

**Technical Details**:
- Modified: src/services/worker-service.ts:265
- Change: Now assigns `session.generatorPromise = this.sdkAgent.startSession(...)` to track the promise
- Impact: Single SDK agent per session (previously two), eliminates duplicate database entries and SSE broadcasts
- Pattern: Matches existing implementation in `handleSummarize` (line 332)
- Guard: Leverages existing condition in `handleObservations` (line 301) that checks for existing promise

**User Impact**:
- No more duplicate entries in the viewer UI
- Cleaner, more accurate memory stream visualization
- Reduced redundant processing and database writes

Merged via PR #86

## [5.4.3] - 2025-11-10

**Breaking Changes**: None (patch version)

**Bug Fixes**:
- Fixed PM2 race condition between watch mode and PostToolUse hook
- Eliminated `TypeError: Cannot read properties of undefined (reading 'pm2_env')` errors
- Reduced unnecessary worker restarts (39+ restarts → minimal)

**Technical Details**:
- Removed PM2 restart logic from `ensureWorkerRunning()` in `src/shared/worker-utils.ts`
- PM2 watch mode now exclusively handles worker restarts on file changes
- Function now only checks worker health via HTTP endpoint and provides clear error messaging
- Removed unused imports and helper functions (`execSync`, `getPackageRoot`, `waitForWorkerHealth`)

**Files Modified**:
- `src/shared/worker-utils.ts` (40 deletions, 14 additions)
- All built hooks and worker service (rebuilt from source)

**Impact**: This fix eliminates error spam in hook output while maintaining full functionality. Users will see cleaner output and fewer unnecessary restarts.

**Upgrade Notes**: No action required. PM2 watch mode will automatically restart the worker on plugin updates.

## [5.4.2] - 2025-11-10

**Bugfix Release**: CWD spatial awareness for SDK agent

### What's Fixed

- **CWD Context Propagation**: SDK agent now receives current working directory (CWD) context from tool executions
- **Spatial Awareness**: Prevents false "file not found" reports when working across multiple repositories
- **Observer Guidance**: Agent prompts now include tool_cwd XML elements with spatial awareness instructions

### Technical Details

**Data Flow**:
1. Hook extracts CWD from PostToolUseInput (`hookInput.result.tool_cwd`)
2. Worker service receives CWD in PendingMessage and ObservationData interfaces
3. SessionManager passes CWD to SDKAgent's addObservation method
4. SDK agent includes CWD in tool observation objects sent to Claude API
5. Prompts conditionally render tool_cwd XML with spatial awareness guidance

**Implementation**:
- Optional CWD fields throughout for backward compatibility
- Defaults to empty string when CWD is missing
- CWD treated as read-only display context, not for file operations
- Complete propagation chain from hook → worker → SDK → prompts

**Test Coverage**:
- 8 comprehensive tests validating CWD propagation
- Tests cover hook extraction, worker forwarding, SDK inclusion, and prompt rendering
- All tests pass with tsx TypeScript loader

**Security**:
- Zero vulnerabilities introduced
- CodeQL analysis: No alerts
- Read-only context display (no file operation changes)
- Input validation and sanitization maintained

### Files Changed

**Source Files**:
- `src/hooks/save-hook.ts` - Extract CWD from PostToolUseInput
- `src/services/worker-types.ts` - Add optional CWD fields to interfaces
- `src/services/worker-service.ts` - Forward CWD in message handling
- `src/services/worker/SessionManager.ts` - Pass CWD to SDK agent
- `src/services/worker/SDKAgent.ts` - Include CWD in tool observations
- `src/sdk/prompts.ts` - Render tool_cwd XML with spatial guidance

**Built Artifacts**:
- `plugin/scripts/save-hook.js` - Compiled hook with CWD extraction
- `plugin/scripts/worker-service.cjs` - Compiled worker with CWD handling

**Tests & Documentation**:
- `tests/cwd-propagation.test.ts` - Comprehensive test suite (8 tests)
- `context/CWD_CONTEXT_FIX.md` - Technical implementation documentation
- `PR_SUMMARY.md` - Pull request summary and rationale
- `SECURITY_SUMMARY.md` - Security analysis and review
- `CHANGELOG.md` - Version history entry

### Installation

```bash
# Update to latest version
/plugin update claude-mem
```

Or restart Claude Code to auto-update.

### Upgrade Notes

- **Backward Compatible**: No breaking changes
- **No Action Required**: CWD propagation works automatically
- **Existing Sessions**: Will benefit from improved spatial awareness

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v5.4.1...v5.4.2

## [5.4.1] - 2025-11-10

**Breaking Changes**: None (patch version)

**New Features**:
- Added REST API endpoints for MCP server status and toggle control
- Implemented UI toggle in viewer sidebar for enabling/disabling MCP search server
- File-based persistence mechanism (.mcp.json ↔ .mcp.json.disabled)
- Independent state management for MCP toggle

**Technical Details**:
- New endpoints:
  - GET /api/mcp/status (returns mcpEnabled boolean)
  - POST /api/mcp/toggle (toggles MCP server state)
- Modified files:
  - src/services/worker-service.ts (added MCP control logic)
  - src/ui/viewer/components/Sidebar.tsx (added MCP toggle UI)
  - plugin/.mcp.json (MCP server configuration)
- Design rationale: Provides runtime control of the MCP search server to allow users to disable it when not needed, reducing resource usage. The file-based toggle mechanism ensures persistence across worker restarts.

**Known Issues**: None

**Upgrade Notes**: No breaking changes. Upgrade by running standard update process.

## [5.4.0] - 2025-11-10

### ⚠️ BREAKING CHANGE: MCP Search Tools Removed

**Migration**: None required. Claude automatically uses the search skill when needed.

### 🔍 Major Feature: Skill-Based Search Architecture

**Token Savings**: ~2,250 tokens per session start (90% reduction)

**What Changed:**
- **Before**: 9 MCP tools (~2,500 tokens in tool definitions per session start)
- **After**: 1 search skill (~250 tokens in frontmatter, full instructions loaded on-demand)
- **User Experience**: Identical - just ask naturally about past work

### ✨ Improvements

**Progressive Disclosure Pattern:**
- Skill frontmatter (~250 tokens) loads at session start
- Full instructions (~2,500 tokens) load only when skill is invoked
- HTTP API endpoints replace MCP protocol
- No user action required - migration is transparent

**Natural Language Queries:**
```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
```

### 🆕 Added

**10 New HTTP Search API Endpoints** in worker service:
- `GET /api/search/observations` - Full-text search observations
- `GET /api/search/sessions` - Full-text search session summaries
- `GET /api/search/prompts` - Full-text search user prompts
- `GET /api/search/by-concept` - Find observations by concept tag
- `GET /api/search/by-file` - Find work related to specific files
- `GET /api/search/by-type` - Find observations by type (bugfix, feature, etc.)
- `GET /api/context/recent` - Get recent session context
- `GET /api/context/timeline` - Get timeline around specific point in time
- `GET /api/timeline/by-query` - Search + timeline in one call
- `GET /api/search/help` - API documentation

**Search Skill** (`plugin/skills/search/SKILL.md`):
- Auto-invoked when users ask about past work, decisions, or history
- Comprehensive documentation with usage examples and workflows
- Format guidelines for presenting search results
- 12 operation files with detailed instructions

### 🗑️ Removed

**MCP Search Server** (deprecated):
- Removed `claude-mem-search` from plugin/.mcp.json
- Build script no longer compiles search-server.mjs
- Source file kept for reference: src/servers/search-server.ts
- All 9 MCP tools replaced by equivalent HTTP API endpoints

### 📚 Documentation

**Comprehensive Updates:**
- `README.md`: Updated version badge, What's New, and search section
- `docs/usage/search-tools.mdx`: Complete rewrite for skill-based approach
- `docs/architecture/mcp-search.mdx` → `search-architecture.mdx`: New architecture doc
- `docs/architecture/overview.mdx`: Updated components and search pipeline
- `docs/usage/getting-started.mdx`: Added skill-based search section
- `docs/configuration.mdx`: Updated search configuration
- `docs/introduction.mdx`: Updated key features

### 🔧 Technical Details

**How It Works:**
1. User asks: "What did we do last session?"
2. Claude recognizes intent → invokes search skill
3. Skill loads full instructions from `SKILL.md`
4. Skill uses `curl` to call HTTP API endpoint
5. Results formatted and returned to Claude
6. Claude presents results to user

**Benefits:**
- **Token Efficient**: Only loads what you need, when you need it
- **Natural**: No syntax to learn, just ask questions
- **Progressive**: Start with overview, drill down as needed
- **Flexible**: HTTP API can be called from skills, MCP tools, or other clients

### 🐛 Migration Notes

**For Users:**
- ✅ No action required - migration is transparent
- ✅ Same questions work - natural language queries identical
- ✅ Invisible change - only notice better performance

**For Developers:**
- ⚠️ MCP search server deprecated (source kept for reference)
- ✅ New implementation: Skill files + HTTP endpoints
- ✅ Build/sync workflow unchanged

### 📦 Installation

```bash
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code to start using v5.4.0.

### 🔗 Resources

- **Documentation**: https://github.com/thedotmack/claude-mem/tree/main/docs
- **Issues**: https://github.com/thedotmack/claude-mem/issues
- **CHANGELOG**: https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v5.3.0...v5.4.0

## [5.3.0] - 2025-11-09

**Breaking Changes**: None (minor version)

**Session Lifecycle Improvements**:
- **Prompt Counter Restoration**: SessionManager now loads prompt counter from database on worker restart, preventing state loss
- **Continuation Prompts**: Lightweight prompts for request #2+ avoid re-initializing SDK agent's mental model
- **Summary Framing**: Changed from "final report" to "progress checkpoint" to clarify mid-session summaries

**Bug Fixes**:
- **#76**: Fixed PM2 "Process 0 not found" error by using idempotent `pm2 start` instead of `pm2 restart`
- **#74, #75**: Fixed troubleshooting skill distribution by moving to `plugin/skills/` directory
- **#73 (Partial)**: Improved context-loading task reporting in summaries

**Technical Details**:
- Modified files:
  - `src/services/worker/SessionManager.ts` (loads prompt_counter from DB)
  - `src/services/worker/SDKAgent.ts` (uses continuation prompts)
  - `src/sdk/prompts.ts` (added buildContinuationPrompt function)
  - `src/shared/worker-utils.ts` (pm2 start instead of restart)
  - `src/hooks/context-hook.ts` (improved context loading)
  - Moved `.claude/skills/troubleshoot` → `plugin/skills/troubleshoot`

**Why These Changes Matter**:
- Worker restarts no longer lose session state
- Subsequent prompts are more efficient (no re-initialization overhead)
- Summaries better reflect ongoing work vs completed sessions
- PM2 errors eliminated for new users
- Troubleshooting skill now properly distributed to plugin users

**Upgrade Notes**: No breaking changes. Worker will automatically pick up improvements on restart.

## [5.2.3] - 2025-11-09

**Breaking Changes**: None (patch version)

**Improvements**:
- Added troubleshooting slash command skill for diagnosing claude-mem installation issues
- Comprehensive diagnostic workflow covering PM2, worker health, database, dependencies, logs, and viewer UI
- Automated fix sequences and common issue resolutions
- Full system diagnostic report generation

**Technical Details**:
- New file: `.claude/skills/troubleshoot/SKILL.md` (363 lines)
- Added troubleshooting skill documentation to `README.md` and `docs/troubleshooting.mdx`
- Version bumped to 5.2.3 across all metadata files

**Usage**:
Run `/skill troubleshoot` or invoke the `troubleshoot` skill to diagnose claude-mem issues.

The skill provides systematic checks for:
- PM2 worker status
- Worker service health
- Database state and integrity
- Dependencies installation
- Worker logs
- Viewer UI endpoints
- Full system diagnostic report

## [5.2.2] - 2025-11-08

**Breaking Changes**: None (patch version)

**Improvements**:
- Context hook now displays 'investigated' and 'learned' fields from session summaries
- Enhanced startup context visibility with color-coded formatting (blue for investigated, yellow for learned)
- Improved session summary detail display at startup

**Technical Details**:
- Modified files:
  - src/hooks/context-hook.ts (enhanced SQL query and display logic)
  - plugin/scripts/context-hook.js (built hook with new functionality)
- Updated SQL query to SELECT investigated and learned columns
- Added TypeScript type definitions for nullable investigated and learned fields
- Added conditional display blocks with appropriate color formatting

**Impact**: Users will now see more comprehensive session summary information at startup, providing better context about what was investigated and learned in previous sessions.

## [5.2.1] - 2025-11-08

**Breaking Changes**: None (patch version)

### Bug Fixes

This patch release fixes critical race conditions and state synchronization issues in the viewer UI's project filtering system.

**Fixed Issues:**
- **Race condition with offset reset**: When filter changed, offset wasn't reset synchronously, causing incorrect pagination ranges (e.g., loading items 20-40 for new project with < 20 items)
- **State ref synchronization**: `stateRef.current.hasMore` retained old value when filter changed, preventing new filter from loading if previous filter had no more data
- **Data mixing between projects**: Batched state updates caused data from different projects to appear together in the UI
- **useEffect dependency cycle**: `handleLoadMore` in dependencies caused double renders when filter changed
- **NULL projects in dropdown**: Empty/NULL project values appeared in the project filter dropdown

**Technical Improvements:**
- Combined two separate useEffect hooks into one for guaranteed execution order (reset → load)
- Removed redundant filter change detection logic (DRY principle)
- Simplified validation in `mergeAndDeduplicateByProject` function
- Added `investigated` field to Summary interface for better session tracking

**Files Changed:**
- `src/ui/viewer/App.tsx` - Fixed filter change detection and data reset logic
- `src/ui/viewer/hooks/usePagination.ts` - Improved offset and state ref handling
- `src/ui/viewer/utils/data.ts` - Simplified validation logic
- `src/services/sqlite/SessionStore.ts` - Filter NULL/empty projects from dropdown
- `src/ui/viewer/types.ts` - Added investigated field to Summary interface
- `src/ui/viewer/components/SummaryCard.tsx` - Display investigated field

All changes follow CLAUDE.md coding standards: DRY, YAGNI, and fail-fast error handling.

### Testing

Verified fixes work correctly:
1. ✅ Select project from dropdown → Data loads immediately
2. ✅ Switch between multiple projects → Only selected project's data shown (no mixing)
3. ✅ Rapid switching between projects → No race conditions or stale data
4. ✅ Switch back to "All Projects" → All data appears correctly with SSE updates

## [5.2.0] - 2025-11-07

This release delivers a comprehensive architectural refactor of the worker service, extensive UI enhancements, and significant code cleanup. Merges PR #69.

**Breaking Changes**: None (backward compatible)

---

## 🏗️ Architecture Changes (Worker Service v2)

### Modular Rewrite

Extracted monolithic `worker-service.ts` into focused, single-responsibility modules:

- **DatabaseManager.ts** (111 lines): Centralized database initialization and access
- **SessionManager.ts** (204 lines): Complete session lifecycle management
- **SDKAgent.ts** (309 lines): Claude SDK interactions & observation compression
- **SSEBroadcaster.ts** (86 lines): Server-Sent Events broadcast management
- **PaginationHelper.ts** (196 lines): Reusable pagination logic for all data types
- **SettingsManager.ts** (68 lines): Viewer settings persistence
- **worker-types.ts** (176 lines): Shared TypeScript types

### Key Improvements

- ✅ Eliminated duplicated session logic (4 instances → 1 helper)
- ✅ Replaced magic numbers with named constants (HEALTH_CHECK_TIMEOUT_MS, etc.)
- ✅ Removed fragile PM2 string parsing → Direct PM2 restart
- ✅ Fail-fast error handling instead of silent failures
- ✅ Fixed SDK agent bug: Changed from `obs.title` to `obs.narrative`

---

## 🎨 UI/UX Improvements

### New Features

**ScrollToTop Component** (`src/ui/viewer/components/ScrollToTop.tsx`)
- GPU-accelerated smooth scrolling
- Appears after scrolling 400px
- Accessible with ARIA labels

### Enhancements

**ObservationCard Refactoring**
- Fixed facts toggle logic
- Improved metadata display (timestamps, tokens, model)
- Enhanced narrative display with proper typography
- Better empty states

**Pagination Improvements**
- Better loading state management
- Improved error recovery on failed fetches
- Automatic deduplication
- Scroll preservation

**Card Consistency**
- Unified layout patterns across Observation/Prompt/Summary cards
- Consistent spacing and alignment

---

## 📚 Documentation

**New Files** (7,542 lines total):

- `context/agent-sdk-ref.md` (1,797 lines): Complete Agent SDK reference
- `docs/worker-service-architecture.md` (1,174 lines): v2 architecture documentation
- `docs/worker-service-rewrite-outline.md` (1,069 lines): Refactor planning document
- `docs/worker-service-overhead.md` (959 lines): Performance analysis
- `docs/processing-indicator-audit.md` + `processing-indicator-code-reference.md` (980 lines): Processing status documentation
- `docs/typescript-errors.md` (180 lines): TypeScript error reference
- `PLAN-full-observation-display.md` (468 lines): Future UI enhancement roadmap
- `src-analysis.md` + `src-tree.md` (418 lines): Source code organization

---

## 🧹 Code Cleanup

### Deleted Dead Code (~2,000 lines)

**Shared Modules**:
- `src/shared/config.ts` (48 lines)
- `src/shared/storage.ts` (188 lines)
- `src/shared/types.ts` (29 lines)

**Utils**:
- `src/utils/platform.ts` (64 lines)
- `src/utils/usage-logger.ts` (61 lines)

**Index Files**:
- `src/hooks/index.ts`
- `src/sdk/index.ts`

**Documentation**:
- `docs/VIEWER.md` (405 lines)
- `docs/worker-server-architecture.md` (1,129 lines)

---

## 🐛 Bug Fixes

1. **SDK Agent Narrative Assignment** (commit e22edad)
   - Fixed: Changed from `obs.title` to `obs.narrative` 
   - Impact: Observations now correctly preserve narrative content

2. **PostToolUse Hook Field Name** (commit 13643a5)
   - Fixed: Corrected field reference in hook output
   - Impact: Tool usage properly captured

3. **Smart Install Flow** (commit 6204fe9)
   - Removed: Unnecessary `startWorker()` function
   - Simplified: Installation flow now relies on context-hook to start worker
   - Rationale: PM2 start is idempotent, no pre-flight checks needed

4. **Context Hook Worker Management** (commit 6204fe9)
   - Removed: Redundant worker status checks
   - Simplified: Direct health check + restart if unhealthy
   - Performance: Faster session startup

---

## 📊 Statistics

**Files Changed**: 70 total
- 11 new files
- 7 deleted files
- 52 modified files

**Net Impact**: +7,470 lines
- 11,105 additions
- 3,635 deletions

---

## ✅ Testing

All systems verified:
- ✓ Worker service starts successfully
- ✓ All hooks function correctly (context, save, cleanup, summary)
- ✓ Viewer UI renders properly with all improvements
- ✓ Build pipeline compiles without errors
- ✓ SSE broadcasts work for real-time updates
- ✓ Pagination loads correctly

---

## 🔄 Migration Guide

**No action required** - this release is fully backward compatible.

All changes are internal refactoring. Public APIs remain unchanged:
- Hook interfaces unchanged
- MCP search tools unchanged
- Database schema unchanged
- Environment variables unchanged

To activate:
1. Pull latest: `git pull`
2. Rebuild: `npm run build`
3. Sync to marketplace: `npm run sync-marketplace`
4. Restart worker: `npm run worker:restart`
5. Start new Claude Code session

---

## 📖 Related

- **PR**: #69
- **Previous Version**: 5.1.4
- **Semantic Version**: MINOR (backward compatible features & improvements)

## [5.1.4] - 2025-11-07

**Bugfix Release**: PostToolUse Hook Schema Compliance

**Changes**:
- Fixed parameter naming in save-hook to match Claude Code PostToolUse API schema
- Renamed `tool_output` to `tool_response` throughout the codebase
- Updated worker-service to handle `tool_response` field correctly

**Technical Details**:
- Modified files:
  - `src/hooks/save-hook.ts`: Updated interface and parameter destructuring
  - `src/services/worker-service.ts`: Updated observation message handling
  - `plugin/scripts/save-hook.js`: Rebuilt with corrected names
  - `plugin/scripts/worker-service.cjs`: Rebuilt with corrected names

**Why This Matters**: The Claude Code PostToolUse hook API provides `tool_response` not `tool_output`. This fix ensures proper schema compliance and prevents potential errors when capturing tool executions.

## [5.1.2] - 2025-11-06

**Breaking Changes**: None (patch version)

**Features**:
- Theme toggle functionality with light, dark, and system preferences
- User-selectable theme with persistent settings across sessions
- Automatic system preference detection and matching

**Technical Details**:
- Enhanced viewer UI with theme toggle controls
- Theme preference stored in localStorage
- Seamless integration with existing viewer interface
- Version bumped from 5.1.1 → 5.1.2

**Usage**:
Access the viewer at http://localhost:37777 and use the theme toggle to switch between light mode, dark mode, or system preference.

## [5.1.1] - 2025-11-06

**Breaking Changes**: None (patch version)

**Bugfix**:
- Fixed PM2 ENOENT error on Windows by using full path to PM2 binary
- Improved cross-platform compatibility for PM2 process management

**Technical Details**:
- Modified files:
  - scripts/smart-install.js (improved PM2 binary path resolution)
  - package-lock.json (dependency updates)
- The fix ensures PM2 commands work correctly on Windows systems by using the full path to the PM2 binary instead of relying on PATH resolution
- This resolves the "ENOENT: no such file or directory" error that Windows users encountered when the plugin tried to start the worker service

**Installation**:
Users on Windows will now have a smoother installation experience with automatic PM2 worker startup working correctly.

## [5.1.0] - 2025-11-06

### 🎉 Major Feature: Web-Based Viewer UI

This release introduces a production-ready web interface for visualizing your memory stream in real-time!

**Access the viewer**: http://localhost:37777 (auto-starts with the worker)

### ✨ Key Features

**Real-Time Visualization**
- Server-Sent Events (SSE) for instant updates as observations are captured
- See user prompts, observations, and session summaries as they happen
- No polling - efficient push-based updates

**Infinite Scroll & Pagination**
- Load more content seamlessly as you scroll
- Automatic deduplication prevents duplicates
- Smooth loading states with skeleton components

**Project Filtering**
- Filter memory stream by project/codebase
- Quick project switcher in sidebar
- View stats for all projects or focus on one

**Persistent Settings**
- Sidebar state (open/closed) saved to localStorage
- Selected project filter persists across sessions
- Smooth GPU-accelerated animations

**Auto-Reconnection**
- Exponential backoff retry logic
- Graceful handling of worker restarts
- Connection status indicator

### 🔧 Technical Improvements

**New Worker Endpoints** (+500 lines)
- `/api/prompts` - Paginated user prompts with project filtering
- `/api/observations` - Paginated observations with project filtering
- `/api/summaries` - Paginated session summaries with project filtering
- `/api/stats` - Database statistics (total counts by project)
- `/api/projects` - List of unique project names
- `/stream` - Server-Sent Events for real-time updates
- `/` - Serves viewer HTML
- `/health` - Health check endpoint

**Database Enhancements** (+98 lines in SessionStore)
- `getRecentPrompts()` - Paginated prompts with OFFSET/LIMIT
- `getRecentObservations()` - Paginated observations with OFFSET/LIMIT
- `getRecentSummaries()` - Paginated summaries with OFFSET/LIMIT
- `getStats()` - Aggregated statistics by project
- `getUniqueProjects()` - Distinct project names

**Complete React UI** (17 new files, 1,500+ lines)
- Components: Header, Sidebar, Feed, Cards (Observation, Prompt, Summary, Skeleton)
- Hooks: useSSE, usePagination, useSettings, useStats
- Utils: Data merging, formatters, constants
- Assets: Monaspace Radon font, logos (dark mode + logomark)
- Build: esbuild pipeline for self-contained HTML bundle

### 📚 Documentation

Updated CLAUDE.md with:
- Viewer UI architecture and components
- Build process for viewer changes
- Configuration and usage instructions
- Design rationale for SSE and self-contained bundle approach

### 🎨 Design Highlights

- **Monaspace Radon** variable font for beautiful monospace rendering
- **Claude branding** with official logos and dark mode support
- **Responsive layout** with collapsible sidebar
- **Smooth animations** using GPU acceleration (transform/opacity)
- **Error boundaries** for graceful failure handling

### 🚀 Getting Started

1. Update claude-mem to v5.1.0
2. Start a Claude Code session (worker auto-starts)
3. Open http://localhost:37777 in your browser
4. Watch your memory stream in real-time!

### 📦 Files Changed

**New Files:**
- `src/ui/viewer/` - Complete React application (17 files)
- `src/ui/viewer-template.html` - HTML template for bundle
- `scripts/build-viewer.js` - esbuild configuration
- `plugin/ui/viewer.html` - Built self-contained bundle
- `plugin/ui/viewer-bundle.js` - Compiled React code
- `plugin/ui/assets/fonts/` - Monaspace Radon font files
- `src/ui/*.webp` - Claude logos and branding

**Modified Files:**
- `src/services/worker-service.ts` - Added 8 new HTTP/SSE endpoints
- `src/services/sqlite/SessionStore.ts` - Added pagination methods
- `scripts/build-hooks.js` - Integrated viewer build process
- `CLAUDE.md` - Comprehensive documentation update

### 🙏 Acknowledgments

Built with:
- React 19 + TypeScript
- esbuild for ultra-fast bundling
- Monaspace Radon font by GitHub Next
- Server-Sent Events for real-time updates

---

**Breaking Changes**: None (backward compatible MINOR version)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v5.0.3...v5.1.0

## [5.0.3] - 2025-11-05

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed Windows installation with smart caching installer (PR #54: scripts/smart-install.js)
- Eliminated redundant npm install executions on every SessionStart (improved from 2-5s to ~10ms)
- Added comprehensive Windows troubleshooting with VS Build Tools guidance
- Fixed dynamic Python version detection in Windows error messages (scripts/smart-install.js:106-115)

**Improvements**:
- Smart install now caches version state in `.install-version` file
- Only runs npm install when needed: first time, version change, or missing dependencies
- Enhanced rsync to respect gitignore rules in sync-marketplace (package.json:38)
- Better PM2 worker startup verification and management
- Cross-platform compatible installer (pure Node.js, no shell dependencies)

**Technical Details**:
- New: scripts/smart-install.js (smart caching installer with PM2 worker management)
- Modified: plugin/hooks/hooks.json:25 (use smart-install.js instead of raw npm install)
- Modified: .gitignore (added .install-version cache file)
- Modified: CLAUDE.md (added Windows requirements and troubleshooting section)
- Modified: package.json:38 (enhanced sync-marketplace with --filter=':- .gitignore' --exclude=.git)
- Root cause: npm install was running on every SessionStart regardless of whether dependencies changed
- Impact: 200x faster SessionStart for cached installations (10ms vs 2-5s)

**For Windows Users**:
This release should completely resolve installation issues. The smart installer will:
1. Show you clear error messages if better-sqlite3 fails to install
2. Guide you to install VS Build Tools if needed (though you probably won't need them)
3. Only run once on first launch, then be instant on subsequent launches

## [5.0.2] - 2025-11-05

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed worker startup reliability with async health checks (PR #51: src/shared/worker-utils.ts)
- Added proper error handling to PM2 process spawning (src/shared/worker-utils.ts)
- Worker now verifies health before proceeding with hook operations
- Improved handling of PM2 failures when not yet installed

**Technical Details**:
- Modified: src/shared/worker-utils.ts (added isWorkerHealthy, waitForWorkerHealth functions)
- Modified: src/hooks/*.ts (all hooks now await ensureWorkerRunning)
- Modified: plugin/scripts/*.js (rebuilt hook executables)
- Root cause: ensureWorkerRunning was synchronous and didn't verify worker was actually responsive before proceeding
- Impact: More reliable worker startup with proper health verification

## Installation

Install via Claude Code marketplace:
```bash
/plugin marketplace add https://raw.githubusercontent.com/thedotmack/claude-mem/main/.claude-plugin/marketplace.json
/plugin install claude-mem
```

## Full Changelog
[View all changes](https://github.com/thedotmack/claude-mem/compare/v5.0.1...v5.0.2)

## [5.0.1] - 2025-11-04

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed worker service stability issues (PR #47: src/services/worker-service.ts, src/shared/worker-utils.ts)
- Improved worker process management and restart reliability (src/hooks/*-hook.ts)
- Enhanced session management and logging across all hooks
- Removed error/output file redirection from PM2 ecosystem config for better debugging (ecosystem.config.cjs)

**Improvements**:
- Added GitHub Actions workflows for automated code review (PR #48)
  - Claude Code Review workflow (.github/workflows/claude-code-review.yml)
  - Claude PR Assistant workflow (.github/workflows/claude.yml)
- Better worker health checks and startup sequence
- Improved error handling and logging throughout hook lifecycle
- Cleaned up documentation files and consolidated project context

**Technical Details**:
- Modified: src/services/worker-service.ts (stability improvements)
- Modified: src/shared/worker-utils.ts (consistent formatting and readability)
- Modified: ecosystem.config.cjs (removed error/output redirection)
- Modified: src/hooks/*-hook.ts (ensure worker running before processing)
- New: .github/workflows/claude-code-review.yml
- New: .github/workflows/claude.yml
- Rebuilt: plugin/scripts/*.js (all hook executables)
- Impact: More reliable worker service with better error visibility and automated PR assistance

---

**Installation**: See [README](https://github.com/thedotmack/claude-mem#readme) for installation instructions.

## [5.0.0] - 2025-11-04

### BREAKING CHANGES
- **Python dependency for optimal performance**: While the plugin works without Python, installing Python 3.8+ and the Chroma MCP server unlocks semantic search capabilities. Without Python, the system falls back to SQLite FTS5 keyword search.
- **Search behavior changes**: Search queries now prioritize semantic relevance when Chroma is available, then apply temporal ordering. Keyword-only queries may return different results than v4.x.
- **Worker service changes**: Worker now initializes ChromaSync on startup. If Chroma MCP is unavailable, worker continues with FTS5-only mode but logs a warning.

### Added
- **Hybrid Search Architecture**: Combines ChromaDB semantic search with SQLite temporal/metadata filtering
  - Chroma vector database for semantic similarity (top 100 matches)
  - 90-day temporal recency window for relevant results
  - SQLite hydration in chronological order
  - Graceful fallback to FTS5 when Chroma unavailable
- **ChromaSync Service**: Automatic vector database synchronization
  - Syncs observations, session summaries, and user prompts to Chroma
  - Splits large text fields into multiple vectors for better granularity
  - Maintains metadata for filtering (project, type, concepts, files)
  - Background sync process via worker service
- **get_timeline_by_query Tool**: Natural language timeline search with dual modes
  - Auto mode: Automatically uses top search result as timeline anchor
  - Interactive mode: Shows top N results for manual anchor selection
  - Combines semantic search discovery with timeline context retrieval
- **User Prompt Semantic Search**: Raw user prompts now indexed in Chroma for semantic discovery
- **Enhanced MCP Tools**: All 8 existing search tools now support hybrid search
  - search_observations - Now uses semantic + temporal hybrid algorithm
  - search_sessions - Semantic search across session summaries
  - search_user_prompts - Semantic search across raw prompts
  - find_by_concept, find_by_file, find_by_type - Enhanced with semantic capabilities
  - get_recent_context - Unchanged (temporal only)
  - get_context_timeline - Unchanged (anchor-based temporal)

### Changed
- **Search Server**: Expanded from ~500 to ~1,500 lines with hybrid search implementation
- **Worker Service**: Now initializes ChromaSync and handles Chroma MCP lifecycle
- **Search Pipeline**: Now follows semantic-first strategy with temporal ordering
  ```
  Query → Chroma Semantic Search (top 100) → 90-day Filter → SQLite Hydration (temporal order) → Results
  ```
- **Worker Resilience**: Worker no longer crashes when Chroma MCP unavailable; gracefully falls back to FTS5

### Fixed
- **Critical temporal filtering bug**: Fixed deduplication and date range filtering in search results
- **User prompt formatting bug**: Corrected field reference in search result formatting
- **Worker crash prevention**: Worker now handles missing Chroma MCP gracefully instead of crashing

### Technical Details
- New files:
  - src/services/sync/ChromaSync.ts (738 lines) - Vector database sync service
  - experiment/chroma-search-test.ts - Comprehensive hybrid search testing
  - experiment/chroma-sync-experiment.ts - Vector sync validation
  - docs/chroma-search-completion-plan.md - Implementation planning
  - FEATURE_PLAN_HYBRID_SEARCH.md - Feature specification
  - IMPLEMENTATION_STATUS.md - Testing and validation results
- Modified files:
  - src/servers/search-server.ts (+995 lines) - Hybrid search algorithm implementation
  - src/services/worker-service.ts (+136 lines) - ChromaSync integration
  - src/services/sqlite/SessionStore.ts (+276 lines) - Enhanced timeline queries
  - src/hooks/context-hook.ts - Type legend improvements
- Validation: 1,390 observations synced to 8,279 vector documents
- Performance: Semantic search with 90-day window returns results in <200ms

## [4.3.4] - 2025-11-02

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed SessionStart hooks running on session resume (plugin/hooks/hooks.json:4)
- Added matcher configuration to only run SessionStart hooks on startup, clear, or compact events
- Prevents unnecessary hook execution and improves performance on session resume

**Technical Details**:
- Modified: plugin/hooks/hooks.json:4 (added `"matcher": "startup|clear|compact"`)
- Impact: Hooks now skip execution when resuming existing sessions

## [4.3.3] - 2025-10-27

**Breaking Changes**: None (patch version)

**Improvements**:
- Made session display count configurable via constant (DISPLAY_SESSION_COUNT = 8) in src/hooks/context-hook.ts:11
- Added first-time setup detection with helpful user messaging in src/hooks/user-message-hook.ts:12-39
- Improved user experience: First install message clarifies why it appears under "Plugin Hook Error"

**Fixes**:
- Cleaned up profanity in code comments (src/hooks/context-hook.ts:3)
- Fixed first-time setup UX by detecting missing node_modules and showing informative message

**Technical Details**:
- Modified: src/hooks/context-hook.ts:11 (configurable DISPLAY_SESSION_COUNT constant)
- Modified: src/hooks/user-message-hook.ts:12-39 (first-time setup detection and messaging)
- Modified: plugin/scripts/context-hook.js (rebuilt)
- Modified: plugin/scripts/user-message-hook.js (rebuilt)

## [4.3.2] - 2025-10-27

**Breaking Changes**: None (patch version)

**Improvements**:
- Added user-message-hook for displaying context to users via stderr mechanism
- Enhanced context visibility: Hook fires simultaneously with context injection, sending duplicate message as "error" so Claude Code displays it to users
- Added comprehensive documentation (4 new MDX files covering architecture evolution, context engineering, hooks architecture, and progressive disclosure)
- Improved cross-platform path handling in context-hook

**Technical Details**:
- New files:
  - src/hooks/user-message-hook.ts (stderr-based user-facing context display)
  - plugin/scripts/user-message-hook.js (built hook executable)
  - docs/architecture-evolution.mdx (801 lines)
  - docs/context-engineering.mdx (222 lines)
  - docs/hooks-architecture.mdx (784 lines)
  - docs/progressive-disclosure.mdx (655 lines)
- Modified:
  - plugin/hooks/hooks.json (added user-message-hook configuration)
  - src/hooks/context-hook.ts (improved path handling)
  - scripts/build-hooks.js (build support for new hook)
- Design rationale: Error messages don't get added to context, so we intentionally duplicate context output via stderr for user visibility. This is a temporary workaround until Claude Code potentially adds ability to share messages with both user and context simultaneously.

## [4.3.1] - 2025-10-26

## Fixes

- **Fixed SessionStart hook context injection** by silencing npm install output (`plugin/hooks/hooks.json:25`)
- Changed npm loglevel from `--loglevel=error` to `--loglevel=silent` to ensure clean JSON output
- **Consolidated hooks architecture** by removing bin/hooks wrapper layer (`src/hooks/*-hook.ts`)
- Fixed double shebang issues in hook executables (esbuild now adds shebang during build)

## Technical Details

- **Modified**: `plugin/hooks/hooks.json` (npm install verbosity)
- **Removed**: `src/bin/hooks/*` (wrapper layer no longer needed)
- **Consolidated**: Hook logic moved directly into `src/hooks/*-hook.ts` files
- **Root cause**: npm install stderr/stdout was polluting hook JSON output, preventing context injection

## Breaking Changes

None (patch version)

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v4.3.0...v4.3.1

## [4.3.0] - 2025-10-25

## What's Changed
* feat: Enhanced context hook with session observations and cross-platform improvements by @thedotmack in https://github.com/thedotmack/claude-mem/pull/25

## New Contributors
* @thedotmack made their first contribution in https://github.com/thedotmack/claude-mem/pull/25

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v4.2.11...v4.3.0

## [4.2.10] - 2025-10-25

## Fixed
- **Windows compatibility**: Removed hardcoded macOS-specific Claude executable path that prevented worker service from running on Windows

## Changes
- Removed hardcoded path: `/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude`
- Removed `pathToClaudeCodeExecutable` parameter from SDK query() calls  
- SDK now automatically detects Claude Code executable path on all platforms
- Improved cross-platform compatibility (Windows, macOS, Linux)

## Technical Details
- Updated `src/sdk/worker.ts` to remove hardcoded Claude path and `pathToClaudeCodeExecutable` parameter
- Updated `src/services/worker-service.ts` to remove hardcoded Claude path and parameter
- Built `plugin/scripts/worker-service.cjs` reflects changes
- Affects all SDK agent initialization in worker service

## Impact
- **Before**: Worker service failed on Windows due to hardcoded macOS path
- **After**: Worker service works correctly on all platforms

## Files Changed
- `src/sdk/worker.ts`
- `src/services/worker-service.ts`
- `plugin/scripts/worker-service.cjs` (rebuilt)

## [4.2.3] - 2025-10-24

## [4.2.1] - 2025-10-23

## [3.9.16] - 2025-10-07

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.16
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.14] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.14
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.13] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.13
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.12] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.12
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.11] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.11
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.10] - 2025-10-03

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.10
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.9] - 2025-10-03

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.9
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.7.2] - 2025-09-22

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.7.2
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.7.1] - 2025-09-18

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.7.1
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.7.0] - 2025-09-18

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.7.0
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.10] - 2025-09-17

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.10
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.9] - 2025-09-15

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.9
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.8] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.8
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.6] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.6
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.5] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.5
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.4] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.4
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.3] - 2025-09-11

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.3
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.2] - 2025-09-11

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.2
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.1] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.1
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.0] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.0
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.9] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.9
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.8] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.8
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.7] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.7
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.6] - 2025-09-09

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.6
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.5] - 2025-09-09

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.5
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.4] - 2025-09-09

## 🎉 claude-mem v3.5.4

### Installation
```bash
npm install -g claude-mem
claude-mem install
```

### What's New
- Enhanced memory compression and loading
- Improved hook system reliability  
- Better error handling and logging
- Updated dependencies
- Bug fixes and performance improvements

### Key Features
- 🧠 **Intelligent Memory Compression** - Automatically extracts key learnings from Claude Code conversations
- 🔄 **Seamless Integration** - Works invisibly in the background with /compact and /clear commands
- 🎯 **Smart Context Loading** - Loads relevant memories when starting new sessions
- 📚 **Comprehensive Knowledge Base** - Stores solutions, patterns, and decisions
- 🔍 **Powerful Search** - Vector-based semantic search across all memories

### Files Included
- `dist/claude-mem.min.js` - Minified CLI executable
- `hooks/` - Claude Code integration hooks
- `commands/` - Claude Code custom commands
- `package.json` - Package configuration

### Requirements
- Node.js 18+
- Claude Code CLI
- uv (automatically installed if missing)

For documentation and support, visit the [GitHub repository](https://github.com/thedotmack/claude-mem).
