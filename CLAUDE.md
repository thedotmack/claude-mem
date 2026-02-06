# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

### Lifecycle Hooks

**4 Hook Events** (defined in `plugin/hooks/hooks.json`):
- **SessionStart** — Smart install, worker start, context injection, user-message generation
- **UserPromptSubmit** — Worker start, session initialization
- **PostToolUse** — Worker start, observation capture (matches all tools)
- **Stop** — Worker start, session summarization

Hooks are TypeScript (`src/hooks/`) compiled via esbuild to CommonJS (`plugin/scripts/*`).

### Core Services

| Layer | Location | Purpose |
|-------|----------|---------|
| **Worker Service** | `src/services/worker/` | Express API on port 37777, orchestrates all services |
| **CLI** | `src/cli/` | Hook command dispatching with adapters (Claude Code, Cursor) and handlers (context, observation, session-init, summarize, user-message) |
| **Database** | `src/services/sqlite/` | SQLite3 at `~/.claude-mem/claude-mem.db` with migrations, stores sessions, observations, summaries, prompts, timeline |
| **Context Engine** | `src/services/context/` | ContextBuilder, ObservationCompiler, TokenCalculator; formatters (Markdown, Color); section renderers (Timeline, Summary, Header, Footer) |
| **Search** | `src/services/worker/search/` | SearchOrchestrator with 3 strategies (SQLite, Chroma, Hybrid) and filters (Date, Type, Project) |
| **Chroma** | `src/services/sync/ChromaSync.ts` | Vector embeddings for semantic search |
| **Infrastructure** | `src/services/infrastructure/` | ProcessManager, HealthMonitor, GracefulShutdown |
| **MCP Server** | `src/servers/mcp-server.ts` | Model Context Protocol server for search skill |
| **HTTP Routes** | `src/services/worker/http/routes/` | Viewer, Session, Data, Search, Settings, Logs routes |

### Viewer UI

React SPA at `src/ui/viewer/` — 13 components, 8 custom hooks. Built to `plugin/ui/viewer.html` + `viewer-bundle.js`. Accessible at http://localhost:37777.

### Plugin Structure

```
plugin/
├── hooks/hooks.json          # Lifecycle hook definitions
├── scripts/                  # Compiled service scripts (CJS)
├── skills/mem-search/        # Search skill (SKILL.md + MCP)
├── commands/                 # User-facing commands (do.md, make-plan.md)
├── modes/                    # 36 multilingual prompt modes
└── ui/                       # Viewer SPA + fonts + icons
```

### Multilingual Modes

36 prompt mode files in `plugin/modes/` covering: English, Chinese, Japanese, Portuguese (BR), Korean, Spanish, German, French, Hebrew, Arabic, Russian, Polish, Czech, Dutch, Turkish, Ukrainian, Vietnamese, Indonesian, Thai, Hindi, Bengali, Romanian, Swedish, Italian, Greek, Hungarian, Finnish, Danish, Norwegian, plus casual/chill variant and email-investigation mode.

### Cursor Integration

Cursor IDE hooks in `cursor-hooks/` with shell scripts for session-init, context-inject, save-observation, save-file-edit, and session-summary. Install via `npm run cursor:install`.

## Privacy Tags

- `<private>content</private>` — User-level privacy control (manual, prevents storage)

Tag stripping happens at the hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts`.

## Build & Development

### Key Commands

```bash
npm run build-and-sync        # Build hooks, sync to marketplace, restart worker
npm run build                 # Build hooks only (esbuild → plugin/scripts/)
npm run sync-marketplace      # Sync plugin to ~/.claude/plugins/marketplaces/thedotmack/
```

### Worker Management

```bash
npm run worker:start          # Start worker service via Bun
npm run worker:stop           # Stop worker
npm run worker:restart        # Restart worker
npm run worker:status         # Check worker status
npm run worker:logs           # View today's logs (last 50 lines)
npm run worker:tail           # Tail today's logs
```

### Queue Management

```bash
npm run queue                 # Check pending queue items
npm run queue:process         # Process pending queue
npm run queue:clear           # Clear all failed queue items
```

### Testing

```bash
npm test                      # Run all tests (bun test)
npm run test:sqlite           # SQLite store tests
npm run test:agents           # Worker agent tests
npm run test:search           # Search strategy tests
npm run test:context          # Context engine tests
npm run test:infra            # Infrastructure tests
npm run test:server           # Server tests
```

Tests are in `tests/` organized by module: sqlite, worker/agents, worker/search, context, infrastructure, server, integration, shared, utils.

### Other Useful Scripts

```bash
npm run claude-md:regenerate  # Regenerate claude-mem activity in .claude/CLAUDE.md
npm run claude-md:dry-run     # Preview regeneration
npm run bug-report            # Generate bug report
npm run cursor:install        # Install Cursor IDE hooks
npm run cursor:status         # Check Cursor hook status
npm run translate:all         # Translate README to all supported languages
```

## Configuration

Settings managed in `~/.claude-mem/settings.json` via `src/shared/SettingsDefaultsManager.ts`. Auto-created with defaults on first run.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`
- **Logs**: `~/.claude-mem/logs/`
- **Settings**: `~/.claude-mem/settings.json`

## Exit Code Strategy

Claude-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

## Requirements

- **Node.js** >= 18.0.0
- **Bun** >= 1.0.0 (all platforms — auto-installed if missing)
- **uv** (all platforms — auto-installed if missing, provides Python for Chroma)

## SDK Exports

The package exports a public SDK (`src/sdk/`) with parser, prompts, and index modules. Available as `claude-mem/sdk` import path.

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` — MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Pro Features Architecture

Claude-mem is designed with a clean separation between open-source core functionality and optional Pro features.

**Open-Source Core** (this repository):
- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless — no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

**Pro Features** (coming soon, external):
- Enhanced UI (Memory Stream) connects to the same localhost:37777 endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

## Important

No need to edit the changelog ever, it's generated automatically.
