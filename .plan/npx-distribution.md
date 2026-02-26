# Plan: NPX Distribution + Universal IDE/CLI Coverage for claude-mem

## Problem

1. **Installation is slow and fragile**: Current install clones the full git repo, runs `npm install`, and builds from source. The npm package already ships pre-built artifacts.

2. **IDE coverage is limited**: claude-mem only supports Claude Code (plugin) and Cursor (hooks installer). The AI coding tools landscape has exploded — Gemini CLI (95k stars), OpenCode (110k stars), Windsurf (~1M users), Codex CLI, Antigravity, Goose, Crush, Copilot CLI, and more all support extensibility.

## Key Insights

- **npm package already has everything**: `plugin/` directory ships pre-built. No git clone or build needed.
- **Transcript watcher already exists**: `src/services/transcripts/` has a fully built schema-based JSONL tailer. It just needs schemas for more tools.
- **3 integration tiers exist**: (1) Hook/plugin-based (Claude Code, Gemini CLI, OpenCode, Windsurf, Codex CLI, OpenClaw), (2) MCP-based (Cursor, Copilot CLI, Antigravity, Goose, Crush, Roo Code), (3) Transcript-based (anything with structured log files).
- **OpenClaw plugin already built**: Full plugin at `openclaw/src/index.ts` (1000+ lines). Needs to be wired into the npx installer.
- **Gemini CLI is architecturally near-identical to Claude Code**: 11 lifecycle hooks, JSON via stdin/stdout, exit code 0/2 convention, `GEMINI.md` context files, `~/.gemini/settings.json`. This is the easiest high-value integration.
- **OpenCode has the richest plugin system**: 20+ hook events across 12 categories, JS/TS plugin modules, custom tool creation, MCP support. 110k stars — largest open-source AI CLI.
- **`npx skills` by Vercel supports 41 agents** — proving the multi-IDE installer UX works. Their agent detection pattern (check if config dir exists) is the right model.
- **All IDEs share a single worker on port 37777**: One worker serves all integrations. Session source (which IDE) is tracked via the `source` field in hook payloads. No per-IDE worker instances.
- **This npx CLI fully replaces the old `claude-mem-installer`**: Not a supplement — the complete replacement.

## Solution

`npx claude-mem` becomes a unified CLI: install, configure any IDE, manage the worker, search memory.

```
npx claude-mem                          # Interactive install + IDE selection
npx claude-mem install                  # Same as above
npx claude-mem install --ide windsurf   # Direct IDE setup
npx claude-mem start / stop / status    # Worker management
npx claude-mem search <query>           # Search memory from terminal
npx claude-mem transcript watch         # Start transcript watcher
```

## Platform Support

**Windows, macOS, and Linux are all first-class targets.** Platform-specific considerations:

- **Config paths**: Use `os.homedir()` and `path.join()` everywhere — never hardcode `/` or `~`
- **Shebangs**: `#!/usr/bin/env node` for the CLI entry point (cross-platform via Node)
- **Bun detection**: Check `PATH`, common install locations per platform (`%USERPROFILE%\.bun\bin\bun.exe` on Windows, `~/.bun/bin/bun` on Unix)
- **File permissions**: `fs.chmod` is a no-op on Windows; don't gate on it
- **Process management**: Worker start/stop uses signals on Unix, taskkill on Windows — match existing `worker-service.ts` patterns
- **VS Code paths**: `~/Library/Application Support/Code/` (macOS), `~/.config/Code/` (Linux), `%APPDATA%/Code/` (Windows)
- **Shell config**: `.bashrc`/`.zshrc` on Unix, PowerShell profile on Windows (for PATH modifications if needed)

---

## Phase 0: Research Findings

### IDE Integration Tiers

**Tier 1 — Native Hook/Plugin Systems** (highest fidelity, real-time capture):

| Tool | Hooks | Config Location | Context Injection | Stars/Users |
|------|-------|----------------|-------------------|-------------|
| Claude Code | 5 lifecycle hooks | `~/.claude/settings.json` | CLAUDE.md, plugins | ~25% market |
| Gemini CLI | 11 lifecycle hooks | `~/.gemini/settings.json` | GEMINI.md | ~95k stars |
| OpenCode | 20+ event hooks + plugin SDK | `~/.config/opencode/opencode.json` | AGENTS.md + rules dirs | ~110k stars |
| Windsurf | 11 Cascade hooks | `.windsurf/hooks.json` | `.windsurf/rules/*.md` | ~1M users |
| Codex CLI | `notify` hook | `~/.codex/config.toml` | `.codex/AGENTS.md`, MCP | Growing (OpenAI) |
| OpenClaw | 8 event hooks + plugin SDK | `~/.openclaw/openclaw.json` | MEMORY.md sync | ~196k stars |

**Tier 2 — MCP Integration** (tool-based, search + context injection):

