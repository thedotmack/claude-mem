# claude-mem ↔ Pi integration

[Pi](https://github.com/badlogic/pi-mono) is a coding agent with a TypeScript extension system. This directory ships the integration contract a Pi extension needs to honor in order to feed observations into claude-mem.

## Status

| Component | State |
|:--|:--|
| `src/cli/adapters/pi.ts` (worker-side adapter) | **landed in this PR** |
| `pi` / `pi-mono` slug in `getPlatformAdapter()` | **landed in this PR** |
| `pi-mono` → `pi` in `normalizePlatformSource()` | **landed in this PR** |
| Reference Pi extension package | **separate repo** — `victor-software-house/pi-claude-mem` (planned) |
| Hooks installer (`pi install --extension claude-mem`) | not in scope for this PR |
| Pi session JSONL tailer (transcript watcher) | follow-up |

The Pi-side extension lives outside this repo because Pi extensions are TypeScript packages registered via `pi.registerHook(...)`, not JSON configs sourced from `~/.<agent>/hooks.json` like Claude Code or Codex. The integration boundary is the worker's stdin contract; ownership splits along that boundary.

## Architecture

```
┌────────────────────────────────────────┐
│  Pi runtime (badlogic/pi-mono)         │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  pi-claude-mem extension (TS)    │  │
│  │                                  │  │
│  │  pi.registerHook(                │  │
│  │    'session_start' | 'tool_call' │  │
│  │  | 'tool_result' | 'agent_end',  │  │
│  │    fn) → spawn worker subprocess │  │
│  └──────────────────────────────────┘  │
└─────────────┬──────────────────────────┘
              │ stdin = NormalizedHookInput (JSON)
              ▼
┌────────────────────────────────────────┐
│  claude-mem worker                     │
│                                        │
│  bun-runner.js → worker-service.cjs    │
│    hook pi <command>                   │
│                                        │
│  getPlatformAdapter('pi')              │
│    → piAdapter.normalizeInput(stdin)   │
│    → handler.execute(NormalizedHookIn) │
│    → piAdapter.formatOutput(result)    │
│                                        │
│  stdout = HookResult (JSON)            │
└────────────────────────────────────────┘
```

## Pi hook → claude-mem command mapping

| Pi hook event | claude-mem command | Purpose |
|:--|:--|:--|
| `session_start` | `context` | inject prior-session context + recent observations into the new Pi session prompt |
| `before_agent_start` | `session-init` | bump session bookkeeping per user prompt |
| `tool_call` (file-read tools: `read`, `ssh_read`) | `file-context` | inject "this file has prior observations" notice |
| `tool_result` (every tool) | `observation` | capture compressed observation |
| `agent_end` | `summarize` | write `session_summaries` row |
| `session_before_compact` | (optional) `summarize` | preserve summary before Pi's grounded-compaction runs |

## Worker invocation

The Pi extension must spawn the worker subprocess like the other adapters do:

```ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const pluginRoot = process.env.CLAUDE_MEM_PLUGIN_ROOT
  ?? join(process.env.HOME!, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '<version>', 'plugin');

function callWorker(command: 'context' | 'session-init' | 'file-context' | 'observation' | 'summarize', payload: object) {
  const proc = spawn('node', [
    join(pluginRoot, 'scripts', 'bun-runner.js'),
    join(pluginRoot, 'scripts', 'worker-service.cjs'),
    'hook',
    'pi',
    command,
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  let stdout = '';
  proc.stdout.on('data', (chunk) => (stdout += chunk));
  return new Promise<unknown>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) return reject(new Error(`worker exit ${code}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch (err) { reject(err); }
    });
  });
}
```

## NormalizedHookInput payload shape

The Pi extension is the source of truth for translating Pi's native event payload into `NormalizedHookInput`. The adapter accepts both camelCase and snake_case keys, but the canonical shape is:

```ts
interface NormalizedHookInput {
  sessionId: string;        // Pi session uuid
  cwd: string;              // Pi process cwd at hook time
  toolName?: string;        // e.g. 'read', 'bash', 'write', 'edit', 'fast_apply'
  toolInput?: unknown;      // raw Pi tool args
  toolResponse?: unknown;   // raw Pi tool result
  filePath?: string;        // for Read/Edit/Write — populate so file-context can match
  prompt?: string;          // user message that triggered the turn
  transcriptPath?: string;  // ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl
  agentId?: string;         // populated for Pi subagent runs (cmux pane uuid, etc.)
  agentType?: string;       // defaults to 'pi'
  metadata?: Record<string, unknown>;  // model, exit_reason, compaction info
}
```

## HookResult interpretation

The Pi extension consumes `HookResult` and decides what to do with `additionalContext`:

```ts
interface HookResult {
  continue?: boolean;             // always true under Pi; honor it
  hookSpecificOutput?: {
    hookEventName: 'SessionStart' | 'PreToolUse' | 'PostToolUse';
    additionalContext: string;    // ← prepend to next user-facing prompt
  };
  systemMessage?: string;         // ← surface to operator via ctx.ui.setStatus
  suppressOutput?: boolean;
}
```

For `session_start`, the extension should inject `hookSpecificOutput.additionalContext` into the Pi system prompt for the new session. For `tool_call` on file reads, the same field gets prepended to the read tool's result so the model sees "this file has prior observations" before processing the contents.

## Why no installer in this PR

The other named adapters (Cursor, Codex, Crush, Gemini CLI) ship a hooks installer because their host writes hook configs to known JSON files (`~/.codex/hooks.json`, `~/.config/cursor/hooks.json`, etc.). Pi has no equivalent file: each Pi extension is a separately installed npm package. Installation goes through Pi's own package manager:

```bash
pi install @victor-software-house/pi-claude-mem
```

The installer logic belongs in that extension package, not in the claude-mem repo. This PR is intentionally narrow — adapter + slug only — so the boundary stays clean.

## Future work

- `pi-claude-mem` extension package (separate repo)
- Pi session JSONL transcript watcher under `src/services/transcripts/` for cold ingestion of completed sessions
- `claude-mem install --ide pi` UX that detects Pi installs and points the operator at `pi install …`
- Pi-specific status-bar widget showing context-injection token savings (mirrors `pi-sub-bar`)

## Related upstream

- PR #2235 (Crush): IDE adapter, hooks installer, SQLite transcript watcher — same pattern, broader scope
- PR #2077 (draft): `build-adapter` skill — generic adapter scaffolding
- Issue series #2376–#2380: multi-IDE adapter discipline plan
