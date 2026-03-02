# Changelog

All notable changes to claude-mem.

## [v10.5.2] - 2026-02-26

## Smart Explore Benchmark Docs & Skill Update

### Documentation
- Published smart-explore benchmark report to public docs — full A/B comparison with methodology, raw data tables, quality assessment, and decision framework
- Added benchmark report to docs.json navigation under Best Practices

### Smart Explore Skill
- Updated token economics with benchmark-accurate data (11-18x savings on exploration, 4-8x on file understanding)
- Added "map first" core principle as decision heuristic for tool selection
- Added AST completeness guarantee to smart_unfold documentation (never truncates, unlike Explore agents)
- Added Explore agent escalation guidance for multi-file synthesis tasks
- Updated smart_unfold token range from ~1-7k to ~400-2,100 based on measurements
- Updated Explore agent token range from ~20-40k to ~39-59k based on measurements

## [v10.5.1] - 2026-02-26

### Bug Fix

- Restored hooks.json to pre-smart-explore configuration (re-adds Setup hook, separate worker start command, PostToolUse matcher)

## [v10.5.0] - 2026-02-26

## Smart Explore: AST-Powered Code Navigation

This release introduces **Smart Explore**, a token-optimized structural code search system built on tree-sitter AST parsing. It applies the same progressive disclosure pattern used in human-readable code outlines — but programmatically, for AI agents.

### Why This Matters

The standard exploration cycle (Glob → Grep → Read) forces agents to consume entire files to understand code structure. A typical 800-line file costs ~12,000 tokens to read. Smart Explore replaces this with a 3-layer progressive disclosure workflow that delivers the same understanding at **6-12x lower token cost**.

### 3 New MCP Tools

- **`smart_search`** — Walks directories, parses all code files via tree-sitter, and returns ranked symbols with signatures and line numbers. Replaces the Glob → Grep discovery cycle in a single call (~2-6k tokens).
- **`smart_outline`** — Returns the complete structural skeleton of a file: all functions, classes, methods, properties, imports (~1-2k tokens vs ~12k for a full Read).
- **`smart_unfold`** — Expands a single symbol to its full source code including JSDoc, decorators, and implementation (~1-7k tokens).

### Token Economics

| Approach | Tokens | Savings |
|----------|--------|---------|
| smart_outline + smart_unfold | ~3,100 | 8x vs Read |
| smart_search (cross-file) | ~2,000-6,000 | 6-12x vs Explore agent |
| Read (full file) | ~12,000+ | baseline |
| Explore agent | ~20,000-40,000 | baseline |

### Language Support

10 languages via tree-sitter grammars: TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, Ruby, PHP.

### Other Changes

- Simplified hooks configuration
- Removed legacy setup.sh script
- Security fix: replaced `execSync` with `execFileSync` to prevent command injection in file path handling

## [v10.4.4] - 2026-02-26

## Fix

- **Remove `save_observation` from MCP tool surface** — This tool was exposed as an MCP tool available to Claude, but it's an internal API-only feature. Removing it from the MCP server prevents unintended tool invocation and keeps the tool surface clean.

## [v10.4.3] - 2026-02-25

## Bug Fixes

