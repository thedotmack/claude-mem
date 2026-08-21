# Kimi Code CLI Harness Integration — Design

Date: 2026-08-20
Status: Approved (user review pending)
Target: first-class `kimi` harness in claude-mem, submitted as upstream PR to thedotmack/claude-mem

## 1. Purpose

claude-mem supports multiple agent harnesses (Claude Code, Codex, Cursor,
Windsurf, OpenCode, OpenClaw, Antigravity, MCP-only IDEs). Kimi Code CLI is a
terminal harness with a Claude-Code-like hook system and config directory at
`~/.kimi-code/`. This design adds Kimi as a first-class harness following the
Codex/Cursor config-merge installer pattern (Approach A), with full hook parity
with the Claude Code integration.

## 2. Architecture

### New files

- `src/cli/adapters/kimi.ts` — platform adapter. Normalizes Kimi hook stdin
  JSON into `NormalizedHookInput`. Kimi payloads are snake_case and near-Claude
  shaped: `session_id`, `cwd`, `prompt`, `tool_name`, `tool_input`,
  `tool_response`, plus base fields `hook_event_name`, `session_title`,
  `client_type`. `transcriptPath` is derived (Kimi does not send it) by
  globbing `~/.kimi-code/sessions/*/<session_id>/agents/main/wire.jsonl`.
- `src/services/integrations/KimiHooksInstaller.ts` — install / uninstall /
  status. Merges hook rules into `~/.kimi-code/config.toml` and the MCP server
  into `~/.kimi-code/mcp.json`.
- `tests/cli/adapters/kimi.test.ts` — adapter unit tests.
- `tests/integration/kimi-hooks-installer.test.ts` — installer tests against
  temp-HOME fixtures.
- `docs/public/kimi-integration.mdx` — user-facing doc, mirroring
  `openclaw-integration.mdx`.

### Modified files

- `src/cli/adapters/index.ts` — add `kimi` to the adapter switch.
- `src/shared/platform-source.ts` — map/normalize the `'kimi'` platform source.
- `src/services/worker-service.ts` — `case 'kimi'` CLI dispatch, enabling
  `claude-mem kimi install|status|uninstall`.
- `src/npx-cli/commands/install.ts` — `case 'kimi'` in `makeIDETask`.
- `src/npx-cli/commands/ide-detection.ts` — detect Kimi via the
  `~/.kimi-code/` directory or `kimi` on PATH.
- `src/npx-cli/index.ts` — help text lists `kimi`.
- `docs/public/platform-integration.mdx` — add Kimi to the harness table.
- `CHANGELOG.md` — changelog entry.
- `src/shared/transcript-parser.ts` — ONLY IF the wire.jsonl probe (section 6)
  shows role/content fields differing from `{type|role}`.

## 3. Event mapping (full parity with Claude Code)

| Kimi hook event | matcher | claude-mem internal event | Notes |
| --- | --- | --- | --- |
| `SessionStart` | `startup\|resume` | worker start | warms up the worker only |
| `UserPromptSubmit` | (all) | `session-init-context` | composite hook; blockable event; we always exit 0; stdout is appended to Kimi context |
| `PostToolUse` | (all) | `observation` | success-only; `PostToolUseFailure` unused in v1 |
| `PreToolUse` | `Read` | `file-context` | mirrors Claude's matcher |
| `Stop` | (all) | `summarize` | |
| `PreCompact` | `manual\|auto` | `summarize` | |

Unused in v1 (Claude integration likewise ignores them): `SessionEnd`,
`SessionHeartbeat`, `SubagentStart/Stop`, `TurnStarted`, `Notification`,
`PermissionRequest/Result`, `Interrupt`, `PostCompact`, `UserPromptQueued`.

Kimi hook semantics respected: exit 0 = allow (stdout may append to context);
non-zero/timeout/crash fails open. All claude-mem hooks exit 0 on any internal
error. Timeouts stay within Kimi's 1–600s range.

> Correction from live verification with Kimi Code CLI v0.38.0: Kimi does not
> append `SessionStart` hook stdout to the model's context, but it does append
> `UserPromptSubmit` hook stdout. Therefore context injection was moved from
> `SessionStart` to `UserPromptSubmit` via a single composite `session-init-context`
> event, because shell-chaining `session-init && context` consumes stdin in the
> first command and leaves the second with EOF.

## 4. Hook command delivery

Hook commands embed the install-time-resolved absolute path to
`worker-service.cjs` (Cursor precedent), not the version-agnostic plugin-cache
launcher:

```
bun "/abs/path/to/worker-service.cjs" hook kimi <event>
```

with the `node` fallback resolved via `buildSpawnSyncInvocation`. Idempotent
and immune to plugin-cache version drift.

## 5. Config merge mechanics

