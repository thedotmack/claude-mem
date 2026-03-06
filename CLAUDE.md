# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db`

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Planning Skill** (`plugin/skills/make-plan/SKILL.md`) - Orchestrator instructions for creating phased implementation plans with documentation discovery

**Execution Skill** (`plugin/skills/do/SKILL.md`) - Orchestrator instructions for executing phased plans using subagents

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

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

Claude-mem has a clean separation between open-source core and optional Pro cloud sync.

### URLs

- **Production**: `https://claude-mem.ai` (Vercel, Next.js)
- **Supabase**: `https://data.claude-mem.ai` (custom domain)
- **Dashboard**: `https://claude-mem.ai/dashboard`
- **Docs**: `https://docs.claude-mem.ai` (Mintlify)

### Stack

- **Database**: Supabase PostgreSQL (shared tables with `user_id` isolation via RLS)
- **Auth**: Supabase Auth (GitHub, Google, email) — two patterns: session-based (cookies for UI) and Bearer token (`setup_token` for worker sync)
- **Vectors**: Pinecone Serverless — namespace-per-user (`user_<first8chars_of_userId>`), embeddings via `multilingual-e5-large` (1024d)
- **Payments**: Stripe (webhook at `/api/webhooks/stripe`)

### Pro API (claude-mem-pro repo, deployed to Vercel)

33 API routes under `src/app/api/pro/` covering: validate-setup, store (batch/observation/summary/prompt), sync (observation/summary/prompt/status/query/stats), fetch (observations/summaries/prompts), checkout, provision, initialize, status, export.

### Worker-Side Pro (this repo)

- **ProRoutes** (`src/services/worker/http/routes/ProRoutes.ts`) — `/api/pro/setup`, `/status`, `/disconnect`, `/import`
- **ProConfig** (`src/services/pro/ProConfig.ts`) — Reads/writes `~/.claude-mem/pro.json`
- **CloudSync** (`src/services/sync/CloudSync.ts`) — SyncProvider for Pro users, stores directly to Supabase/Pinecone via mem-pro API
- **SyncProvider** (`src/services/sync/SyncProvider.ts`) — Dual-mode abstraction: `isCloudPrimary()` toggles between CloudSync (Pro) and ChromaSync (free)

### Dual Sync Mode

- **Free**: SQLite primary, ChromaSync backs up vectors to local Chroma
- **Pro**: Cloud-primary, CloudSync stores directly to Supabase/Pinecone (bypasses SQLite for new data)
- `ResponseProcessor` checks `syncProvider.isCloudPrimary()` to decide the write path
- `ensureBackfilled()` migrates all existing local SQLite data to cloud on first Pro setup

### Setup Flow

1. User runs `/pro-setup` skill with their `cm_pro_<32-hex>` token
2. Skill calls `POST https://claude-mem.ai/api/pro/validate-setup` directly
3. Config saved to `~/.claude-mem/pro.json`
4. Worker detects Pro config and uses CloudSync instead of ChromaSync

### Testing Pro Locally

The worker's `DEFAULT_PRO_API_URL` in `ProRoutes.ts` can be overridden via `CLAUDE_MEM_PRO_API_URL` env var for local testing against staging.

### Open-Source Core (this repository)

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless — no proprietary UI elements in this codebase
- Users without Pro continue using the full open-source viewer UI without limitation

## Important

No need to edit the changelog ever, it's generated automatically.