| Tool | MCP Support | Config Location | Context Injection |
|------|------------|----------------|-------------------|
| Cursor | First-class | `.cursor/mcp.json` | `.cursor/rules/*.mdc` |
| Copilot CLI | First-class (default MCP) | `~/.copilot/config` | `.github/copilot-instructions.md` |
| Antigravity | First-class + MCP Store | `~/.gemini/antigravity/mcp_config.json` | `.agent/rules/`, GEMINI.md |
| Goose | Native MCP (co-developed protocol) | `~/.config/goose/config.yaml` | MCP context |
| Crush | MCP + Skills | JSON config (charm.land schema) | Skills system |
| Roo Code | First-class | `.roo/` | `.roo/rules/*.md`, `AGENTS.md` |
| Warp | MCP + Warp Drive | `WARP.md` + Warp Drive UI | `WARP.md` |

**Tier 3 — Transcript File Watching** (passive, file-based):

| Tool | Transcript Location | Format |
|------|-------------------|--------|
| Claude Code | `~/.claude/projects/<proj>/<session>.jsonl` | JSONL |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | JSONL |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/` | JSON |
| OpenCode | `.opencode/` (SQLite) | SQLite — needs export |

### What claude-mem Already Has

| Component | Status | Location |
|-----------|--------|----------|
| Claude Code plugin | Complete | `plugin/hooks/hooks.json` |
| Cursor hooks installer | Complete | `src/services/integrations/CursorHooksInstaller.ts` |
| Platform adapters | Claude Code + Cursor + raw | `src/cli/adapters/` |
| Transcript watcher | Complete (schema-based JSONL) | `src/services/transcripts/` |
| Codex transcript schema | Sample exists | `src/services/transcripts/config.ts` |
| OpenClaw plugin | Complete (1000+ lines) | `openclaw/src/index.ts` |
| MCP server | Complete | `plugin/scripts/mcp-server.cjs` |
| Gemini CLI support | Not started | — |
| OpenCode support | Not started | — |
| Windsurf support | Not started | — |

### Patterns to Copy

- **Agent detection from `npx skills`** (`vercel-labs/skills/src/agents.ts`): Check if config directory exists
- **Existing installer logic** (`installer/src/steps/install.ts:29-83`): registerMarketplace, registerPlugin, enablePluginInClaudeSettings — **extract shared logic** from existing installer into reusable modules (DRY with the new CLI)
- **Bun resolution** (`plugin/scripts/bun-runner.js`): PATH lookup + common locations per platform
- **CursorHooksInstaller** (`src/services/integrations/CursorHooksInstaller.ts`): Reference implementation for IDE hooks installation

---

## Phase 1: NPX CLI Entry Point

### What to implement

1. **Add `bin` field to `package.json`**:
   ```json
   "bin": {
     "claude-mem": "./dist/cli/index.js"
   }
   ```

2. **Create `src/npx-cli/index.ts`** — a Node.js CLI router (NOT Bun) with command categories:

   **Install commands** (pure Node.js, no Bun required):
   - `npx claude-mem` or `npx claude-mem install` → interactive install (IDE multi-select)
   - `npx claude-mem install --ide <name>` → direct IDE setup (only for implemented IDEs; unimplemented ones error with "Support for <name> coming soon")
   - `npx claude-mem update` → update to latest version
   - `npx claude-mem uninstall` → remove plugin and IDE configs
   - `npx claude-mem version` → print version

   **Runtime commands** (delegate to Bun via installed plugin):
   - `npx claude-mem start` → spawns `bun worker-service.cjs start`
   - `npx claude-mem stop` → spawns `bun worker-service.cjs stop`
   - `npx claude-mem restart` → spawns `bun worker-service.cjs restart`
   - `npx claude-mem status` → spawns `bun worker-service.cjs status`
   - `npx claude-mem search <query>` → hits `GET http://localhost:37777/api/search?q=<query>`
   - `npx claude-mem transcript watch` → starts transcript watcher

   **Runtime commands must check for installation first**: If plugin directory doesn't exist at `~/.claude/plugins/marketplaces/thedotmack/`, print "claude-mem is not installed. Run: npx claude-mem install" and exit.

