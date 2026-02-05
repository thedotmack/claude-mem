# Claude-Memu: AI Development Instructions

Claude-memu is a Claude Code plugin providing persistent memory across sessions using [memU](https://github.com/NevaMind-AI/memU) for hierarchical memory storage. It captures tool usage, extracts observations, and injects relevant context into future sessions.

## Architecture

**Memory Backend**: memU (NevaMind-AI/memU) - Hierarchical memory with Categories → Items → Resources

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Storage Backend Interface** (`src/interfaces/IStorageBackend.ts`) - Abstract interface for swappable storage

**memU Adapter** (`src/services/memu/`) - memU API client and storage adapter
- `memu-client.ts` - HTTP client for memU API (cloud or self-hosted)
- `memu-adapter.ts` - IStorageBackend implementation using memU
- `types.ts` - TypeScript types for memU API

**SQLite Adapter** (`src/services/backend/SqliteAdapter.ts`) - Legacy SQLite backend (backwards compatibility)

**Backend Factory** (`src/services/backend/BackendFactory.ts`) - Creates storage backend based on config

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## memU Integration

memU provides hierarchical memory storage with:
- **Categories**: Project-level groupings (maps to claude-memu projects)
- **Items**: Individual memories (observations, summaries)
- **Resources**: Raw content attachments

**Key memU API Endpoints**:
- `POST /api/v3/memory/memorize` - Store memories with continuous learning
- `POST /api/v3/memory/retrieve` - Query memories (RAG or LLM method)
- `POST /api/v3/memory/categories` - List/manage categories
- `POST /api/v3/memory/items` - Direct item CRUD

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Configuration

Settings are managed in `~/.claude-memu/settings.json`. The file is auto-created with defaults on first run.

**New memU Settings**:
```json
{
  "CLAUDE_MEMU_BACKEND": "memu",        // 'memu' | 'sqlite'
  "CLAUDE_MEMU_API_KEY": "...",         // memU API key
  "CLAUDE_MEMU_API_URL": "https://api.memu.so",  // or self-hosted URL
  "CLAUDE_MEMU_NAMESPACE": "default"    // Namespace for isolation
}
```

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Local Database** (SQLite mode): `~/.claude-memu/claude-memu.db`
- **Settings**: `~/.claude-memu/settings.json`
- **Logs**: `~/.claude-memu/logs/`

## Exit Code Strategy

Claude-memu hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **memU API Key** (for cloud backend) or self-hosted memU instance
- Node.js

## Documentation

**Public Docs**: https://docs.claude-memu.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Storage Backend Architecture

Claude-memu uses an abstracted storage backend pattern:

```
IStorageBackend (interface)
├── MemuAdapter     - memU API (default, cloud or self-hosted)
└── SqliteAdapter   - Legacy SQLite (backwards compatibility)
```

**Backend Selection** (via `CLAUDE_MEMU_BACKEND`):
- `memu` (default): Uses memU cloud API or self-hosted instance
- `sqlite`: Uses local SQLite database (legacy mode)

**Key Interface Methods**:
- `createSession()` / `getSessionById()` - Session management
- `storeMemory()` / `searchMemories()` - Memory CRUD and search
- `storeSummary()` / `getSummaryBySessionId()` - Summary management
- `storeUserPrompt()` / `getLatestPrompt()` - User prompt tracking

## Pro Features Architecture

Claude-memu is designed with a clean separation between open-source core functionality and optional Pro features.

**Open-Source Core** (this repository):

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless - no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

**Pro Features** (coming soon, external):

- Enhanced UI (Memory Stream) connects to the same localhost:37777 endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

This architecture preserves the open-source nature of the project while enabling sustainable development through optional paid features.

## Important

No need to edit the changelog ever, it's generated automatically.
