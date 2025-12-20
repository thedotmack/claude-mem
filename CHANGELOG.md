# Changelog

All notable changes to this project will be documented in this file.

## [v7.4.2] - 2025-12-20

Patch release v7.4.2

## Changes
- Refactored worker commands from npm scripts to claude-mem CLI
- Added path alias script
- Fixed Windows worker stop/restart reliability (#395)
- Simplified build commands section in CLAUDE.md

## [v7.4.1] - 2025-12-19

## Bug Fixes

- **MCP Server**: Redirect logs to stderr to preserve JSON-RPC protocol (#396)
  - MCP uses stdio transport where stdout is reserved for JSON-RPC messages
  - Console.log was writing startup logs to stdout, causing Claude Desktop to parse log lines as JSON and fail

## [v7.4.0] - 2025-12-18

## What's New

### MCP Tool Token Reduction

Optimized MCP tool definitions for reduced token consumption in Claude Code sessions through progressive parameter disclosure.

**Changes:**
- Streamlined MCP tool schemas with minimal inline definitions
- Added `get_schema()` tool for on-demand parameter documentation
- Enhanced worker API with operation-based instruction loading

This release improves session efficiency by reducing the token overhead of MCP tool definitions while maintaining full functionality through progressive disclosure.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v7.3.9] - 2025-12-18

## Fixes

- Fix MCP server compatibility and web UI path resolution

This patch release addresses compatibility issues with the MCP server and resolves path resolution problems in the web UI.

## [v7.3.8] - 2025-12-18

## Security Fix

Added localhost-only protection for admin endpoints to prevent DoS attacks when worker service is bound to 0.0.0.0 for remote UI access.

### Changes
- Created `requireLocalhost` middleware to restrict admin endpoints
- Applied to `/api/admin/restart` and `/api/admin/shutdown`
- Returns 403 Forbidden for non-localhost requests

### Security Impact
Prevents unauthorized shutdown/restart of worker service when exposed on network.

Fixes security concern raised in #368.

## [v7.3.7] - 2025-12-17

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

## [v7.3.6] - 2025-12-17

## Bug Fixes

- Enhanced SDKAgent response handling and message processing

## [v7.3.5] - 2025-12-17

## What's Changed
* fix(windows): solve zombie port problem with wrapper architecture by @ToxMox in https://github.com/thedotmack/claude-mem/pull/372
* chore: bump version to 7.3.5 by @thedotmack in https://github.com/thedotmack/claude-mem/pull/375

## New Contributors
* @ToxMox made their first contribution in https://github.com/thedotmack/claude-mem/pull/372

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.4...v7.3.5

## [v7.3.4] - 2025-12-17

Patch release for bug fixes and minor improvements

## [v7.3.3] - 2025-12-16

## What's Changed

- Remove all better-sqlite3 references from codebase (#357)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.2...v7.3.3

## [v7.3.2] - 2025-12-16

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

## [v7.3.1] - 2025-12-16

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

## [v7.3.0] - 2025-12-16

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

## [v7.2.4] - 2025-12-15

## What's Changed

### Documentation
- Updated endless mode setup instructions with improved configuration guidance for better user experience

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.3...v7.2.4

## [v7.2.3] - 2025-12-15

## Bug Fixes

- **Fix MCP server failures on plugin updates**: Add 2-second pre-restart delay in `ensureWorkerVersionMatches()` to give files time to sync before killing the old worker. This prevents the race condition where the worker restart happened too quickly after plugin file updates, causing "Worker service connection failed" errors.

## Changes

- Add `PRE_RESTART_SETTLE_DELAY` constant (2000ms) to `hook-constants.ts`
- Add delay before `ProcessManager.restart()` call in `worker-utils.ts`
- Fix pre-existing bug where `port` variable was undefined in error logging

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v7.2.2] - 2025-12-15

## Changes

- **Refactor:** Consolidate mem-search skill, remove desktop-skill duplication
  - Delete separate `desktop-skill/` directory (was outdated)
  - Generate `mem-search.zip` during build from `plugin/skills/mem-search/`
  - Update docs with correct MCP tool list and new download path
  - Single source of truth for Claude Desktop skill

## [v7.2.1] - 2025-12-14

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

## [v7.2.0] - 2025-12-14

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

## [v7.1.15] - 2025-12-14

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

## [v7.1.14] - 2025-12-14

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v7.1.13] - 2025-12-14

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v7.1.12] - 2025-12-14

## What's Fixed

