/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db` with FTS5 full-text search

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy control (manual, prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level tag (auto-injected observations, prevents recursive storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker (most common)
npm run build                 # Compile TypeScript only
npm run sync-marketplace      # Copy to ~/.claude/plugins only
npm run worker:restart        # Restart worker service only
npm run worker:status         # Check worker status
npm run worker:logs           # View worker logs
```

**Viewer UI**: http://localhost:37777

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

**Core Settings:**
- `CLAUDE_MEM_MODEL` - Model for observations/summaries (default: claude-haiku-4-5)
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Observations injected at SessionStart
- `CLAUDE_MEM_WORKER_PORT` - Worker service port (default: 37777)
- `CLAUDE_MEM_WORKER_HOST` - Worker bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)

**System Configuration:**
- `CLAUDE_MEM_DATA_DIR` - Data directory location (default: ~/.claude-mem)
- `CLAUDE_MEM_LOG_LEVEL` - Log verbosity: DEBUG, INFO, WARN, ERROR, SILENT (default: INFO)

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js (build tools only)

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main
