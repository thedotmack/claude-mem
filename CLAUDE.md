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

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search; transcript segments stored in separate Chroma collection (traversal-only)

**Conversation Observation Modality** - TITANS-inspired observer producing 7 observation types from conversation flow

**3-Layer Progressive Search**: `search()` → `get_observations()` → `get_transcript_segment()`

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

## Development Environment

**Dev happens in git worktrees + Docker containers.** Never run worker code directly against your host's `~/.claude-mem` — it collides with the host's own claude-mem worker on port 37777 and corrupts shared SQLite state.

**Worktree setup**: each branch lives in its own worktree under `~/conductor/workspaces/claude-mem/<worktree-name>/` so multiple branches can be worked on concurrently without rebasing.

**Docker setup** (`docker/claude-mem/`):

```bash
docker/claude-mem/build.sh         # builds claude-mem:basic (runs npm run build first, bakes plugin/)
docker/claude-mem/dev.sh           # interactive dev container, one session
```

**Persistent detached dev container** — preferred when an AI agent is driving development and needs to `docker exec` commands repeatedly:

```bash
# Boots worker in background, survives until `docker rm -f claude-mem-dev`.
# Uses OAuth from macOS Keychain (fallback: ~/.claude/.credentials.json).
CREDS_FILE=$(mktemp -t claude-mem-creds.XXXXXX.json)
security find-generic-password -s 'Claude Code-credentials' -w > "$CREDS_FILE" \
  || cp "$HOME/.claude/.credentials.json" "$CREDS_FILE"
chmod 600 "$CREDS_FILE"
mkdir -p .docker-claude-mem-data
docker run -d --name claude-mem-dev \
  -p 37778:37777 \
  -e CLAUDE_MEM_WORKER_HOST=0.0.0.0 \
  -e CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json \
  -v "$CREDS_FILE:/auth/.credentials.json:ro" \
  -v "$(pwd)/plugin:/opt/claude-mem" \
  -v "$(pwd)/.docker-claude-mem-data:/home/node/.claude-mem" \
  claude-mem:basic \
  bash -c 'mkdir -p $HOME/.claude-mem/logs && exec bun /opt/claude-mem/scripts/worker-service.cjs 2>&1 | tee -a $HOME/.claude-mem/logs/worker.log'
```

**Iteration loop**:

1. Edit `src/` on the host (worktree).
2. `npm run build` on the host — regenerates `plugin/`, which is bind-mounted into the container.
3. Restart the worker inside: `docker exec claude-mem-dev bash -c 'pkill -f worker-service.cjs; exec bun /opt/claude-mem/scripts/worker-service.cjs >> ~/.claude-mem/logs/worker.log 2>&1 &'`
4. Hit `http://localhost:37778/` for the viewer, `http://localhost:37778/health` to verify.

**Key boundaries** (why the setup is what it is):

- **Port 37778, not 37777** — avoids colliding with the host's own claude-mem worker.
- **`CLAUDE_MEM_WORKER_HOST=0.0.0.0`** required — the default `127.0.0.1` bind makes Docker Desktop port forwarding reset the connection.
- **Bind-mount `plugin/` over `/opt/claude-mem`** — host `npm run build` propagates without an image rebuild. The image only needs rebuilding when Docker-level deps change (Bun/uv/Node/Claude CLI versions).
- **Persistent state** at `.docker-claude-mem-data/` in repo root (gitignored) — SQLite + Chroma survive across container restarts so test data carries over.
- **Git operations stay on host** — commits, diffs, and branch switches happen in the worktree.

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
