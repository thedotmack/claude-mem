# Changelog

All notable changes to this project will be documented in this file.

## v8.2.2

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

## v8.2.1

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

## v8.2.0

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

## v8.1.0

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

## v8.0.6

## Bug Fixes

- Add error handlers to Chroma sync operations to prevent worker crashes on timeout (#428)

This patch release improves stability by adding proper error handling to Chroma vector database sync operations, preventing worker crashes when sync operations timeout.

## v8.0.5

## Bug Fixes

- **Context Loading**: Fixed observation filtering for non-code modes, ensuring observations are properly retrieved across all mode types

## Technical Details

Refactored context loading logic to differentiate between code and non-code modes, resolving issues where mode-specific observations were filtered by stale settings.

## v8.0.4

## Changes

- Changed worker start script

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## v8.0.3

Fix critical worker crashes on startup (v8.0.2 regression)

## v8.0.2

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

## v8.0.1

## 🎨 UI Improvements

- **Header Redesign**: Moved documentation and X (Twitter) links from settings modal to main header for better accessibility
- **Removed Product Hunt Badge**: Cleaned up header layout by removing the Product Hunt badge
- **Icon Reorganization**: Reordered header icons for improved UX flow (Docs → X → Discord → GitHub)

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## v8.0.0

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