- **Fix data directory creation**: Ensure `~/.claude-mem/` directory exists before writing PM2 migration marker file
  - Fixes ENOENT errors on first-time installation (issue #259)
  - Adds `mkdirSync(dataDir, { recursive: true })` in `startWorker()` before marker file write
  - Resolves Windows installation failures introduced in f923c0c and exposed in 5d4e71d

## Changes

- Added directory creation check in `src/shared/worker-utils.ts`
- All 52 tests passing

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.11...v7.1.12

## [v7.1.11] - 2025-12-14

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

## [v7.1.10] - 2025-12-14

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

## [v7.1.9] - 2025-12-14

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

## [v7.1.8] - 2025-12-13

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

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

## [v7.1.7] - 2025-12-13

## Fixed
- Removed Windows workaround that was causing libuv assertion failures
- Prioritized stability over cosmetic console window issue

## Known Issue
- On Windows, a console window may briefly appear when the worker starts (cosmetic only, does not affect functionality)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.6...v7.1.7

## [v7.1.6] - 2025-12-13

## What's Changed

Improved error messages with platform-specific worker restart instructions for better troubleshooting experience.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.5...v7.1.6

## [v7.1.5] - 2025-12-13

## What's Changed

* fix: Use getWorkerHost() instead of hardcoded localhost in MCP server (#276)

### Bug Fix
Fixes Windows IPv6 issue where `localhost` resolves to `::1` (IPv6) but worker binds to `127.0.0.1` (IPv4), causing MCP tool connections to fail.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.4...v7.1.5

## [v7.1.4] - 2025-12-13

## What's Changed

* fix: add npm fallback when bun install fails with alias packages (#265)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.3...v7.1.4

## [v7.1.3] - 2025-12-13

## Bug Fixes

### Smart Install Script Refactoring

Refactored the smart-install.js script to improve code quality and maintainability:
- Extracted common installation paths as top-level constants (BUN_COMMON_PATHS, UV_COMMON_PATHS)
- Simplified installation check functions to delegate to dedicated path-finding helpers
- Streamlined installation verification logic with clearer error messages
- Removed redundant post-installation verification checks
- Improved error propagation by removing unnecessary retry logic

This refactoring reduces code duplication and makes the installation process more maintainable while preserving the same functionality for detecting Bun and uv binaries across platforms.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v7.1.2] - 2025-12-13

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

## [v7.1.1] - 2025-12-13

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

## [v7.1.0] - 2025-12-13

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

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v7.0.11] - 2025-12-12

Patch release adding feature/bun-executable to experimental branch selector for testing Bun runtime integration.

## [v7.0.9] - 2025-12-10

## Bug Fixes

- Fixed MCP response format in search route handlers - all 14 search endpoints now return complete response objects with error status instead of just content arrays, restoring MCP protocol compatibility

## Changes

- `SearchRoutes.ts`: Updated all route handlers to return full result object instead of extracted content property

## [v7.0.8] - 2025-12-10

## Bug Fixes

- **Critical**: Filter out meta-observations for session-memory files to prevent recursive timeline pollution
  - Memory agent was creating observations about editing Agent SDK's session-memory/summary.md files
  - This created a recursive loop where investigating timeline pollution caused more pollution
  - Filter now skips Edit/Write/Read/NotebookEdit operations on any file path containing 'session-memory'
  - Eliminates 91+ meta-observations that were polluting the timeline

## Technical Details

Added filtering logic in SessionRoutes.ts to detect and skip file operations on session-memory files before observations are queued to the SDK agent. This prevents the memory agent from observing its own observation metadata files.

## [v7.0.7] - 2025-12-10

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

## [v7.0.6] - 2025-12-10

## Bug Fixes

- Fixed Windows terminal spawning to hide terminal windows when spawning child processes (#203, thanks @CrystallDEV)
- Improved worker service process management on Windows

## Contributors

Thanks to @CrystallDEV for this contribution!

## [v7.0.5] - 2025-12-09

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

## [v7.0.4] - 2025-12-09

## What's Changed

### Bug Fixes
- **Windows**: Comprehensive fixes for Windows plugin installation
- **Cache**: Add package.json to plugin directory for cache dependency resolution

Thanks to @kat-bell for the excellent contributions!

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.3...v7.0.4

## [v7.0.3] - 2025-12-09

## What's Changed

**Refactoring:**
- Completed rename of `search-server` to `mcp-server` throughout codebase
- Updated all documentation references from search-server to mcp-server
- Updated debug log messages to use `[mcp-server]` prefix
- Removed legacy `search-server.cjs` file

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.2...v7.0.3

## [v7.0.2] - 2025-12-09

## What's Changed

**Bug Fixes:**
- Improved auto-start worker functionality for better reliability

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.1...v7.0.2

## [v7.0.1] - 2025-12-09

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

## [v7.0.0] - 2025-12-08

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

## [v6.5.3] - 2025-12-05

## Bug Fixes

- **Windows**: Hide console window when spawning child processes (#166)
  - Adds `windowsHide: true` to `spawnSync` and `execSync` calls
  - Prevents empty terminal windows from appearing on Windows when hooks execute

Reference: https://nodejs.org/api/child_process.html (windowsHide option)

## [v6.5.2] - 2025-12-04

## What's Changed

- **Upgraded better-sqlite3** from `^11.0.0` to `^12.5.0` for Node.js 25 compatibility

### Fixes
- Resolves compilation errors when installing on Node.js 25.x (#164)

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v6.5.1] - 2025-12-04

## What's New

- Decorative Product Hunt announcement in terminal with rocket borders
- Product Hunt badge in viewer header with theme-aware switching (light/dark)
- Badge uses separate tracking URL for analytics

## Changes

This is a temporary launch day update. The announcement will auto-expire at midnight EST.

## [v6.5.0] - 2025-12-04

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [v6.4.9] - 2025-12-02

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

🤖 Generated with [Claude Code](https://claude.com/claude-code)