3. **The install flow** (fully replaces git clone + build):
   - Detect the npm package's own location (`import.meta.url` or `__dirname`)
   - Copy `plugin/` from the npm package to `~/.claude/plugins/marketplaces/thedotmack/`
   - Copy `plugin/` to `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`
   - Register marketplace in `~/.claude/plugins/known_marketplaces.json`
   - Register plugin in `~/.claude/plugins/installed_plugins.json`
   - Enable in `~/.claude/settings.json`
   - Run `npm install` in the marketplace dir (for `@chroma-core/default-embed` — native ONNX binaries, can't be bundled)
   - Trigger smart-install.js for Bun/uv setup
   - Run IDE-specific setup for each selected IDE

4. **Interactive IDE selection** (auto-detect + prompt):
   - Auto-detect installed IDEs by checking config directories
   - Present multi-select with detected IDEs pre-selected
   - Detection map:
     - Claude Code: `~/.claude/` exists
     - Gemini CLI: `~/.gemini/` exists
     - OpenCode: `~/.config/opencode/` exists OR `opencode` in PATH
     - OpenClaw: `~/.openclaw/` exists
     - Windsurf: `~/.codeium/windsurf/` exists
     - Codex CLI: `~/.codex/` exists
     - Cursor: `~/.cursor/` exists
     - Copilot CLI: `copilot` in PATH (it's a CLI tool, not a config dir)
     - Antigravity: `~/.gemini/antigravity/` exists
     - Goose: `~/.config/goose/` exists OR `goose` in PATH
     - Crush: `crush` in PATH
     - Roo Code: check for VS Code extension directory containing `roo-code`
     - Warp: `~/.warp/` exists OR `warp` in PATH

5. **The runtime command routing**:
   - Locate the installed plugin directory
   - Find Bun binary (same logic as `bun-runner.js`, platform-aware)
   - Spawn `bun worker-service.cjs <command>` and pipe stdio through
   - For `search`: HTTP request to running worker

### Patterns to follow

- `installer/src/steps/install.ts:29-83` for marketplace registration — **extract to shared module**
- `plugin/scripts/bun-runner.js` for Bun resolution
- `vercel-labs/skills/src/agents.ts` for IDE auto-detection pattern

### Verification

- `npx claude-mem install` copies plugin to correct directories on macOS, Linux, and Windows
- Auto-detection finds installed IDEs
- `npx claude-mem start/stop/status` work after install
- `npx claude-mem search "test"` returns results
- `npx claude-mem start` before install prints helpful error message
- `npx claude-mem update` and `npx claude-mem uninstall` work correctly
- `npx claude-mem version` prints version

### Anti-patterns

- Do NOT require Bun for install commands — pure Node.js
- Do NOT clone the git repo
- Do NOT build from source at install time
- Do NOT depend on `bun:sqlite` in the CLI entry point

---

## Phase 2: Build Pipeline Integration

### What to implement

1. **Add CLI build step to `scripts/build-hooks.js`**:
   - Compile `src/npx-cli/index.ts` → `dist/cli/index.js`
   - Bundle `@clack/prompts` and `picocolors` into the output (self-contained)
   - Shebang: `#!/usr/bin/env node`
   - Set executable permissions (no-op on Windows, that's fine)

2. **Move `@clack/prompts` and `picocolors`** to main package.json as dev dependencies (bundled by esbuild into dist/cli/index.js)

3. **Verify `package.json` `files` field**: Currently `["dist", "plugin"]`. `dist/cli/index.js` is already included since it's under `dist/`. No change needed.

4. **Update `prepublishOnly`** to ensure CLI is built before npm publish (already covered — `npm run build` calls `build-hooks.js`)

5. **Pre-build OpenClaw plugin**: Add an esbuild step that compiles `openclaw/src/index.ts` → `openclaw/dist/index.js` so it ships ready-to-use. No `tsc` at install time.

6. **Add `openclaw/dist/` to `package.json` `files` field** (or add `openclaw` if the whole directory should ship)

### Verification

- `npm run build` produces `dist/cli/index.js` with correct shebang
- `npm run build` produces `openclaw/dist/index.js` pre-built
- `npm pack` includes both `dist/cli/index.js` and `openclaw/dist/`
- `node dist/cli/index.js --help` works without Bun
- Package size is reasonable (check with `npm pack --dry-run`)

---

## Phase 3: Gemini CLI Integration (Tier 1 — Hook-Based)

**Why first among new IDEs**: Near-identical architecture to Claude Code. 11 lifecycle hooks with JSON stdin/stdout, same exit code conventions (0=success, 2=block), `GEMINI.md` context files. 95k GitHub stars. Lowest effort, highest confidence.

### Gemini CLI Hook Events

| Event | Map to claude-mem | Use |
|-------|-------------------|-----|
| `SessionStart` | `session-init` | Start tracking session |
| `BeforeAgent` | `user-prompt` | Capture user prompt |
| `AfterAgent` | `observation` | Capture full agent response |
| `BeforeTool` | — | Skip (pre-execution, no result yet) |
| `AfterTool` | `observation` | Capture tool name + input + response |
| `BeforeModel` | — | Skip (too low-level, LLM request details) |
| `AfterModel` | — | Skip (raw LLM response, redundant with AfterAgent) |
| `BeforeToolSelection` | — | Skip (internal planning step) |
| `PreCompress` | `summary` | Trigger summary before context compression |
| `Notification` | — | Skip (system alerts, not session data) |
| `SessionEnd` | `session-end` | Finalize session |

**Mapped**: 5 of 11 events. **Skipped**: 6 events that are either too low-level (BeforeModel/AfterModel), pre-execution (BeforeTool, BeforeToolSelection), or system-level (Notification).

### Verified Stdin Payload Schemas (from `packages/core/src/hooks/types.ts`)

**Base input (all hooks receive):**
```typescript
{ session_id: string, transcript_path: string, cwd: string, hook_event_name: string, timestamp: string }
```

**Event-specific fields:**
| Event | Additional Fields |
|-------|-------------------|
| `SessionStart` | `source: "startup" \| "resume" \| "clear"` |
| `SessionEnd` | `reason: "exit" \| "clear" \| "logout" \| "prompt_input_exit" \| "other"` |
| `BeforeAgent` | `prompt: string` |
| `AfterAgent` | `prompt: string, prompt_response: string, stop_hook_active: boolean` |
| `BeforeTool` | `tool_name: string, tool_input: Record<string, unknown>, mcp_context?: McpToolContext, original_request_name?: string` |
| `AfterTool` | `tool_name: string, tool_input: Record<string, unknown>, tool_response: Record<string, unknown>, mcp_context?: McpToolContext` |
| `PreCompress` | `trigger: "auto" \| "manual"` |
| `Notification` | `notification_type: "ToolPermission", message: string, details: Record<string, unknown>` |

**Output (all hooks can return):**
```typescript
{ continue?: boolean, stopReason?: string, suppressOutput?: boolean, systemMessage?: string, decision?: "allow" | "deny" | "block" | "approve" | "ask", reason?: string, hookSpecificOutput?: Record<string, unknown> }
```

**Advisory (non-blocking) hooks:** SessionStart, SessionEnd, PreCompress, Notification — `continue` and `decision` fields are ignored.

**Environment variables provided:** `GEMINI_PROJECT_DIR`, `GEMINI_SESSION_ID`, `GEMINI_CWD`, `CLAUDE_PROJECT_DIR` (compat alias)

### What to implement

1. **Create Gemini CLI platform adapter** at `src/cli/adapters/gemini-cli.ts`:
   - Normalize Gemini CLI's hook JSON to `NormalizedHookInput`
   - Base fields always present: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`
   - Map per event:
     - `SessionStart`: `source` → session init metadata
     - `BeforeAgent`: `prompt` → user prompt text
     - `AfterAgent`: `prompt` + `prompt_response` → full conversation turn
     - `AfterTool`: `tool_name` + `tool_input` + `tool_response` → observation
     - `PreCompress`: `trigger` → summary trigger
     - `SessionEnd`: `reason` → session finalization

2. **Create Gemini CLI hooks installer** at `src/services/integrations/GeminiCliHooksInstaller.ts`:
   - Write hooks to `~/.gemini/settings.json` under the `hooks` key
   - Must **merge** with existing settings (read → parse → deep merge → write)
   - Hook config format (verified against official docs):
     ```json
     {
       "hooks": {
         "AfterTool": [{
           "matcher": "*",
           "hooks": [{ "name": "claude-mem", "type": "command", "command": "<path-to-hook-script>", "timeout": 5000 }]
         }]
       }
     }
     ```
   - Note: `matcher` uses regex for tool events, exact string for lifecycle events. `"*"` or `""` matches all.
   - Hook groups support `sequential: boolean` (default false = parallel execution)
   - Security: Project-level hooks are fingerprinted — if name/command changes, user is warned
   - Context injection via `~/.gemini/GEMINI.md` (append claude-mem section with `<claude-mem-context>` tags, same pattern as CLAUDE.md)
   - Settings hierarchy: project `.gemini/settings.json` > user `~/.gemini/settings.json` > system `/etc/gemini-cli/settings.json`

3. **Register `gemini-cli` in `getPlatformAdapter()`** at `src/cli/adapters/index.ts`

4. **Add Gemini CLI to installer IDE selection**

### Verification

- `npx claude-mem install --ide gemini-cli` merges hooks into `~/.gemini/settings.json`
- Gemini CLI sessions are captured by the worker
- `AfterTool` events produce observations with correct `tool_name`, `tool_input`, `tool_response`
- `GEMINI.md` gets claude-mem context section
- Existing Gemini CLI settings are preserved (merge, not overwrite)
- Verify `session_id` from base input is used for session tracking

### Anti-patterns

- Do NOT overwrite `~/.gemini/settings.json` — must deep merge
- Do NOT map all 11 events — the 6 skipped events would produce noise, not signal
- Do NOT use `type: "runtime"` — that's for internal extensions only; use `type: "command"`
- Advisory hooks (SessionStart, SessionEnd, PreCompress, Notification) cannot block — don't set `decision` or `continue` fields on them

---

## Phase 4: OpenCode Integration (Tier 1 — Plugin-Based)

**Why next**: 110k stars, richest plugin ecosystem. OpenCode plugins are JS/TS modules auto-loaded from plugin directories. OpenCode also has a Claude Code compatibility fallback (reads `~/.claude/CLAUDE.md` if no global `AGENTS.md` exists, controllable via `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`).

### Verified Plugin API (from `packages/plugin/src/index.ts`)

**Plugin signature:**
```typescript
import { type Plugin, tool } from "@opencode-ai/plugin"

export const ClaudeMemPlugin: Plugin = async (ctx) => {
  // ctx: { client, project, directory, worktree, serverUrl, $ }
  return { /* hooks object */ }
}
```

**PluginInput type (6 properties, not 4):**
```typescript
type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>  // OpenCode SDK client
  project: Project                                   // Current project info
  directory: string                                  // Current working directory
  worktree: string                                   // Git worktree path
  serverUrl: URL                                     // Server URL
  $: BunShell                                        // Bun shell API
}
```

**Two hook mechanisms (important distinction):**

1. **Direct interceptor hooks** — keys on the returned `Hooks` object, receive `(input, output)` allowing mutation:
   - `tool.execute.before`: `(input: { tool, sessionID, callID }, output: { args })`
   - `tool.execute.after`: `(input: { tool, sessionID, callID, args }, output: { title, output, metadata })`
   - `shell.env`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`
   - Experimental: `experimental.session.compacting`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`

2. **Bus event catch-all** — generic `event` hook, receives `{ event }` where `event.type` is the event name:
   - `session.created`, `session.compacted`, `session.deleted`, `session.idle`, `session.error`, `session.status`, `session.updated`, `session.diff`
   - `message.updated`, `message.part.updated`, `message.part.removed`, `message.removed`
   - `file.edited`, `file.watcher.updated`
   - `command.executed`, `todo.updated`, `installation.updated`, `server.connected`
   - `permission.asked`, `permission.replied`
   - `lsp.client.diagnostics`, `lsp.updated`
   - `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`
   - Total: **27 bus events** across **12 categories**

**Custom tool registration (CORRECTED — name is the key, not positional arg):**
```typescript
return {
  tool: {
    claude_mem_search: tool({
      description: "Search claude-mem memory database",
      args: { query: tool.schema.string() },
      async execute(args, context) {
        // context: { sessionID, messageID, agent, directory, worktree, abort, metadata, ask }
        const response = await fetch(`http://localhost:37777/api/search?q=${encodeURIComponent(args.query)}`)
        return await response.text()
      },
    }),
  },
}
```

### What to implement

1. **Create OpenCode plugin** at `src/integrations/opencode-plugin/index.ts`:
   - Export a `Plugin` function receiving full `PluginInput` context
   - Use **direct interceptor** `tool.execute.after` for tool observation capture (gives `tool`, `args`, `output`)
   - Use **bus event catch-all** `event` for session lifecycle:

   | Mechanism | Event | Map to claude-mem |
   |-----------|-------|-------------------|
   | interceptor | `tool.execute.after` | `observation` (tool name + args + output) |
   | bus event | `session.created` | `session-init` |
   | bus event | `message.updated` | `observation` (assistant messages) |
   | bus event | `session.compacted` | `summary` |
   | bus event | `file.edited` | `observation` (file changes) |
   | bus event | `session.deleted` | `session-end` |

   - Register `claude_mem_search` custom tool using correct `tool({ description, args, execute })` API
   - Hit `localhost:37777` API endpoints from the plugin

2. **Build the plugin** in the esbuild pipeline → `dist/opencode-plugin/index.js`

3. **Create OpenCode setup in installer** (two options, prefer file-based):
   - **Option A (file-based):** Copy plugin to `~/.config/opencode/plugins/claude-mem.ts` (auto-loaded at startup)
   - **Option B (npm-based):** Add to `~/.config/opencode/opencode.json` under `"plugin"` array: `["claude-mem"]`
   - Config also supports JSONC (`opencode.jsonc`) and legacy `config.json`
   - Context injection: Append to `~/.config/opencode/AGENTS.md` (or create it) with `<claude-mem-context>` tags
   - Additional context via `"instructions"` config key (supports file paths, globs, remote URLs)

4. **Add OpenCode to installer IDE selection**

### OpenCode Verification

- `npx claude-mem install --ide opencode` registers the plugin (file or npm)
- OpenCode loads the plugin on next session
- `tool.execute.after` interceptor produces observations with `tool`, `args`, `output`
- Bus events (`session.created`, `session.deleted`) handle session lifecycle
- `claude_mem_search` custom tool works in OpenCode sessions
- Context is injected via AGENTS.md

### OpenCode Anti-patterns

- Do NOT try to use OpenCode's `session.diff` for full capture — it's a summary diff, not raw data
- Do NOT use `tool('name', schema, handler)` — wrong signature. Name is the key in the `tool:{}` map
- Do NOT assume bus events have the same `(input, output)` mutation pattern — they only receive `{ event }`
- OpenCode plugins run in Bun — the plugin CAN use Bun APIs (unlike the npx CLI itself)
- Do NOT hardcode `~/.config/opencode/` — respect `OPENCODE_CONFIG_DIR` env var if set

---

## Phase 5: Windsurf Integration (Tier 1 — Hook-Based)

**Why next**: 11 Cascade hooks, ~1M users. Hook architecture uses JSON stdin with a consistent envelope format.

### Verified Windsurf Hook Events (from docs.windsurf.com/windsurf/cascade/hooks)

**Naming pattern**: `pre_`/`post_` prefix + 5 action categories, plus 2 standalone post-only events.

| Event | Can Block? | Map to claude-mem | Use |
|-------|-----------|-------------------|-----|
| `pre_user_prompt` | Yes | `session-init` + `context` | Start session, inject context |
| `pre_read_code` | Yes | — | Skip (pre-execution, can block file reads) |
| `post_read_code` | No | — | Skip (too noisy, file reads are frequent) |
| `pre_write_code` | Yes | — | Skip (pre-execution, can block writes) |
| `post_write_code` | No | `observation` | Code generation |
| `pre_run_command` | Yes | — | Skip (pre-execution, can block commands) |
| `post_run_command` | No | `observation` | Shell command execution |
| `pre_mcp_tool_use` | Yes | — | Skip (pre-execution, can block MCP calls) |
| `post_mcp_tool_use` | No | `observation` | MCP tool results |
| `post_cascade_response` | No | `observation` | Full AI response |
| `post_setup_worktree` | No | — | Skip (informational) |

**Mapped**: 5 of 11 events (all post-action). **Skipped**: 4 pre-hooks (blocking-capable, pre-execution) + 2 low-value post-hooks.

### Verified Stdin Payload Schema

**Common envelope (all hooks):**
```json
{
  "agent_action_name": "string",
  "trajectory_id": "string",
  "execution_id": "string",
  "timestamp": "ISO 8601 string",
  "tool_info": { /* event-specific payload */ }
}
```

**Event-specific `tool_info` payloads:**

| Event | `tool_info` fields |
|-------|-------------------|
| `pre_user_prompt` | `{ user_prompt: string }` |
| `pre_read_code` / `post_read_code` | `{ file_path: string }` |
| `pre_write_code` / `post_write_code` | `{ file_path: string, edits: [{ old_string: string, new_string: string }] }` |
| `pre_run_command` / `post_run_command` | `{ command_line: string, cwd: string }` |
| `pre_mcp_tool_use` | `{ mcp_server_name: string, mcp_tool_name: string, mcp_tool_arguments: {} }` |
| `post_mcp_tool_use` | `{ mcp_server_name: string, mcp_tool_name: string, mcp_tool_arguments: {}, mcp_result: string }` |
| `post_cascade_response` | `{ response: string }` (markdown) |
| `post_setup_worktree` | `{ worktree_path: string, root_workspace_path: string }` |

**Exit codes:** `0` = success, `2` = block (pre-hooks only; stderr shown to agent), any other = non-blocking warning.

### What to implement

1. **Create Windsurf platform adapter** at `src/cli/adapters/windsurf.ts`:
   - Normalize Windsurf's hook input format to `NormalizedHookInput`
   - Common envelope: `agent_action_name`, `trajectory_id`, `execution_id`, `timestamp`, `tool_info`
   - Map: `trajectory_id` → `sessionId`, `tool_info` fields per event type
   - For `post_write_code`: `tool_info.file_path` + `tool_info.edits` → file change observation
   - For `post_run_command`: `tool_info.command_line` + `tool_info.cwd` → command observation
   - For `post_mcp_tool_use`: `tool_info.mcp_tool_name` + `tool_info.mcp_tool_arguments` + `tool_info.mcp_result` → tool observation
   - For `post_cascade_response`: `tool_info.response` → full AI response observation

2. **Create Windsurf hooks installer** at `src/services/integrations/WindsurfHooksInstaller.ts`:
   - Write hooks to `~/.codeium/windsurf/hooks.json` (user-level, for global coverage)
   - Per-workspace override at `.windsurf/hooks.json` if user chooses workspace-level install
   - Config format (verified):
     ```json
     {
       "hooks": {
         "post_write_code": [{
           "command": "<path-to-hook-script>",
           "show_output": false,
           "working_directory": "<optional>"
         }]
       }
     }
     ```
   - Note: Tilde expansion (`~`) is NOT supported in `working_directory` — use absolute paths
   - Merge order: cloud → system → user → workspace (all hooks at all levels execute)
   - Context injection via `.windsurf/rules/claude-mem-context.md` (workspace-level; Windsurf rules are workspace-scoped)
   - Rule limits: 6,000 chars per file, 12,000 chars total across all rules

3. **Register `windsurf` in `getPlatformAdapter()`** at `src/cli/adapters/index.ts`

4. **Add Windsurf to installer IDE selection**

### Windsurf Verification

- `npx claude-mem install --ide windsurf` creates hooks config at `~/.codeium/windsurf/hooks.json`
- Windsurf sessions are captured by the worker via post-action hooks
- `trajectory_id` is used as session identifier
- Context is injected via `.windsurf/rules/claude-mem-context.md` (under 6K char limit)
- Existing hooks.json is preserved (merge, not overwrite)

### Windsurf Anti-patterns

- Do NOT use fabricated event names (`post_search_code`, `post_lint_code`, `on_error`, `pre_tool_execution`) — they don't exist
- Do NOT assume Windsurf's stdin JSON matches Claude Code's — it uses `tool_info` envelope, not flat fields
- Do NOT use tilde (`~`) in `working_directory` — not supported, use absolute paths
- Do NOT exceed 6K chars in the context rule file — Windsurf truncates beyond that
- Pre-hooks can block actions (exit 2) — only use post-hooks for observation capture

---

## Phase 6: Codex CLI Integration (Tier 1 — Hook + Transcript)

### Dedup strategy

Codex has both a `notify` hook (real-time) and transcript files (complete history). Use **transcript watching only** — it's more complete and avoids the complexity of dual capture paths. The `notify` hook is a simpler mechanism that doesn't provide enough granularity to justify maintaining two integration paths. If transcript watching proves insufficient, add the notify hook later.

### What to implement

1. **Create Codex transcript schema** — the sample in `src/services/transcripts/config.ts` is already production-quality. Verify against current Codex CLI JSONL format and update if needed.

2. **Create Codex setup in installer**:
   - Write transcript-watch config to `~/.claude-mem/transcript-watch.json`
   - Set up watch for `~/.codex/sessions/**/*.jsonl` using existing CODEX_SAMPLE_SCHEMA
   - Context injection via `.codex/AGENTS.md` (Codex reads this natively)
   - Must merge with existing `config.toml` if it exists (read → parse → merge → write)

3. **Add Codex CLI to installer IDE selection**

### Verification

- `npx claude-mem install --ide codex` creates transcript watch config
- Codex sessions appear in claude-mem database
- `AGENTS.md` updated with context after sessions
- Existing `config.toml` is preserved

---

## Phase 7: OpenClaw Integration (Tier 1 — Plugin-Based)

**Plugin is already fully built** at `openclaw/src/index.ts` (~1000 lines). Has event hooks, SSE observation feed, MEMORY.md sync, slash commands. Only wiring into the installer is needed.

### What to implement

1. **Wire OpenClaw into the npx installer**:
   - Detect `~/.openclaw/` directory
   - Copy pre-built plugin from `openclaw/dist/` (built in Phase 2) to OpenClaw plugins location
   - Register in `~/.openclaw/openclaw.json` under `plugins.claude-mem`
   - Configure worker port, project name, syncMemoryFile
   - Optionally prompt for observation feed setup (channel type + target ID)

2. **Add OpenClaw to IDE selection TUI** with hint about messaging channel support

### Verification

- `npx claude-mem install --ide openclaw` registers the plugin
- OpenClaw gateway loads the plugin on restart
- Observations are recorded from OpenClaw sessions
- MEMORY.md syncs to agent workspaces

### Anti-patterns

- Do NOT rebuild the OpenClaw plugin from source at install time — it ships pre-built from Phase 2
- Do NOT modify the plugin's event handling — it's battle-tested

---

## Phase 8: MCP-Based Integrations (Tier 2)

**These get the MCP server for free** — it already exists at `plugin/scripts/mcp-server.cjs`. The installer just needs to write the right config files per IDE.

MCP-only integrations provide: search tools + context injection. They do NOT capture transcripts or tool usage in real-time.

### What to implement

1. **Copilot CLI MCP setup**:
   - Write MCP config to `~/.copilot/config` (merge, not overwrite)
   - Context injection: `.github/copilot-instructions.md`
   - Detection: `copilot` command in PATH

2. **Antigravity MCP setup**:
   - Write MCP config to `~/.gemini/antigravity/mcp_config.json` (merge, not overwrite)
   - Context injection: `~/.gemini/GEMINI.md` (shared with Gemini CLI) and/or `.agent/rules/claude-mem-context.md`
   - Detection: `~/.gemini/antigravity/` exists
   - Note: Antigravity has NO hook system — MCP is the only integration path

3. **Goose MCP setup**:
   - Write MCP config to `~/.config/goose/config.yaml` (YAML merge — use a lightweight YAML parser or write the block manually if config doesn't exist)
   - Detection: `~/.config/goose/` exists OR `goose` in PATH
   - Note: Goose co-developed MCP with Anthropic, so MCP support is excellent

4. **Crush MCP setup**:
   - Write MCP config to Crush's JSON config
   - Detection: `crush` in PATH

5. **Roo Code MCP setup**:
   - Write MCP config to `.roo/` or workspace settings
   - Context injection: `.roo/rules/claude-mem-context.md`
   - Detection: Check for VS Code extension directory containing `roo-code`

6. **Warp MCP setup**:
   - Warp uses `WARP.md` in project root for context injection (similar to CLAUDE.md)
   - MCP servers configured via Warp Drive UI, but also via config files
   - Detection: `~/.warp/` exists OR `warp` in PATH
   - Note: Warp is a terminal replacement (~26k stars), not just a CLI tool — multi-agent orchestration with management UI

7. **For each**: Add to installer IDE detection and selection

### Config merging strategy

JSON configs: Read → parse → deep merge → write back. YAML configs (Goose): If file exists, read and append the MCP block. If not, create from template. Avoid pulling in a full YAML parser library — write the MCP block as a string append with proper indentation if the format is predictable.

### Verification

- Each IDE can search claude-mem via MCP tools
- Context files are written to IDE-specific locations
- Existing configs are preserved

### Anti-patterns

- MCP-only integrations do NOT capture transcripts — don't claim "full integration"
- Do NOT overwrite existing config files — always merge
- Do NOT add a heavy YAML parser dependency for one integration

---

## Phase 9: Remove Old Installer

This is a **full replacement**, not a deprecation.

### What to implement

1. Remove `claude-mem-installer` npm package (unpublish or mark deprecated with message pointing to `npx claude-mem`)
2. Update `install/public/install.sh` → redirect to `npx claude-mem`
3. Remove `installer/` directory from the repository (it's replaced by `src/npx-cli/`)
4. Update docs site to reflect the new install command
5. Update README.md install instructions

---

## Phase 10: Final Verification

### All platforms (macOS, Linux, Windows)

1. `npm run build` succeeds, produces `dist/cli/index.js` and `openclaw/dist/index.js`
2. `node dist/cli/index.js install` works clean (no prior install)
3. Auto-detects installed IDEs correctly per platform
4. `npx claude-mem start/stop/status/search` all work
5. `npx claude-mem update` updates correctly
6. `npx claude-mem uninstall` cleans up all IDE configs
7. `npx claude-mem version` prints version
8. `npx claude-mem start` before install shows helpful error
9. No Bun dependency at install time

### Per-integration verification

| Integration | Type | Captures Sessions | Search via MCP | Context Injection |
|-------------|------|-------------------|----------------|-------------------|
| Claude Code | Plugin | Yes (hooks) | Yes | CLAUDE.md |
| Gemini CLI | Hooks | Yes (AfterTool, AfterAgent) | Yes (via hook) | GEMINI.md |
| OpenCode | Plugin | Yes (tool.execute.after, message.updated) | Yes (custom tool) | AGENTS.md / rules |
| Windsurf | Hooks | Yes (post_cascade_response, etc.) | Yes (via hook) | .windsurf/rules/ |
| Codex CLI | Transcript | Yes (JSONL watcher) | No (passive only) | .codex/AGENTS.md |
| OpenClaw | Plugin | Yes (event hooks) | Yes (slash commands) | MEMORY.md |
| Copilot CLI | MCP | No | Yes | copilot-instructions.md |
| Antigravity | MCP | No | Yes | .agent/rules/ |
| Goose | MCP | No | Yes | MCP context |
| Crush | MCP | No | Yes | Skills |
| Roo Code | MCP | No | Yes | .roo/rules/ |
| Warp | MCP | No | Yes | WARP.md |

---

## Priority Order & Impact

| Phase | IDE/Tool | Integration Type | Stars/Users | Effort |
|-------|----------|-----------------|-------------|--------|
| 1-2 | (infrastructure) | npx CLI + build pipeline | All users | Medium |
| 3 | Gemini CLI | Hooks (Tier 1) | ~95k stars | Medium (near-identical to Claude Code) |
| 4 | OpenCode | Plugin (Tier 1) | ~110k stars | Medium (rich plugin SDK) |
| 5 | Windsurf | Hooks (Tier 1) | ~1M users | Medium |
| 6 | Codex CLI | Transcript (Tier 3) | Growing (OpenAI) | Low (schema already exists) |
| 7 | OpenClaw | Plugin (Tier 1) — pre-built | ~196k stars | Low (wire into installer) |
| 8 | Copilot CLI, Antigravity, Goose, Crush, Warp, Roo Code | MCP (Tier 2) | 20M+ combined | Low per IDE |
| 9 | (remove old installer) | — | — | Low |
| 10 | (final verification) | — | — | Low |

## Out of Scope

- **Removing Bun as runtime dependency**: Worker still requires Bun for `bun:sqlite`. Runtime commands delegate to Bun; install commands don't need it.
- **JetBrains plugin**: Requires Kotlin/Java development — different ecosystem entirely.
- **Zed extension**: WASM sandbox limits feasibility.
- **Neovim/Emacs plugins**: Niche audiences, complex plugin ecosystems (Lua/Elisp). Could be added later via MCP (gptel supports it).
- **Amazon Q / Kiro**: Amazon Q Developer CLI has been sunsetted in favor of Kiro (proprietary, no public extensibility API yet). Revisit when Kiro opens up.
- **Aider**: Niche audience, writes Markdown transcripts (not JSONL), would require a markdown parser mode in the watcher. Add if demand materializes.
- **Continue.dev**: Small user base relative to other MCP tools. Can be added as a Tier 2 MCP integration later if requested.
- **Toad / Qwen Code / Oh-my-pi**: Too early-stage or too niche. Monitor for growth.
- **OpenClaw plugin development**: The plugin is already complete. Only installer wiring is in scope.