- **Fix PostToolUse hook crashes and 5-second latency (#1220)**: Added missing `break` statements to all 7 switch cases in `worker-service.ts` preventing fall-through execution, added `.catch()` on `main()` to handle unhandled promise rejections, and removed redundant `start` commands from hook groups that triggered the 5-second `collectStdin()` timeout
- **Fix CLAUDE_PLUGIN_ROOT fallback for Stop hooks (#1215)**: Added POSIX shell-level `CLAUDE_PLUGIN_ROOT` fallback in `hooks.json` for environments where the variable isn't injected, added script-level self-resolution via `import.meta.url` in `bun-runner.js`, and regression test added in `plugin-distribution.test.ts`

## Maintenance

- Synced all version files (plugin.json was stuck at 10.4.0)

## [v10.4.2] - 2026-02-25

## Bug Fixes

- **Fix PostToolUse hook crashes and 5-second latency (#1220)**: Added missing `break` statements to all 7 switch cases in `worker-service.ts` preventing fall-through execution, added `.catch()` on `main()` to handle unhandled promise rejections, and removed redundant `start` commands from hook groups that triggered the 5-second `collectStdin()` timeout
- **Fix CLAUDE_PLUGIN_ROOT fallback for Stop hooks (#1215)**: Added POSIX shell-level `CLAUDE_PLUGIN_ROOT` fallback in `hooks.json` for environments where the variable isn't injected, added script-level self-resolution via `import.meta.url` in `bun-runner.js`, and regression test added in `plugin-distribution.test.ts`
- **Sync plugin.json version**: Fixed `plugin.json` being stuck at 10.4.0 while other version files were at 10.4.1

## [v10.4.1] - 2026-02-24

### Refactor
- **Skills Conversion**: Converted `/make-plan` and `/do` commands into first-class skills in `plugin/skills/`.
- **Organization**: Centralized planning and execution instructions alongside `mem-search`.
- **Compatibility**: Added symlinks for `openclaw/skills/` to ensure seamless integration with OpenClaw.

### Chore
- **Version Bump**: Aligned all package and plugin manifests to v10.4.1.

## [v10.4.0] - 2026-02-24

## v10.4.0 — Stability & Platform Hardening

Massive reliability release: 30+ root-cause bug fixes across 10 triage phases, plus new features for agent attribution, Chroma control, and broader platform support.

### New Features

- **Session custom titles** — Agents can now set `custom_title` on sessions for attribution (migration 23, new endpoint)
- **Chroma toggle** — `CLAUDE_MEM_CHROMA_ENABLED` setting allows SQLite-only fallback mode (#707)
- **Plugin disabled state** — Early exit check in all hook entry points when plugin is disabled (#781)
- **Context re-injection guard** — `contextInjected` session flag prevents re-injecting context on every UserPromptSubmit turn (#1079)

### Bug Fixes

#### Data Integrity
- SHA-256 content-hash deduplication on observation INSERT (migration 22 with backfill + index)
- Project name collision fix: `getCurrentProjectName()` now returns `parent/basename`
- Empty project string guard with cwd-derived fallback
- Stuck `isProcessing` reset: pending work older than 5 minutes auto-clears

#### ChromaDB
- Python version pinning in uvx args for both local and remote mode (#1196, #1206, #1208)
- Windows backslash-to-forward-slash path conversion for `--data-dir` (#1199)
- Metadata sanitization: filter null/undefined/empty values in `addDocuments()` (#1183, #1188)
- Transport error auto-reconnect in `callTool()` (#1162)
- Stale transport retry with transparent reconnect (#1131)

#### Hook Lifecycle
- Suppress `process.stderr.write` in `hookCommand()` to prevent diagnostic output showing as error UI (#1181)
- Route all `console.error()` through logger instead of stderr
- Verified all 7 handlers return `suppressOutput: true` (#598, #784)

#### Worker Lifecycle
- PID file mtime guard prevents concurrent restart storms (#1145)
- `getInstalledPluginVersion()` ENOENT/EBUSY handling (#1042)

#### SQLite Migrations
- Schema initialization always creates core tables via `CREATE TABLE IF NOT EXISTS`
- Migrations 5-7 check actual DB state instead of version tracking (fixes version collision between old/new migration systems, #979)
- Crash-safe temp table rebuilds

#### Platform Support
- **Windows**: `cmd.exe /c` uvx spawn, PowerShell `$_` elimination with WQL filtering, `windowsHide: true`, FTS5 runtime probe with fallback (#1190, #1192, #1199, #1024, #1062, #1048, #791)
- **Cursor IDE**: Adapter field fallbacks, tolerant session-init validation (#838, #1049)
- **Codex CLI**: `session_id` fallbacks, unknown platform tolerance, undefined guard (#744)

#### API & Infrastructure
- `/api/logs` OOM fix: tail-read replaces full-file `readFileSync` (64KB expanding chunks, 10MB cap, #1203)
- CORS: explicit methods and allowedHeaders (#1029)
- MCP type coercion for batch endpoints: string-to-array for `ids` and `memorySessionIds`
- Defensive observation error handling returns 200 on recoverable errors instead of 500
- `.git/` directory write guard on all 4 CLAUDE.md/AGENTS.md write sites (#1165)

#### Stale AbortController Fix
- `lastGeneratorActivity` timestamp tracking with 30s timeout (#1099)
- Stale generator detection + abort + restart in `ensureGeneratorRunning`
- `AbortSignal.timeout(30000)` in `deleteSession` prevents indefinite hang

### Installation
- `resolveRoot()` replaces hardcoded marketplace path using `CLAUDE_PLUGIN_ROOT` env var (#1128, #1166)
- `installCLI()` path correction and `verifyCriticalModules()` post-install check
- Build-time distribution verification for skills, hooks, and plugin manifest (#1187)

### Testing
- 50+ new tests across hook lifecycle, context re-injection, plugin distribution, migration runner, data integrity, stale abort controller, logs tail-read, CORS, MCP type coercion, and smart-install
- 68 files changed, ~4200 insertions, ~900 deletions

## [v10.3.3] - 2026-02-23

### Bug Fixes

- Fixed session context footer to reference the claude-mem skill instead of MCP search tools for accessing memories

## [v10.3.2] - 2026-02-23

## Bug Fixes

- **Worker startup readiness**: Worker startup hook now waits for full DB/search readiness before proceeding, fixing the race condition where hooks would fire before the worker was initialized on first start (#1210)
- **MCP tool naming**: Renamed `save_memory` to `save_observation` for consistency with the observation-based data model (#1210)
- **MCP search instructions**: Updated MCP server tool descriptions to accurately reflect the 3-layer search workflow (#1210)
- **Installer hosting**: Serve installer JS from install.cmem.ai instead of GitHub raw URLs for reliability
- **Installer routing**: Added rewrite rule so install.cmem.ai root path correctly serves the install script
- **Installer build**: Added compiled installer dist so CLI installation works out of the box

## [v10.3.1] - 2026-02-19

## Fix: Prevent Duplicate Worker Daemons and Zombie Processes

Three root causes of chroma-mcp timeouts identified and fixed:

### PID-based daemon guard
Exit immediately on startup if PID file points to a live process. Prevents the race condition where hooks firing simultaneously could start multiple daemons before either wrote a PID file.

### Port-based daemon guard
Exit if port 37777 is already bound — runs before WorkerService constructor registers keepalive signal handlers that previously prevented exit on EADDRINUSE.

### Guaranteed process.exit() after HTTP shutdown
HTTP shutdown (POST /api/admin/shutdown) now calls `process.exit(0)` in a `try/finally` block. Previously, zombie workers stayed alive after shutdown, and background tasks reconnected to chroma-mcp, spawning duplicate subprocesses contending for the same data directory.

## [v10.3.0] - 2026-02-18

## Replace WASM Embeddings with Persistent chroma-mcp MCP Connection

### Highlights

- **New: ChromaMcpManager** — Singleton stdio MCP client communicating with chroma-mcp via `uvx`, replacing the previous ChromaServerManager (`npx chroma run` + `chromadb` npm + ONNX/WASM)
- **Eliminates native binary issues** — No more segfaults, WASM embedding failures, or cross-platform install headaches
- **Graceful subprocess lifecycle** — Wired into GracefulShutdown for clean teardown; zombie process prevention with kill-on-failure and stale `onclose` handler guards
- **Connection backoff** — 10-second reconnect backoff prevents chroma-mcp spawn storms
- **SQL injection guards** — Added parameterization to ChromaSync ID exclusion queries
- **Simplified ChromaSync** — Reduced complexity by delegating embedding concerns to chroma-mcp

### Breaking Changes

None — backward compatible. ChromaDB data is preserved; only the connection mechanism changed.

### Files Changed

- `src/services/sync/ChromaMcpManager.ts` (new) — MCP client singleton
- `src/services/sync/ChromaServerManager.ts` (deleted) — Old WASM/native approach
- `src/services/sync/ChromaSync.ts` — Simplified to use MCP client
- `src/services/worker-service.ts` — Updated startup sequence
- `src/services/infrastructure/GracefulShutdown.ts` — Subprocess cleanup integration

## [v10.2.6] - 2026-02-18

## Bug Fixes

### Zombie Process Prevention (#1168, #1175)

Observer Claude CLI subprocesses were accumulating as zombies — processes that never exited after their session ended, causing massive resource leaks on long-running systems.

**Root cause:** When observer sessions ended (via idle timeout, abort, or error), the spawned Claude CLI subprocesses were not being reliably killed. The existing `ensureProcessExit()` in `SDKAgent` only covered the happy path; sessions terminated through `SessionRoutes` or `worker-service` bypassed process cleanup entirely.

**Fix — dual-layer approach:**

1. **Immediate cleanup:** Added `ensureProcessExit()` calls to the `finally` blocks in both `SessionRoutes.ts` and `worker-service.ts`, ensuring every session exit path kills its subprocess
2. **Periodic reaping:** Added `reapStaleSessions()` to `SessionManager` — a background interval that scans `~/.claude-mem/observer-sessions/` for stale PID files, verifies the process is still running, and kills any orphans with SIGKILL escalation

This ensures no observer subprocess survives beyond its session lifetime, even in crash scenarios.

## [v10.2.5] - 2026-02-18

### Bug Fixes

- **Self-healing message queue**: Renamed `claimAndDelete` → `claimNextMessage` with atomic self-healing — automatically resets stale processing messages (>60s) back to pending before claiming, eliminating stuck messages from generator crashes without external timers
- **Removed redundant idle-timeout reset**: The `resetStaleProcessingMessages()` call during idle timeout in worker-service was removed (startup reset kept), since the atomic self-healing in `claimNextMessage` now handles recovery inline
- **TypeScript diagnostic fix**: Added `QUEUE` to logger `Component` type

### Tests

- 5 new tests for self-healing behavior (stuck recovery, active protection, atomicity, empty queue, session isolation)
- 1 new integration test for stuck recovery in zombie-prevention suite
- All existing queue tests updated for renamed method

## [v10.2.4] - 2026-02-18

## Chroma Vector DB Backfill Fix

Fixes the Chroma backfill system to correctly sync all SQLite observations into the vector database on worker startup.

### Bug Fixes

- **Backfill all projects on startup** — `backfillAllProjects()` now runs on worker startup, iterating all projects in SQLite and syncing missing observations to Chroma. Previously `ensureBackfilled()` existed but was never called, leaving Chroma with incomplete data after cache clears.

- **Fixed critical collection routing bug** — Backfill now uses the shared `cm__claude-mem` collection (matching how DatabaseManager and SearchManager operate) instead of creating per-project orphan collections that no search path reads from.

- **Hardened collection name sanitization** — Project names with special characters (e.g., "YC Stuff") are sanitized for Chroma's naming constraints, including stripping trailing non-alphanumeric characters.

- **Eliminated shared mutable state** — `ensureBackfilled()` and `getExistingChromaIds()` now accept project as a parameter instead of mutating instance state, keeping a single Chroma connection while avoiding fragile property mutation across iterations.

- **Chroma readiness guard** — Backfill waits for Chroma server readiness before running, preventing spurious error logs when Chroma fails to start.

### Changed Files

- `src/services/sync/ChromaSync.ts` — Core backfill logic, sanitization, parameter passing
- `src/services/worker-service.ts` — Startup backfill trigger + readiness guard
- `src/utils/logger.ts` — Added `CHROMA_SYNC` log component

## [v10.2.3] - 2026-02-17

## Fix Chroma ONNX Model Cache Corruption

Addresses the persistent embedding pipeline failures reported across #1104, #1105, #1110, and subsequent sessions. Three root causes identified and fixed:

### Changes

- **Removed nuclear `bun pm cache rm`** from both `smart-install.js` and `sync-marketplace.cjs`. This was added in v10.2.2 for the now-removed sharp dependency but destroyed all cached packages, breaking the ONNX resolution chain.
- **Added `bun install` in plugin cache directory** after marketplace sync. The cache directory had a `package.json` with `@chroma-core/default-embed` as a dependency but never ran install, so the worker couldn't resolve it at runtime.
- **Moved HuggingFace model cache to `~/.claude-mem/models/`** outside `node_modules`. The ~23MB ONNX model was stored inside `node_modules/@huggingface/transformers/.cache/`, so any reinstall or cache clear corrupted it.
- **Added self-healing retry** for Protobuf parsing failures. If the downloaded model is corrupted, the cache is cleared and re-downloaded automatically on next use.

### Files Changed

- `scripts/smart-install.js` — removed `bun pm cache rm`
- `scripts/sync-marketplace.cjs` — removed `bun pm cache rm`, added `bun install` in cache dir
- `src/services/sync/ChromaSync.ts` — moved model cache, added corruption recovery

## [v10.2.2] - 2026-02-17

## Bug Fixes

- **Removed `node-addon-api` dev dependency** — was only needed for `sharp`, which was already removed in v10.2.1
- **Simplified native module cache clearing** in `smart-install.js` and `sync-marketplace.cjs` — replaced targeted `@img/sharp` directory deletion and lockfile removal with `bun pm cache rm`
- Reduced ~30 lines of brittle file system manipulation to a clean Bun CLI command

## [v10.2.1] - 2026-02-16

## Bug Fixes

- **Bun install & sharp native modules**: Fixed stale native module cache issues on Bun updates, added `node-addon-api` as a dev dependency required by sharp (#1140)
- **PendingMessageStore consolidation**: Deduplicated PendingMessageStore initialization in worker-service; added session-scoped filtering to `resetStaleProcessingMessages` to prevent cross-session message resets (#1140)
- **Gemini empty response handling**: Fixed silent message deletion when Gemini returns empty summary responses — now logs a warning and preserves the original message (#1138)
- **Idle timeout session scoping**: Fixed idle timeout handler to only reset messages for the timed-out session instead of globally resetting all sessions (#1138)
- **Shell injection in sync-marketplace**: Replaced `execSync` with `spawnSync` for rsync calls to eliminate command injection via gitignore patterns (#1138)
- **Sharp cache invalidation**: Added cache clearing for sharp's native bindings when Bun version changes (#1138)
- **Marketplace install**: Switched marketplace sync from npm to bun for package installation consistency (#1140)

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

