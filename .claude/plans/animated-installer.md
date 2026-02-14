# Comprehensive Claude-Mem Installer with @clack/prompts

## Overview

Build a beautiful, animated CLI installer for claude-mem using `@clack/prompts` (v1.0.1). Distributable via `npx claude-mem-installer` and `curl -fsSL https://install.cmem.ai | bash`. Replaces the need for users to manually clone, build, configure settings, and start the worker.

**Worktree**: `feat/animated-installer` at `.claude/worktrees/animated-installer`

---

## Phase 0: Documentation & API Reference

### Allowed APIs (@clack/prompts v1.0.1, ESM-only)

| API | Signature | Use Case |
|-----|-----------|----------|
| `intro(title?)` | `void` | Opening banner |
| `outro(message?)` | `void` | Completion message |
| `cancel(message?)` | `void` | User cancelled |
| `isCancel(value)` | `boolean` | Check if user pressed Ctrl+C |
| `text(opts)` | `Promise<string \| symbol>` | API key input, port, data dir |
| `password(opts)` | `Promise<string \| symbol>` | API key input (masked) |
| `select(opts)` | `Promise<Value \| symbol>` | Provider, model, auth method |
| `multiselect(opts)` | `Promise<Value[] \| symbol>` | IDE selection, observation types |
| `confirm(opts)` | `Promise<boolean \| symbol>` | Enable Chroma, start worker |
| `spinner()` | `SpinnerResult` | Installing deps, building, starting worker |
| `progress(opts)` | `ProgressResult` | Multi-step installation progress |
| `tasks(tasks[])` | `Promise<void>` | Sequential install steps |
| `group(prompts, opts)` | `Promise<Results>` | Chain prompts with shared results |
| `note(message, title)` | `void` | Display settings summary, next steps |
| `log.info/success/warn/error(msg)` | `void` | Status messages |
| `box(message, title, opts)` | `void` | Welcome box, completion summary |

