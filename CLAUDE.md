# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**Data Flow**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd (5 lifecycle hooks)

**Hook Pipeline**: `src/hooks/*.ts` → esbuild → `plugin/scripts/*-hook.js` (ESM bundles with bun shebang)

**Plugin Config**: `plugin/hooks/hooks.json` defines hook-to-lifecycle event bindings; `plugin/.mcp.json` registers MCP server

| Source Hook | Built Output | Lifecycle Event |
|-------------|--------------|-----------------|
| `context-hook.ts` | `context-hook.js` | SessionStart (injects context) |
| `user-message-hook.ts` | `user-message-hook.js` | SessionStart (after context) |
| `new-hook.ts` | `new-hook.js` | UserPromptSubmit (creates/updates session) |
| `save-hook.ts` | `save-hook.js` | PostToolUse |
| `summary-hook.ts` | `summary-hook.js` | Stop |
| `cleanup-hook.ts` | `cleanup-hook.js` | SessionEnd |

**Worker Service** (`src/services/worker-service.ts` → `plugin/scripts/worker-service.cjs`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously. Route handlers in `src/services/worker/http/routes/`.

**Auto-Start Behavior**: Worker auto-starts on SessionStart via `ensureWorkerRunning()` in `src/shared/worker-utils.ts`. Checks `/health` endpoint; if unhealthy, starts worker via `ProcessManager`. Also auto-restarts on version mismatch between plugin and running worker.

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db` with FTS5 full-text search. Schema migrations in `migrations.ts`.

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Build & Development

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker (most common)
npm run build                 # Compile TypeScript via esbuild only
npm run sync-marketplace      # Copy plugin/ to ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:restart        # Restart worker service only
npm run worker:status         # Check worker status
npm run worker:logs           # View worker logs (today's log file)
```

**Testing**:
```bash
npm test                      # Run all vitest tests
npm test -- --run             # Run once without watch mode
npm test -- tests/happy-paths/search.test.ts   # Run single test file
npm test -- -t "search"       # Run tests matching pattern
npm run test:context          # Test context injection hook manually
```

Note: Some tests in `tests/` use node:test runner (excluded from vitest): `strip-memory-tags.test.ts`, `user-prompt-tag-stripping.test.ts`

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy control (manual, prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level tag (auto-injected observations, prevents recursive storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. Auto-created with defaults on first run.

**Core Settings:**
- `CLAUDE_MEM_MODEL` - Model for observations/summaries (default: claude-sonnet-4-5)
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Observations injected at SessionStart
- `CLAUDE_MEM_WORKER_PORT` - Worker service port (default: 37777)
- `CLAUDE_MEM_WORKER_HOST` - Worker bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)
- `CLAUDE_MEM_DATA_DIR` - Data directory location (default: ~/.claude-mem)
- `CLAUDE_MEM_LOG_LEVEL` - Log verbosity: DEBUG, INFO, WARN, ERROR, SILENT (default: INFO)

## File Locations

- **Source**: `src/`
- **Built Plugin**: `plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`
- **Logs**: `~/.claude-mem/logs/worker-YYYY-MM-DD.log`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js 18+ (build tools only)

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

# Important

No need to edit the changelog ever, it's generated automatically.