### `~/.kimi-code/config.toml`

Text-level merge (CodexCliInstaller precedent — no TOML library). Hook rules
are written as one marker-delimited managed block:

```toml
# >>> claude-mem kimi hooks (managed; do not edit) >>>
[[hooks]]
event = "SessionStart"
matcher = "startup|resume"
command = "..."
timeout = 60
# ... remaining rules ...
# <<< claude-mem kimi hooks <<<
```

- install: insert the block, or replace it if already present (upgrade-safe)
- status: report marker presence and rule count
- uninstall: remove exactly the marked block
- a timestamped `config.toml.bak-<date>` backup is written before the first
  modification
- `KIMI_CODE_HOME` is honored when set; default root is `~/.kimi-code`

### `~/.kimi-code/mcp.json`

JSON parse → add the canonical claude-mem MCP server entry (same server name
and stdio launcher as `plugin/.mcp.json`) under `mcpServers` if absent; never
clobber existing keys; preserve existing formatting via `JSON.stringify(_, null, 2)`.

### Deliberate exclusions

- No writes to the user's `AGENTS.md` or `~/.agents/` — memory context reaches
  the session through the UserPromptSubmit hook's stdout injection only.
- No plugin-bundle packaging (`~/.kimi-code/plugins/`) — config-merge only.
- No writes to `~/.claude-mem/settings.json` — observation compression is a
  property of the already-running worker, not of the harness. On the author's
  machine the worker is configured for a local Ollama backend
  (`CLAUDE_MEM_PROVIDER=openrouter` → `http://localhost:11434/v1`,
  model `claude-mem-gemma`); Kimi-captured observations flow through that
  pipeline unchanged, and the installer must leave it untouched.

### Kimi tool-name note

`CLAUDE_MEM_SKIP_TOOLS` defaults list Claude tool names (`TodoWrite`,
`BashOutput`, ...). Kimi's equivalents have different names (`TodoList`,
`TaskList`, `TaskOutput`, `TaskStop`, `CronCreate`, `CronList`, `CronDelete`,
`ReadMediaFile`, ...). Implementation-time decision: extend the default skip
list with the Kimi names so chatter tools are not recorded as observations.
The adapter itself passes `tool_name` through unmodified.

## 6. Transcript support

Early implementation task: probe the real `wire.jsonl` shape from a live
`~/.kimi-code/sessions/.../agents/main/wire.jsonl`. If role/content are
addressable via `line.type ?? line.role` + `message.content`,
`transcript-parser.ts` stays untouched. Otherwise add a Kimi branch with a
fixture-based test. `summarize` must degrade gracefully when
`last_assistant_message` cannot be extracted.

## 7. Error handling

- Hooks: fail-open everywhere (exit 0), matching Kimi semantics.
- Installer: atomic writes (tmp file → rename), backup before first mutation,
  clear `install|status|uninstall` reporting, no partial merges.
- Adapter: malformed stdin JSON → normalize to a minimal `NormalizedHookInput`
  and let the handler decide; never throw on missing fields.

## 8. Testing

TDD. Mirror existing coverage:

- `tests/cli/adapters/kimi.test.ts` — payload normalization per event,
  `transcriptPath` derivation (temp HOME with a fake sessions tree).
- `tests/integration/kimi-hooks-installer.test.ts` — install/status/uninstall
  idempotency against a temp HOME; backup creation; mcp.json merge with
  pre-existing unrelated servers; `KIMI_CODE_HOME` override.
- wire.jsonl fixture only if the parser is extended.

Run: `bun test` (full suite must stay green).

## 9. PR packaging

- Branch `feat/kimi-harness` off `origin/main` (v13.15.3) in worktree
  `~/projects/claude-mem-worktrees/kimi-plugin`.
- Conventional commits (`feat(kimi): ...`).
- Docs: `docs/public/kimi-integration.mdx` + row in
  `platform-integration.mdx` + CHANGELOG entry.
- Verification before PR: install into a scratch `KIMI_CODE_HOME`, run a real
  Kimi session, confirm observations land in the worker DB
  (`/api/sessions/init`, `/api/sessions/observations`, `/api/sessions/summarize`)
  and SessionStart context injection renders. On the author's machine,
  compression must run through the existing local Ollama pipeline
  (`claude-mem-gemma`); the verification asserts no change to
  `~/.claude-mem/settings.json`.
- PR opened from the user's fork (percy-raskova/claude-mem); maintainer
  (Alex) pinged on Discord after local verification.

## 10. Out of scope

- Capturing subagent transcripts (`agents/agent-N/wire.jsonl`)
- `PostToolUseFailure` observations
- Kimi plugin-marketplace distribution
- Changes to the user's personal `~/.kimi-code` hooks (the existing
  memory-distiller hooks are independent and untouched)
