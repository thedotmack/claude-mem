# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db`

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Version Management

Switch between stable and development versions to avoid instability during active development.

```bash
npm run version:status        # Show current branch, installed version, cached versions
npm run version:stable        # Switch to main branch (stable)
npm run version:dev           # Switch to dev branch (auto-stashes changes)
```

**Workflow**:
- When your local version is stable, stay on that branch
- Use `version:stable` to quickly rollback if updates cause issues
- The script handles worker restart and git stash automatically

**Local Settings Preservation**: `sync-marketplace` preserves these files during sync:
- `/.mcp.json` - MCP server configuration
- `/local/` - User customizations directory
- `*.local.*` - Any file with .local. in name
- `/.env.local` - Local environment variables

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Exit Code Strategy

Claude-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

See `private/context/claude-code/exit-codes.md` for full hook behavior matrix.

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Pro Features Architecture

Claude-mem is designed with a clean separation between open-source core functionality and optional Pro features.

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

## AI Auto-Fix Boundaries (YOLO Push)

Define the scope of what AI can autonomously fix in CI pipelines.

### ✅ Allow List (Auto-fix permitted)

These mechanical issues can be fixed automatically without human review:

- **Linting**: ESLint errors and warnings
- **Formatting**: Prettier formatting issues
- **Types**: TypeScript type errors (missing types, type mismatches)
- **Imports**: Unused imports, import ordering, missing imports for used symbols
- **Spelling**: Variable/function name typos caught by cspell
- **Dependencies**: Missing peer dependencies in package.json

### ❌ Deny List (Human review required)

These areas require human judgment and must NOT be auto-fixed:

- **Security**: Any code in authentication, authorization, or credential handling
- **Database**: `src/services/sqlite/` - Schema changes, migrations, query logic
- **Hooks Core**: `src/hooks/*.ts` - Hook execution flow and lifecycle
- **API Design**: New endpoints, breaking changes to existing APIs
- **Architecture**: New abstractions, pattern changes, dependency additions
- **Privacy**: `src/utils/tag-stripping.ts` - Privacy tag handling logic
- **Business Logic**: Observation compression, scoring algorithms
- **Configuration**: `settings.json` schema changes, default values

### 🔄 Retry Policy

- Maximum 2 auto-fix attempts per CI failure
- Escalate to human review after max retries
- Never auto-fix the same file more than once per PR
