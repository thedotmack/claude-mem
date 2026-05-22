# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**6 Lifecycle Hooks**: Setup → SessionStart → UserPromptSubmit → PreToolUse (Read) → PostToolUse → Stop

**Hooks** - Entries in `plugin/hooks/hooks.json` dispatch to the unified worker (`plugin/scripts/worker-service.cjs`, built from `src/services/worker-service.ts` via `scripts/build-hooks.js`) through `bun-runner.js`, invoking subcommands like `context`, `session-init`, `observation`, `file-context`, and `summarize`. The Setup-phase `version-check.js` is the only standalone hook script.

**Worker Service** (`src/services/worker-service.ts`) - Express API on the per-user worker port (default `37700 + (uid % 100)`, configurable via `CLAUDE_MEM_WORKER_PORT`), Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db`

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Planning Skill** (`plugin/skills/make-plan/SKILL.md`) - Orchestrator instructions for creating phased implementation plans with documentation discovery

**Execution Skill** (`plugin/skills/do/SKILL.md`) - Orchestrator instructions for executing phased plans using subagents

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface served by the worker on its configured port (default `http://127.0.0.1:<worker-port>`), built to `plugin/ui/viewer.html`

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

## Multi-account

Claude-mem supports running multiple isolated profiles on the same machine (e.g. work vs personal accounts) via environment variables. No CLI subcommand needed — set the env vars in the shell where you run Claude Code.

- **Switch profiles per shell:** Set `CLAUDE_MEM_DATA_DIR=<path>` and every claude-mem path (database, chroma, logs, settings.json, worker.pid, transcripts config) derives from it. Example:

  ```bash
  export CLAUDE_MEM_DATA_DIR="$HOME/.claude-mem-work"
  ```

- **Port collisions are auto-handled:** The default worker port is `37700 + (uid % 100)`, so two different OS users on the same box get different ports for free. If you want fixed ports per profile (e.g. you run two profiles as the same UID), set `CLAUDE_MEM_WORKER_PORT` too:

  ```bash
  export CLAUDE_MEM_WORKER_PORT=37800
  ```

- **All paths and ports derive from these two env vars.** Hooks, npx-cli (`install`/`uninstall`/`start`/`search`), the OpenCode plugin, the OpenClaw installer, and the timeline-report skill all honor them. The settings file itself lives at `$CLAUDE_MEM_DATA_DIR/settings.json`.

- See `src/shared/SettingsDefaultsManager.ts` for the canonical port/data-dir defaults and `plugin/skills/timeline-report/SKILL.md` for the shell snippet that resolves the port for arbitrary skills.

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

- All local worker HTTP API endpoints (per-user port — see Architecture above) remain fully open and accessible
- Pro features are headless - no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

**Pro Features** (coming soon, external):

- Enhanced UI (Memory Stream) connects to the same local worker endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

This architecture preserves the open-source nature of the project while enabling sustainable development through optional paid features.

## Important

No need to edit the changelog ever, it's generated automatically.

## Daily Maintenance

Run a daily version check across all package manifests and upgrade every dependency to its latest version — including major version bumps. Staying on the latest is the goal; do not skip majors.

- Check `package.json` (root) and all nested `package.json` files (e.g. `plugin/`, `openclaw/`) for outdated dependencies via `npm outdated`.
- Upgrade every package to `latest` (use `npm install <pkg>@latest` for each, or `npx npm-check-updates -u && npm install`). Bump majors too.
- Run `npm audit fix` to resolve advisories.
- After upgrades, run `npm run build-and-sync` and verify the worker starts and tests pass. Fix any breakage caused by major bumps in the same change.
- Commit the updated `package.json` and `package-lock.json` files.

---

## CLAUDE.md Best Practices Reference

**Sources:** [Article by @0xDepressionn](https://x.com/0xDepressionn/status/2055999112470839383) · [21-rule reference card](https://x.com/0xDepressionn/status/2057115586480513376/photo/1)

Karpathy's method: 65% → 94% coding accuracy. One plain text file. 21 rules. 2-hour setup. ~$975/week saved per developer.

### Karpathy's 4 core rules

1. **Ask, don't assume** — Unclear? Ask before writing a single line. Never assume intent.
2. **Simplest first** — No abstractions or flexibility not explicitly requested.
3. **Don't touch unrelated** — Not part of the task? Don't touch it. Even if it seems like a good idea.
4. **Flag uncertainty** — Not confident? Say it before proceeding. Always.

### Full 21-rule framework

**DEFAULTS (1–7)** — eliminate repeated context
1. Kill filler — No "Great question!" — start with the answer.
2. Match length — Short for simple. Full for complex. No padding.
3. Show options — 2–3 approaches first. Wait for choice.
4. Admit gaps — Not sure? Say it before including it.
5. Who I am — Name / Role / Strong in / Still learning.
6. Project context — Goal / Stack / Audience / What to avoid.
7. Lock voice — Style + words I use / words I never use.

**BEHAVIOR (8–14)** — prevent unauthorized changes
8. Stay in scope — Touch only what's asked. Note the rest.
9. Ask first — Describe the change. Wait for yes.
10. Confirm destruct — Deleting? List what's affected. Wait.
11. Hard stops — Deploy / migrate / send = explicit yes.
12. Show changes — Files touched / modified / untouched / next.
13. No acting alone — Never send/post/publish without yes.
14. Think first — Reason step by step before coding.

**MEMORY + STACK (15–21)** — prevent forgotten decisions
15. MEMORY.md — Log: what / why / what was rejected.
16. Session end — Summary: done / in progress / next.
17. ERRORS.md — Log failures. Check before suggesting.
18. Permanent facts — Always-true rules. Flag any conflict.
19. Lock stack — Define tech stack. Never switch without asking.
20. Think deep — Architecture = extended thinking. Always.
21. Karpathy's 4 — See above. The rules that went viral.