### Anti-Patterns
- Do NOT use `require()` — package is ESM-only
- Do NOT call prompts without TTY check first — hangs indefinitely in non-TTY
- Do NOT forget `isCancel()` check after every prompt (or use `group()` with `onCancel`)
- Do NOT use `chalk` — use `picocolors` (clack's dep) for consistency
- `text()` has no numeric mode — validate manually for port numbers
- `spinner.stop()` does not accept status codes — use `spinner.error()` for failures

### Distribution Patterns
- **npx**: `package.json` `bin` field → `"./dist/index.js"`, file needs `#!/usr/bin/env node`
- **curl|bash**: Shell bootstrap downloads JS, runs `node script.js` directly (preserves TTY)
- **esbuild**: Bundle to single ESM file, `platform: 'node'`, `banner` for shebang

### Key Source Files to Reference
- Settings defaults: `src/shared/SettingsDefaultsManager.ts` (lines 73-125)
- Settings validation: `src/services/server/SettingsRoutes.ts`
- Worker startup: `src/services/worker-service.ts` (lines 337-359)
- Health check: `src/services/infrastructure/HealthMonitor.ts`
- Plugin registration: `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Marketplace sync: `scripts/sync-marketplace.cjs`
- Cursor integration: `src/services/integrations/CursorHooksInstaller.ts`
- Existing OpenClaw installer: `install/public/openclaw.sh` (reference for logic, not code to copy)

---

## Phase 1: Project Scaffolding

**Goal**: Set up the installer package structure with build tooling.

### Tasks

1. **Create directory structure** in the worktree:
   ```
   installer/
   ├── src/
   │   ├── index.ts              # Entry point with TTY guard
   │   ├── steps/
   │   │   ├── welcome.ts        # intro + version check
   │   │   ├── dependencies.ts   # bun, uv, git checks
   │   │   ├── ide-selection.ts  # IDE picker + registration
   │   │   ├── provider.ts       # AI provider + API key
   │   │   ├── settings.ts       # Additional settings config
   │   │   ├── install.ts        # Clone, build, register plugin
   │   │   ├── worker.ts         # Start worker + health check
   │   │   └── complete.ts       # Summary + next steps
   │   └── utils/
   │       ├── system.ts         # OS detection, command runner
   │       ├── dependencies.ts   # bun/uv/git install helpers
   │       └── settings-writer.ts # Write ~/.claude-mem/settings.json
   ├── build.mjs                 # esbuild config
   ├── package.json              # bin, type: module, deps
   └── tsconfig.json
   ```

2. **Create `package.json`**:
   ```json
   {
     "name": "claude-mem-installer",
     "version": "1.0.0",
     "type": "module",
     "bin": { "claude-mem-installer": "./dist/index.js" },
     "files": ["dist"],
     "scripts": {
       "build": "node build.mjs",
       "dev": "node build.mjs && node dist/index.js"
     },
     "dependencies": {
       "@clack/prompts": "^1.0.1",
       "picocolors": "^1.1.1"
     },
     "devDependencies": {
       "esbuild": "^0.24.0",
       "typescript": "^5.7.0",
       "@types/node": "^22.0.0"
     },
     "engines": { "node": ">=18.0.0" }
   }
   ```

3. **Create `build.mjs`**:
   - esbuild bundle: `entryPoints: ['src/index.ts']`, `format: 'esm'`, `platform: 'node'`, `target: 'node18'`
   - Banner: `#!/usr/bin/env node`
   - Output: `dist/index.js`

4. **Create `tsconfig.json`**:
   - `module: "ESNext"`, `target: "ES2022"`, `moduleResolution: "bundler"`

5. **Run `npm install`** in installer/ directory

### Verification
- [ ] `node build.mjs` succeeds
- [ ] `dist/index.js` exists with shebang
- [ ] `node dist/index.js` runs (even if empty installer)

---

## Phase 2: Entry Point + Welcome Screen

**Goal**: Create the main entry point with TTY detection and a beautiful welcome screen.

### Tasks

1. **`src/index.ts`** — Entry point:
   - TTY guard: if `!process.stdin.isTTY`, print error directing user to `npx claude-mem-installer`, exit 1
   - Import and call `runInstaller()` from steps
   - Top-level catch → `p.cancel()` + exit 1

2. **`src/steps/welcome.ts`** — Welcome step:
   - `p.intro()` with styled title using picocolors: `" claude-mem installer "`
   - Display version info via `p.log.info()`
   - Check if already installed (detect `~/.claude-mem/settings.json` and `~/.claude/plugins/marketplaces/thedotmack/`)
   - If upgrade detected, `p.confirm()`: "claude-mem is already installed. Upgrade?"
   - `p.select()` for install mode: Fresh Install vs Upgrade vs Configure Only

3. **`src/utils/system.ts`** — System utilities:
   - `detectOS()`: returns 'macos' | 'linux' | 'windows'
   - `commandExists(cmd)`: checks if command is in PATH
   - `runCommand(cmd, args)`: executes shell command, returns { stdout, stderr, exitCode }
   - `expandHome(path)`: resolves `~` to home directory

### Verification
- [ ] Running `node dist/index.js` shows intro banner
- [ ] Ctrl+C triggers cancel message
- [ ] Non-TTY (piped) shows error and exits

---

## Phase 3: Dependency Checks

**Goal**: Check and install required dependencies (Bun, uv, git, Node.js version).

### Tasks

1. **`src/steps/dependencies.ts`** — Dependency checker:
   - Use `p.tasks()` to check each dependency sequentially with animated spinners:
     - **Node.js**: Verify >= 18.0.0 via `process.version`
     - **git**: `commandExists('git')`, show install instructions per OS if missing
     - **Bun**: Check PATH + common locations (`~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`). Min version 1.1.14. Offer to auto-install from `https://bun.sh/install`
     - **uv**: Check PATH + common locations (`~/.local/bin/uv`, `~/.cargo/bin/uv`). Offer to auto-install from `https://astral.sh/uv/install.sh`
   - For missing deps: `p.confirm()` to auto-install, or show manual instructions
   - After install attempts, re-verify each dep

2. **`src/utils/dependencies.ts`** — Install helpers:
   - `installBun()`: downloads and runs bun install script
   - `installUv()`: downloads and runs uv install script
   - `findBinary(name, extraPaths[])`: searches PATH + known locations
   - `checkVersion(binary, minVersion)`: parses `--version` output

### Verification
- [ ] Shows green checkmarks for found dependencies
- [ ] Shows yellow warnings for missing deps with install option
- [ ] Auto-install actually installs bun/uv when confirmed
- [ ] Fails gracefully if git is missing (can't auto-install)

---

## Phase 4: IDE Selection & Provider Configuration

**Goal**: Let user choose IDEs and configure AI provider with API keys.

### Tasks

1. **`src/steps/ide-selection.ts`** — IDE picker:
   - `p.multiselect()` with options:
     - Claude Code (default selected, hint: "recommended")
     - Cursor
     - Windsurf (hint: "coming soon", disabled: true)
   - For Claude Code: explain plugin will be registered via marketplace
   - For Cursor: explain hooks will be installed via CursorHooksInstaller pattern
   - Store selections for later installation steps

2. **`src/steps/provider.ts`** — AI provider configuration:
   - `p.select()` for provider:
     - **Claude** (hint: "recommended — uses your Claude subscription")
     - **Gemini** (hint: "free tier available")
     - **OpenRouter** (hint: "free models available")
   - **If Claude selected**:
     - `p.select()` for auth method: "CLI (Max Plan subscription)" vs "API Key"
     - If API key: `p.password()` for key input
   - **If Gemini selected**:
     - `p.password()` for API key (required)
     - `p.select()` for model: gemini-2.5-flash-lite (default), gemini-2.5-flash, gemini-3-flash-preview
     - `p.confirm()` for rate limiting (default: true)
   - **If OpenRouter selected**:
     - `p.password()` for API key (required)
     - `p.text()` for model (default: `xiaomi/mimo-v2-flash:free`)
   - Validate API keys where possible (non-empty, format check)

### Verification
- [ ] Multiselect allows picking multiple IDEs
- [ ] Provider selection shows correct follow-up prompts
- [ ] API keys are masked during input
- [ ] Cancel at any step triggers graceful exit

---

## Phase 5: Settings Configuration

**Goal**: Configure additional settings with sensible defaults.

### Tasks

1. **`src/steps/settings.ts`** — Settings wizard:
   - `p.confirm()`: "Use default settings?" (recommended) — if yes, skip detailed config
   - If customizing, use `p.group()` for:
     - **Worker port**: `p.text()` with default 37777, validate 1024-65535
     - **Data directory**: `p.text()` with default `~/.claude-mem`
     - **Context observations**: `p.text()` with default 50, validate 1-200
     - **Log level**: `p.select()` — DEBUG, INFO (default), WARN, ERROR
     - **Python version**: `p.text()` with default 3.13
     - **Chroma vector search**: `p.confirm()` (default: true)
       - If yes, `p.select()` mode: local (default) vs remote
       - If remote: `p.text()` for host, port, `p.confirm()` for SSL
   - Show settings summary via `p.note()` before proceeding

2. **`src/utils/settings-writer.ts`** — Write settings:
   - Build flat key-value settings object matching SettingsDefaultsManager schema
   - Merge with existing settings if upgrading (preserve user customizations)
   - Write to `~/.claude-mem/settings.json`
   - Create `~/.claude-mem/` directory if it doesn't exist

### Verification
- [ ] Default settings mode skips all detailed prompts
- [ ] Custom settings validates all inputs
- [ ] Settings file written matches SettingsDefaultsManager schema exactly
- [ ] Existing settings preserved on upgrade

---

## Phase 6: Installation Execution

**Goal**: Clone repo, build plugin, register with IDEs, start worker.

### Tasks

1. **`src/steps/install.ts`** — Installation runner:
   - Use `p.tasks()` for visual progress:
     - **"Cloning claude-mem repository"**: `git clone --depth 1 https://github.com/thedotmack/claude-mem.git` to temp dir
     - **"Installing dependencies"**: `npm install` in cloned repo
     - **"Building plugin"**: `npm run build` in cloned repo
     - **"Registering plugin"**: Copy plugin files to `~/.claude/plugins/marketplaces/thedotmack/`
       - Create marketplace.json, plugin.json structure
       - Register in `~/.claude/plugins/known_marketplaces.json`
       - Add to `~/.claude/plugins/installed_plugins.json`
       - Enable in `~/.claude/settings.json` under `enabledPlugins`
     - **"Installing dependencies"** (in marketplace dir): `npm install`
   - For Cursor (if selected):
     - **"Configuring Cursor hooks"**: Run Cursor hooks installer logic
     - Write hooks.json to `~/.cursor/` or project-level `.cursor/`
     - Configure MCP in `.cursor/mcp.json`

2. **`src/steps/worker.ts`** — Worker startup:
   - Use `p.spinner()` for worker startup:
     - Start worker: `bun plugin/scripts/worker-service.cjs` (from marketplace dir)
     - Write PID file to `~/.claude-mem/worker.pid`
   - Two-stage health check (copy pattern from OpenClaw installer):
     - Stage 1: Poll `/api/health` — spinner message: "Starting worker service..."
     - Stage 2: Poll `/api/readiness` — spinner message: "Initializing database..."
     - Budget: 30 attempts, 1 second apart
     - On success: `spinner.stop("Worker running on port {port}")`
     - On failure: `spinner.error("Worker failed to start")`, show log path

### Verification
- [ ] Plugin files exist at `~/.claude/plugins/marketplaces/thedotmack/`
- [ ] known_marketplaces.json updated
- [ ] installed_plugins.json updated
- [ ] settings.json has enabledPlugins entry
- [ ] Worker responds to `/api/health` with 200
- [ ] Worker responds to `/api/readiness` with 200

---

## Phase 7: Completion & Summary

**Goal**: Show success screen with configuration summary and next steps.

### Tasks

1. **`src/steps/complete.ts`** — Completion screen:
   - `p.note()` with configuration summary:
     - Provider + model
     - IDEs configured
     - Data directory
     - Worker port
     - Chroma enabled/disabled
   - `p.note()` with next steps:
     - "Open Claude Code and start a conversation — memory is automatic!"
     - "View your memories: http://localhost:{port}"
     - "Search past work: use /mem-search in Claude Code"
     - If Cursor: "Open Cursor — hooks are active in your projects"
   - `p.outro()` with styled completion message

### Verification
- [ ] Summary accurately reflects chosen settings
- [ ] URLs use correct port from settings
- [ ] Next steps are relevant to selected IDEs

---

## Phase 8: curl|bash Bootstrap Script

**Goal**: Create the shell bootstrap script for `curl -fsSL https://install.cmem.ai | bash`.

### Tasks

1. **`install/public/install.sh`** — Bootstrap script:
   - Check for Node.js >= 18 (required to run the installer)
   - Download bundled installer JS to temp file
   - Execute with `node` directly (preserves TTY for @clack/prompts)
   - Cleanup temp file on exit (trap)
   - Support `--non-interactive` flag passthrough
   - Support `--provider=X --api-key=Y` flag passthrough

2. **Update `install/vercel.json`** to serve `install.sh` alongside `openclaw.sh`

### Verification
- [ ] `curl -fsSL https://install.cmem.ai | bash` downloads and runs installer
- [ ] Interactive prompts work after curl download
- [ ] Temp file cleaned up on success and failure
- [ ] Flags pass through correctly

---

## Phase 9: Final Verification

### Checks
- [ ] `npm run build` in installer/ produces single-file `dist/index.js`
- [ ] `node dist/index.js` runs full wizard flow
- [ ] Fresh install on clean system works end-to-end
- [ ] Upgrade path preserves existing settings
- [ ] Ctrl+C at any step exits cleanly
- [ ] Non-TTY shows error message
- [ ] All settings written match SettingsDefaultsManager.ts defaults schema
- [ ] Worker health check succeeds after install
- [ ] Plugin appears in Claude Code plugin list
- [ ] grep for deprecated/non-existent APIs returns 0 results
- [ ] No `require()` calls in source (ESM-only)
- [ ] No `chalk` imports (use picocolors)
