# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage via lifecycle hooks, compresses observations using the Claude Agent SDK, stores them in SQLite, and injects relevant context into future sessions.

## Build & Test Commands

```bash
npm run build-and-sync        # Full build → sync to marketplace → restart worker
npm run build                 # Build hooks/worker/MCP server only (esbuild → plugin/scripts/)
npm run worker:restart        # Restart worker without rebuilding
npm run worker:logs           # View today's worker logs
npm run worker:tail           # Tail today's worker logs

bun test                      # Run all tests
bun test tests/sqlite/        # Run SQLite tests only
bun test tests/worker/agents/ # Run agent tests only
bun test tests/path/to/file.test.ts  # Run single test file
```

## Architecture

### Data Flow

```
Claude Code hooks → Worker HTTP API (port 37777) → SQLite + Chroma
                                                  ↓
                    SDK Agent (Claude subprocess) → observations/summaries
                                                  ↓
                    Context Generator → injected into next session
```

### Hook Lifecycle

5 events, configured in `plugin/hooks/hooks.json`:
1. **SessionStart** - Smart-install deps, start worker, generate context
2. **UserPromptSubmit** - Ensure worker running, init session
3. **PostToolUse** - Record observation (every tool call)
4. **Stop** (Summary) - Summarize session, mark complete
5. **Setup** - One-time plugin setup

Hooks run as CLI commands: `worker-service.cjs hook claude-code <event>`. Input arrives via stdin JSON, output goes to stdout JSON. The CLI adapter layer (`src/cli/adapters/`) normalizes input per platform (claude-code, cursor, raw).

### Key Components

**Worker Service** (`src/services/worker-service.ts`) - Express HTTP server on port 37777. Orchestrator that delegates to specialized services. Background initialization pattern: starts accepting requests immediately, finishes DB/search setup async.

**Route Handlers** (`src/services/worker/http/routes/`) - REST API endpoints: sessions, search, data, settings, viewer, logs, memory.

**SDK Agent** (`src/services/worker/SDKAgent.ts`) - Spawns Claude subprocess via `@anthropic-ai/claude-agent-sdk` to compress observations into structured memories. Supports Gemini and OpenRouter as alternative backends.

**Context System** (`src/services/context/`) - Generates the context block injected into sessions. Pipeline: `ContextConfigLoader` → `ObservationCompiler` → section renderers (Header, Timeline, Summary, Footer) → `MarkdownFormatter`.

**SQLite** (`src/services/sqlite/`) - Uses `bun:sqlite` (not better-sqlite3). Database at `~/.claude-mem/claude-mem.db`. Schema managed by `MigrationRunner` in `migrations/runner.ts`.

**MCP Server** (`src/servers/mcp-server.ts`) - Thin MCP wrapper around Worker HTTP API. Provides `search` and `timeline` tools. Critical: stdout is reserved for JSON-RPC, all logging must go to stderr.

**Viewer UI** (`src/ui/viewer/`) - React SPA built to `plugin/ui/viewer.html`, served at http://localhost:37777.

### Build Pipeline

`scripts/build-hooks.js` uses esbuild to bundle TypeScript into standalone CJS files in `plugin/scripts/`:
- `worker-service.cjs` (runs under Bun)
- `mcp-server.cjs` (runs under Node)
- `context-generator.cjs`
- `viewer-bundle.js` (React app)

Version is injected at build time via `__DEFAULT_PACKAGE_VERSION__` esbuild define.

### File Locations

| What | Where |
|------|-------|
| Source | `src/` |
| Built plugin | `plugin/` |
| Installed plugin | `~/.claude/plugins/marketplaces/thedotmack/` |
| Database | `~/.claude-mem/claude-mem.db` |
| Settings | `~/.claude-mem/settings.json` |
| Chroma vectors | `~/.claude-mem/chroma/` |
| Worker logs | `~/.claude-mem/logs/` |

## Exit Code Strategy

Per Claude Code's hook contract:
- **Exit 0**: Success (or graceful shutdown on Windows to avoid tab accumulation)
- **Exit 1**: Non-blocking error (stderr shown only in verbose mode)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

Worker/hook errors intentionally exit 0 on Windows. ERROR-level logging maintained for diagnostics.

## Privacy

`<private>content</private>` tags strip content at hook layer before reaching worker/database. See `src/utils/tag-stripping.ts`.

## Important

- Changelog is auto-generated, never edit it manually.
- `bun:sqlite` is a Bun built-in - no npm package needed for SQLite.
- The `plugin/` directory contains built artifacts checked into git. Always rebuild before committing changes.
- Settings auto-created with defaults on first run via `SettingsDefaultsManager`.
