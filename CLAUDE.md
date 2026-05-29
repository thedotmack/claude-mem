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

### Anthropic Credentials (proxies, gateways, BigModel, etc.)

For non-OAuth Anthropic credentials (proxies / gateways / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`), put them in `~/.claude-mem/.env`:

```
ANTHROPIC_BASE_URL=https://your-proxy.example
ANTHROPIC_AUTH_TOKEN=your-token
```

`~/.claude-mem/.env` is the single source of truth for these variables. The file is read at worker/SDK spawn time and re-injected into the SDK subprocess. **Parent-shell exports of `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` are intentionally ignored** — they are in `BLOCKED_ENV_VARS` (`src/shared/EnvManager.ts`) to prevent host-config bleed-through (#2375).

Likewise, `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` from the host CLI are stripped before the SDK subprocess starts (#2357), so they never reach the Messages API as an `effort` parameter.

If you only have an OAuth subscription, no `.env` is needed; the worker reads the token from your keychain at spawn time.

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

## Spawn-Contract Resolution

claude-mem integrations resolve `${CLAUDE_PLUGIN_ROOT}` (and equivalents) using one of three rules. Pick the rule by **who owns the config file** — host or installer. See `plans/02-spawn-contract-templating.md` for the full catalogue and rationale (issues #1215, #1533).

### Rule A — Host-managed shell-template (Claude Code, Codex CLI)

Sites: `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `plugin/.mcp.json`.

The host (Claude Code or Codex) owns the file's runtime location and rotates the cache directory on plugin upgrade. The `command` strings use a defensive POSIX-shell prelude that reads `${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}` first, then falls back through the host cache directories (newest first) and the marketplace install dir. The fallback chain ORDER is contractual.

These strings are emitted by the single generator `src/build/hook-shell-template.ts`. Hand-editing the command strings is forbidden — `scripts/build-hooks.js` (`verifyShellTemplateCanonical`) fails the build if a checked-in file drifts from the generator, and `tests/infrastructure/plugin-distribution.test.ts` asserts byte parity.

### Rule B — Installer-managed bake (Cursor, Gemini, Windsurf, MCP-only IDEs)

Sites: any per-IDE config file written by `src/services/integrations/*Installer.ts` (Cursor, Gemini, Windsurf, and the MCP-only IDEs: Copilot CLI, Antigravity, Goose, Roo, Warp).

Those hosts perform NO `${VAR}` substitution on the `command`/`args` they exec, so the installer bakes absolute paths via the centralized helpers in `src/services/integrations/install-paths.ts` (`getMcpServerAbsolutePath`, `getWorkerServiceAbsolutePath`, `getBunAbsolutePath`, `getNodeAbsolutePath`, `getPluginRootAbsolutePath`). Installers are bake-and-overwrite of their `claude-mem`-namespaced entries, so re-running `npx claude-mem install` re-bakes idempotently on upgrade. Never emit a raw `${CLAUDE_PLUGIN_ROOT}` from an installer.

### Rule C — Runtime resolution (`bun-runner.js`, `version-check.js`)

Both runtime scripts accept `CLAUDE_PLUGIN_ROOT` env first, then fall back to `dirname(import.meta.url)/..`. This is the safety net behind Rules A and B. `bun-runner.js`'s `fixBrokenScriptPath` repairs a raw `/scripts/...` arg that leaked through an unsubstituted Rule A placeholder — the build asserts it stays present.

### Exempt by design

- **OpenCode** (`src/services/integrations/OpenCodeInstaller.ts`, `src/integrations/opencode-plugin/index.ts`): JS plugin, no shell — receives plugin-root via the OpenCode plugin context.
- **OpenClaw** (`openclaw/`): configured via `configSchema` (`workerPort`, `workerHost`); no plugin-root templating.
- **Manifest files** (`plugin.json`, `marketplace.json`): hosts do not support `${VAR}` substitution; relative paths only.

### Windows spawn caveats

- **Codex CLI** is installed as `codex.cmd` on Windows; `spawnSync('codex', …)` without a shell throws ENOENT (#2695). `codexSpawn()` in `CodexCliInstaller.ts` uses `shell: true` (+ arg quoting) on Windows so PATHEXT resolves the shim.
- **chroma-mcp** is spawned via `cmd.exe /c uvx …`; dep-override specs like `protobuf<7` contain cmd.exe redirection operators and must be quoted (#2696). `quoteForCmdExe()` in `ChromaMcpManager.ts` wraps any arg containing `< > | & ^ ( )`.

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

### Hook IO Discipline

All stdout / stderr / exit emits during a hook execution route through `src/shared/hook-io.ts`. `hookCommand` (`src/cli/hook-command.ts`) is its only orchestrator; handlers stay pure.

- `emitDiagnostic(line)` — operator-visible stderr (logger fallback, fail-loud counter). Bypasses the hook stderr buffer.
- `emitModelContext(adapter, result)` — JSON to stdout via the platform adapter's `formatOutput`. Exactly once per hook.
- `withUserHint(result, hint)` — user-visible advisory, returned via `HookResult.systemMessage`; adapters route it per-platform.
- `emitBlockingError(msg)` — flushes buffered stderr, writes `msg`, exits 2. The model receives `msg` per the hook contract. Used by `recordWorkerUnreachable` (fail-loud, fixes #2292) and `hookCommand`'s unrecoverable-error catch.
- `exitGraceful()` — exit 0, drops any buffered stderr (the quiet-on-success / Windows Terminal behavior).

Handler authors: write your handler as a pure function returning `HookResult`. **Never call `process.stderr.write`, `console.log`, `console.error`, or `process.exit` from a handler or adapter.** The `npm run lint:hook-io` check (`scripts/check-hook-io-discipline.cjs`) enforces this in `src/cli/handlers/**` and `src/cli/adapters/**`.

The stderr buffer (installed by `installHookStderrBuffer`) captures unsolicited library writes during handler execution so they never leak into model context. Buffered bytes are dropped on `exitGraceful` and flushed on `emitDiagnostic` / `emitBlockingError`.

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
