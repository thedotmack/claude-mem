/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

**Current Version**: 6.1.1

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, PM2-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db` with FTS5 full-text search

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Build Commands

**Hooks only**: `npm run build && npm run sync-marketplace`

**Worker changes**: `npm run build && npm run sync-marketplace && npm run worker:restart`

**Skills only**: `npm run sync-marketplace`

**Viewer UI**: `npm run build && npm run sync-marketplace && npm run worker:restart`

## Environment Variables

- `CLAUDE_MEM_MODEL` - Model for observations/summaries (default: claude-haiku-4-5)
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Observations injected at SessionStart (default: 50)
- `CLAUDE_MEM_WORKER_PORT` - Worker service port (default: 37777)

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`
- **Usage Logs**: `~/.claude-mem/usage-logs/usage-YYYY-MM-DD.jsonl`

## Quick Reference

```bash
npm run build                 # Compile TypeScript
npm run sync-marketplace      # Copy to ~/.claude/plugins
npm run worker:restart        # Restart PM2 worker
npm run worker:logs           # View worker logs
pm2 list                      # Check worker status
pm2 delete claude-mem-worker  # Force clean start
```

**Viewer UI**: http://localhost:37777
