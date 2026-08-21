# Kimi Code CLI Harness Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kimi Code CLI as a first-class claude-mem harness (adapter + config-merge installer + CLI wiring + docs), matching the Claude Code integration's hook surface.

**Architecture:** A `kimi` platform adapter normalizes Kimi hook stdin JSON into `NormalizedHookInput`; a `KimiHooksInstaller` merges a marker-delimited `[[hooks]]` block into `$KIMI_CODE_HOME/config.toml` and the `mcp-search` server into `$KIMI_CODE_HOME/mcp.json`; hook commands call the existing `worker-service.cjs hook kimi <event>` contract. Transcript support extends `transcript-parser.ts` for Kimi's event-sourced `wire.jsonl`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun runtime + `bun test`, Node fallback for MCP stdio, TOML text-merge (no TOML library — CodexCliInstaller precedent).

**Spec:** `plans/kimi-harness/2026-08-20-kimi-harness-design.md` (same directory — read it first)

## Global Constraints

- Worktree: `/home/user/projects/claude-mem-worktrees/kimi-plugin`, branch `feat/kimi-harness`. All paths below are relative to it.
- Conventional commits (`feat(kimi): ...`, `test(kimi): ...`, `docs(kimi): ...`).
- Full suite green: `bun test` after every task.
- Hooks fail open: any internal error exits 0 (Kimi semantics: exit 0 allow, exit 2 block, other non-zero = fail-open anyway; we choose clean exit 0).
- Honor `KIMI_CODE_HOME` env var; default root `~/.kimi-code`.
- NEVER write to `~/.claude-mem/settings.json` — the worker's Ollama pipeline (`CLAUDE_MEM_PROVIDER=openrouter` → `http://localhost:11434/v1`, model `claude-mem-gemma`) is out of scope and must remain untouched.
- Bake absolute paths into generated configs (Rule B, `src/services/integrations/install-paths.ts`: `getBunAbsolutePath()`, `getNodeAbsolutePath()`, `getWorkerServiceAbsolutePath()`, `getMcpServerAbsolutePath()`). Kimi performs no `${...}` substitution in hook commands.
- TOML hook commands use **literal strings** (single quotes) so Windows backslash paths need no escaping.
- Marker block strings (exact):
  - Begin: `# >>> claude-mem kimi hooks (managed by claude-mem; do not edit) >>>`
  - End: `# <<< claude-mem kimi hooks <<<`
- Kimi hook timeouts must be 1–600 (seconds).

### Kimi hook facts (verified against https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)

- stdin payload base: `{ "hook_event_name", "session_id", "session_title", "client_type", "cwd" }`, snake_case; tool events add `tool_name`, `tool_input`, `tool_response`; `SessionStart` adds `source` (`startup`|`resume`), `model`, `profile`; `UserPromptSubmit` adds `prompt`.
- Exit 0 stdout may be appended to context (verified empirically: the user's existing `memory-session-start.sh` digest reaches context).
- `[[hooks]]` fields: `event` (required), `matcher` (regex, optional), `command` (required), `timeout` (1–600, default 30). Extra fields fail config load — write ONLY these four.

### Kimi wire.jsonl facts (verified against live `~/.kimi-code/sessions/` files)

- Location: `$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`; hook payloads do NOT include a transcript path — derive by scanning `sessions/*/<sessionId>/agents/main/wire.jsonl`.
- User message: `{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- Assistant text: `{"type":"context.append_loop_event","event":{"type":"content.part",...,"part":{"type":"text","text":"..."}}}` (sibling part type `think` holds reasoning — skip it)

---

### Task 1: Kimi wire format support in transcript parser

**Files:**
- Modify: `src/shared/transcript-parser.ts`
- Create: `tests/fixtures/kimi-wire.sample.jsonl`
- Test: `tests/transcripts/kimi-wire-extraction.test.ts`

**Interfaces:**
- Consumes: existing `extractLastMessageFromJsonl(content: string, role: 'user' | 'assistant', stripSystemReminders: boolean): string` in `src/shared/transcript-parser.ts`.
- Produces: same function, now also understanding Kimi wire lines. Two new non-exported helpers `kimiWireRole(line)` and `kimiWireText(line, role)`. No signature changes.

- [ ] **Step 1: Write the fixture**

`tests/fixtures/kimi-wire.sample.jsonl` — a minimal wire log (event order matters; the last assistant text is "Final answer text"):

```jsonl
{"type":"metadata","protocol_version":"1.5","created_at":1787268414138}
{"type":"profile.bind","agentId":"main","modelAlias":"kimi-code/k3","profileName":"agent"}
{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"First user question"}]}}
{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"u1","turnId":"0","step":1,"part":{"type":"think","think":"reasoning that must be skipped"}},"time":1787268414200}
{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"u2","turnId":"0","step":1,"part":{"type":"text","text":"Intermediate assistant text"}},"time":1787268414300}
{"type":"context.append_loop_event","event":{"type":"tool.call","toolName":"Bash","callId":"c1","input":{"command":"ls"}},"time":1787268414400}
{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"Second user question"}]}}
{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"u3","turnId":"1","step":1,"part":{"type":"text","text":"Final answer text"}},"time":1787268414500}
{"type":"turn.ended","turnId":"1","time":1787268414600}
```

- [ ] **Step 2: Write the failing test**

`tests/transcripts/kimi-wire-extraction.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { extractLastMessageFromJsonl } from '../../src/shared/transcript-parser.js';

const fixture = readFileSync(
  path.join(import.meta.dir, '..', 'fixtures', 'kimi-wire.sample.jsonl'),
  'utf-8'
);

describe('kimi wire.jsonl extraction', () => {
  test('extracts last assistant text part, skipping think parts', () => {
    expect(extractLastMessageFromJsonl(fixture, 'assistant', false)).toBe('Final answer text');
  });

  test('extracts last user message text', () => {
    expect(extractLastMessageFromJsonl(fixture, 'user', false)).toBe('Second user question');
  });

  test('returns empty string for wire content with no matching role', () => {
    const onlyTool = '{"type":"context.append_loop_event","event":{"type":"tool.call","toolName":"Bash","callId":"c1","input":{}}}\n';
    expect(extractLastMessageFromJsonl(onlyTool, 'assistant', false)).toBe('');
  });

  test('claude-format lines still work alongside the kimi branch', () => {
    const claude = '{"type":"assistant","message":{"content":[{"type":"text","text":"claude text"}]}}\n';
    expect(extractLastMessageFromJsonl(claude, 'assistant', false)).toBe('claude text');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/transcripts/kimi-wire-extraction.test.ts`
Expected: FAIL — first three tests return `''` (parser sees `context.append_message` / `context.append_loop_event` as `line.type`, never `user`/`assistant`).

- [ ] **Step 4: Implement the Kimi branch in `extractLastMessageFromJsonl`**

In `src/shared/transcript-parser.ts`, add two helpers above `extractLastMessageFromJsonl`:

```ts
/**
 * Kimi Code wire.jsonl is event-sourced; role is carried by envelope type:
 * - user:      {"type":"context.append_message","message":{"role":"user",...}}
 * - assistant: {"type":"context.append_loop_event","event":{"type":"content.part",
 *              ...,"part":{"type":"text","text":"..."}}}  (part.type "think" is reasoning — skipped)
 */
function kimiWireRole(line: any): 'user' | 'assistant' | undefined {
  if (line?.type === 'context.append_message') {
    const role = line.message?.role;
    return role === 'user' || role === 'assistant' ? role : undefined;
  }
  if (
    line?.type === 'context.append_loop_event' &&
    line.event?.type === 'content.part' &&
    line.event?.part?.type === 'text'
  ) {
    return 'assistant';
  }
  return undefined;
}

function kimiWireText(line: any, role: 'user' | 'assistant'): string {
  if (role === 'user' && line?.type === 'context.append_message') {
    const content = line.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n');
    }
    return '';
  }
  if (role === 'assistant' && line?.type === 'context.append_loop_event') {
    const text = line.event?.part?.text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}
```

Inside the scan loop, replace the role/content extraction so the Kimi branch is consulted first:

```ts
    const kimiRole = kimiWireRole(line);
    const lineRole = kimiRole ?? line.type ?? line.role;
    if (lineRole !== role) continue;
    foundMatchingRole = true;

    let text = '';
    if (kimiRole) {
      text = kimiWireText(line, role);
    } else {
      if (!line.message?.content) continue;
      const msgContent = line.message.content;
      if (typeof msgContent === 'string') {
        text = msgContent;
      } else if (Array.isArray(msgContent)) {
        text = msgContent
          .filter(
            (c: any): c is { type: 'text'; text: string } =>
              !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string'
          )
          .map((c) => c.text)
          .join('\n');
      } else {
        continue;
      }
    }
```

(The `stripSystemReminders` pass, empty-text fallback, and return logic below stay exactly as they are.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/transcripts/`
Expected: PASS — new kimi test plus existing `cursor-extraction.test.ts` all green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/transcript-parser.ts tests/transcripts/kimi-wire-extraction.test.ts tests/fixtures/kimi-wire.sample.jsonl
git commit -m "feat(kimi): parse kimi wire.jsonl transcripts in extractLastMessageFromJsonl"
```

---

### Task 2: Kimi platform adapter + output passthrough + registrations

**Files:**
- Create: `src/shared/kimi-paths.ts`
- Create: `src/cli/adapters/kimi.ts`
- Modify: `src/shared/hook-io.ts` (one branch in `emitModelContext`)
- Modify: `src/cli/adapters/index.ts`
- Modify: `src/shared/platform-source.ts`
- Test: `tests/cli/adapters/kimi.test.ts`

**Interfaces:**
- Consumes: `PlatformAdapter`, `NormalizedHookInput`, `HookResult` from `src/cli/types.js`; `AdapterRejectedInput`, `isValidCwd` from `src/cli/adapters/errors.js`; Task 1's parser (indirectly, via the summarize handler reading `transcriptPath`).
- Produces:
  - `kimiCodeHome(): string` (from `src/shared/kimi-paths.ts`) — reused by the Task 3 installer.
  - `kimiConfigPath(): string`, `kimiMcpJsonPath(): string` (same module) — installer.
  - `deriveKimiTranscriptPath(sessionId: string): string | undefined` — adapter + tests.
  - `kimiAdapter: PlatformAdapter` — registered as `'kimi'` in `getPlatformAdapter`.
  - `normalizePlatformSource('kimi')` returns `'kimi'`.

- [ ] **Step 1: Write the failing adapter test**

`tests/cli/adapters/kimi.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { deriveKimiTranscriptPath, kimiAdapter } from '../../../src/cli/adapters/kimi.js';

const ORIGINAL_HOME = process.env.KIMI_CODE_HOME;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = ORIGINAL_HOME;
});

function makeScratchHome(): string {
  const dir = path.join(tmpdir(), `kimi-adapter-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.KIMI_CODE_HOME = dir;
  return dir;
}

describe('kimiAdapter.normalizeInput', () => {
  test('normalizes a PostToolUse payload', () => {
    const input = kimiAdapter.normalizeInput({
      hook_event_name: 'PostToolUse',
      session_id: 'session_abc',
      cwd: process.cwd(),
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'ok' },
    });
    expect(input.sessionId).toBe('session_abc');
    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual({ command: 'ls' });
    expect(input.toolResponse).toEqual({ stdout: 'ok' });
  });

  test('maps SessionStart source startup|resume, drops unknown values', () => {
    const base = { hook_event_name: 'SessionStart', session_id: 's1', cwd: process.cwd() };
    expect(kimiAdapter.normalizeInput({ ...base, source: 'startup' }).sessionSource).toBe('startup');
    expect(kimiAdapter.normalizeInput({ ...base, source: 'resume' }).sessionSource).toBe('resume');
    expect(kimiAdapter.normalizeInput({ ...base, source: 'archive' }).sessionSource).toBeUndefined();
  });

  test('rejects missing session_id', () => {
    expect(() => kimiAdapter.normalizeInput({ cwd: process.cwd() })).toThrow();
  });

  test('derives transcriptPath from the sessions tree', () => {
    const home = makeScratchHome();
    const wire = path.join(home, 'sessions', 'wd_proj_abc123', 'session_abc', 'agents', 'main', 'wire.jsonl');
    mkdirSync(path.dirname(wire), { recursive: true });
    writeFileSync(wire, '{"type":"metadata"}\n');
    const input = kimiAdapter.normalizeInput({ session_id: 'session_abc', cwd: process.cwd() });
    expect(input.transcriptPath).toBe(wire);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('kimiAdapter.formatOutput', () => {
  test('passes additionalContext through as raw text for stdout injection', () => {
    expect(kimiAdapter.formatOutput({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory digest' } }))
      .toBe('memory digest');
  });

  test('returns empty object otherwise', () => {
    expect(kimiAdapter.formatOutput({})).toEqual({});
  });
});

describe('deriveKimiTranscriptPath', () => {
  test('returns undefined when the sessions root is missing', () => {
    makeScratchHome();
    expect(deriveKimiTranscriptPath('session_nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/adapters/kimi.test.ts`
Expected: FAIL — module `src/cli/adapters/kimi.js` does not exist.

- [ ] **Step 3: Create `src/shared/kimi-paths.ts`**

```ts
import path from 'path';
import { homedir } from 'os';

/** Kimi Code data root: $KIMI_CODE_HOME when set, else ~/.kimi-code. */
export function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code');
}

export function kimiConfigPath(): string {
  return path.join(kimiCodeHome(), 'config.toml');
}

export function kimiMcpJsonPath(): string {
  return path.join(kimiCodeHome(), 'mcp.json');
}
```

- [ ] **Step 4: Create `src/cli/adapters/kimi.ts`**

```ts
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { kimiCodeHome } from '../../shared/kimi-paths.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Kimi hook payloads carry no transcript path. Wire logs live at
 * sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl; the workDirKey
 * bucket is derived from cwd, so scan the (small) sessions root instead of
 * reimplementing the bucket hash. Bounded by the directory entry count.
 */
export function deriveKimiTranscriptPath(sessionId: string): string | undefined {
  const sessionsRoot = path.join(kimiCodeHome(), 'sessions');
  let workDirs: string[];
  try {
    workDirs = readdirSync(sessionsRoot);
  } catch {
    return undefined;
  }
  for (const workDir of workDirs) {
    const candidate = path.join(sessionsRoot, workDir, sessionId, 'agents', 'main', 'wire.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const sessionId = stringOrUndefined(r.session_id);
    if (!sessionId) {
      throw new AdapterRejectedInput('missing_session_id');
    }
    const source = r.source;
    return {
      sessionId,
      cwd,
      prompt: stringOrUndefined(r.prompt),
      toolName: stringOrUndefined(r.tool_name),
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: deriveKimiTranscriptPath(sessionId),
      model: stringOrUndefined(r.model),
      sessionSource: source === 'startup' || source === 'resume' ? source : undefined,
    };
  },

  formatOutput(result: HookResult): unknown {
    // Kimi appends plain stdout text to context; it does not understand the
    // Claude/Codex hookSpecificOutput JSON envelope for context injection.
    const context = result?.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string' && context.length > 0) return context;
    return {};
  },
};
```

- [ ] **Step 5: Register the adapter**

`src/cli/adapters/index.ts` — add the import, the switch case, and the export:

```ts
import { kimiAdapter } from './kimi.js';
// in getPlatformAdapter switch, before default:
    case 'kimi': return kimiAdapter;
// extend the export list:
export { antigravityCliAdapter, claudeCodeAdapter, codexAdapter, cursorAdapter, kimiAdapter, rawAdapter, windsurfAdapter };
```

`src/shared/platform-source.ts` — add kimi to normalization and priority:

```ts
  if (source.includes('kimi')) return 'kimi';
  // ...
  const priority = ['claude', 'codex', 'cursor', 'kimi'];
```

- [ ] **Step 6: hook-io raw-string passthrough**

In `src/shared/hook-io.ts`, `emitModelContext` — adapters may now return a raw string (kimi context injection); objects keep the existing JSON envelope:

```ts
  const output = adapter.formatOutput(result);
  console.log(typeof output === 'string' ? output : JSON.stringify(output));
```

Also update the doc comment above `emitModelContext`: replace "stdout JSON only" wording with "stdout payload (JSON envelope, or raw text when the adapter returns a string — e.g. kimi context injection)".

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/cli/adapters/`
Expected: PASS — new kimi tests plus existing codex-file-context tests green.

- [ ] **Step 8: Commit**

```bash
git add src/shared/kimi-paths.ts src/cli/adapters/kimi.ts src/cli/adapters/index.ts src/shared/platform-source.ts src/shared/hook-io.ts tests/cli/adapters/kimi.test.ts
git commit -m "feat(kimi): platform adapter with wire.jsonl transcript derivation"
```

---

### Task 3: KimiHooksInstaller

**Files:**
- Create: `src/services/integrations/KimiHooksInstaller.ts`
- Test: `tests/integration/kimi-hooks-installer.test.ts`

**Interfaces:**
- Consumes: `kimiCodeHome`, `kimiConfigPath`, `kimiMcpJsonPath` from `src/shared/kimi-paths.js`; `getBunAbsolutePath`, `getNodeAbsolutePath`, `getWorkerServiceAbsolutePath`, `getMcpServerAbsolutePath` from `./install-paths.js`.
- Produces (used by Task 4 wiring):
  - `installKimiHooks(): number`
  - `configureKimiMcp(): number`
  - `uninstallKimiHooks(): number`
  - `checkKimiHooksStatus(): number`
  - `handleKimiCommand(subcommand: string | undefined, args: string[]): Promise<number>`
  - exported for tests: `upsertManagedBlock(content: string, block: string): string`, `removeManagedBlock(content: string): string`, `KIMI_MARKER_BEGIN`, `KIMI_MARKER_END`, `buildKimiHooksBlock(bunPath: string, workerPath: string): string`

- [ ] **Step 1: Write the failing installer test**

`tests/integration/kimi-hooks-installer.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildKimiHooksBlock,
  checkKimiHooksStatus,
  configureKimiMcp,
  installKimiHooks,
  KIMI_MARKER_BEGIN,
  KIMI_MARKER_END,
  removeManagedBlock,
  uninstallKimiHooks,
  upsertManagedBlock,
} from '../../src/services/integrations/KimiHooksInstaller.js';

const ORIGINAL_HOME = process.env.KIMI_CODE_HOME;
let scratch: string | undefined;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = ORIGINAL_HOME;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function makeScratchHome(): string {
  scratch = path.join(tmpdir(), `kimi-install-test-${process.pid}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  process.env.KIMI_CODE_HOME = scratch;
  return scratch;
}

describe('managed block merge', () => {
  const block = `${KIMI_MARKER_BEGIN}\n[[hooks]]\nevent = "Stop"\ncommand = 'x'\n${KIMI_MARKER_END}`;

  test('appends to empty config', () => {
    expect(upsertManagedBlock('', block)).toBe(`${block}\n`);
  });

  test('replaces an existing managed block, preserving user content', () => {
    const user = 'default_model = "kimi-code/k3"\n';
    const once = upsertManagedBlock(user, block);
    const twice = upsertManagedBlock(once, block.replace('"Stop"', '"PreCompact"'));
    expect(twice).toContain('default_model');
    expect(twice).toContain('"PreCompact"');
    expect(twice).not.toContain('"Stop"');
    expect(twice.split(KIMI_MARKER_BEGIN)).toHaveLength(2);
  });

  test('removeManagedBlock strips exactly the block', () => {
    const merged = upsertManagedBlock('default_model = "kimi-code/k3"\n', block);
    const restored = removeManagedBlock(merged);
    expect(restored).not.toContain(KIMI_MARKER_BEGIN);
    expect(restored).toContain('default_model');
  });
});

describe('installKimiHooks', () => {
  test('writes the managed block, backs up config, is idempotent', () => {
    const home = makeScratchHome();
    writeFileSync(path.join(home, 'config.toml'), 'default_model = "kimi-code/k3"\n');
    expect(installKimiHooks()).toBe(0);
    const config = readFileSync(path.join(home, 'config.toml'), 'utf-8');
    expect(config).toContain(KIMI_MARKER_BEGIN);
    expect(config).toContain('hook kimi context');
    expect(config).toContain('hook kimi observation');
    expect(config).toContain('hook kimi summarize');
    expect(config).toContain('default_model'); // user content preserved
    // second run: no duplicate block
    expect(installKimiHooks()).toBe(0);
    const again = readFileSync(path.join(home, 'config.toml'), 'utf-8');
    expect(again.split(KIMI_MARKER_BEGIN)).toHaveLength(2);
  });

  test('status reports installed state; uninstall removes the block', () => {
    const home = makeScratchHome();
    expect(checkKimiHooksStatus()).toBe(1); // not installed
    expect(installKimiHooks()).toBe(0);
    expect(checkKimiHooksStatus()).toBe(0);
    expect(uninstallKimiHooks()).toBe(0);
    expect(checkKimiHooksStatus()).toBe(1);
    expect(readFileSync(path.join(home, 'config.toml'), 'utf-8')).not.toContain(KIMI_MARKER_BEGIN);
  });
});

describe('configureKimiMcp', () => {
  test('adds mcp-search without clobbering existing servers', () => {
    const home = makeScratchHome();
    writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { context7: { url: 'https://mcp.context7.com/mcp' } } }, null, 2));
    expect(configureKimiMcp()).toBe(0);
    const mcp = JSON.parse(readFileSync(path.join(home, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.context7).toBeDefined();
    expect(mcp.mcpServers['mcp-search'].type).toBe('stdio');
    expect(mcp.mcpServers['mcp-search'].args[0]).toContain('mcp-server.cjs');
    // idempotent
    expect(configureKimiMcp()).toBe(0);
  });
});

describe('buildKimiHooksBlock', () => {
  test('contains all six rules with TOML literal commands and valid timeouts', () => {
    const block = buildKimiHooksBlock('/home/u/.bun/bin/bun', '/x/worker-service.cjs');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop', 'PreCompact']) {
      expect(block).toContain(`event = "${event}"`);
    }
    expect(block).toContain("command = '\"/home/u/.bun/bin/bun\" \"/x/worker-service.cjs\"");
    expect(block).toContain('matcher = "Read"');
    const timeouts = [...block.matchAll(/timeout = (\d+)/g)].map((m) => Number(m[1]));
    expect(timeouts).toHaveLength(6);
    for (const t of timeouts) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(600);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/kimi-hooks-installer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/services/integrations/KimiHooksInstaller.ts`**

```ts
/**
 * KimiHooksInstaller.ts — first-class Kimi Code CLI harness integration.
 *
 * Kimi hooks live in `[[hooks]]` tables inside $KIMI_CODE_HOME/config.toml
 * (TOML). Following the CodexCliInstaller precedent we merge text-level,
 * inside a marker-delimited managed block — no TOML library. The MCP server
 * registration goes into $KIMI_CODE_HOME/mcp.json (plain JSON merge).
 * Absolute paths are baked per Rule B (install-paths.ts): Kimi performs no
 * variable substitution on hook commands.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { kimiCodeHome, kimiConfigPath, kimiMcpJsonPath } from '../../shared/kimi-paths.js';
import { logger } from '../../utils/logger.js';
import {
  getBunAbsolutePath,
  getMcpServerAbsolutePath,
  getNodeAbsolutePath,
  getWorkerServiceAbsolutePath,
} from './install-paths.js';

export const KIMI_MARKER_BEGIN = '# >>> claude-mem kimi hooks (managed by claude-mem; do not edit) >>>';
export const KIMI_MARKER_END = '# <<< claude-mem kimi hooks <<<';

/** Six rules, full parity with the Claude Code hook surface. */
export function buildKimiHooksBlock(bunPath: string, workerPath: string): string {
  const run = (suffix: string) => `'"${bunPath}" "${workerPath}" ${suffix}'`;
  const rules = [
    { event: 'SessionStart', matcher: 'startup|resume', command: run(`start && "${bunPath}" "${workerPath}" hook kimi context`), timeout: 120 },
    { event: 'UserPromptSubmit', matcher: undefined, command: run('hook kimi session-init'), timeout: 60 },
    { event: 'PostToolUse', matcher: undefined, command: run('hook kimi observation'), timeout: 120 },
    { event: 'PreToolUse', matcher: 'Read', command: run('hook kimi file-context'), timeout: 60 },
    { event: 'Stop', matcher: undefined, command: run('hook kimi summarize'), timeout: 120 },
    { event: 'PreCompact', matcher: 'manual|auto', command: run('hook kimi summarize'), timeout: 120 },
  ];
  const body = rules
    .map((rule) => {
      const lines = ['[[hooks]]', `event = "${rule.event}"`];
      if (rule.matcher) lines.push(`matcher = "${rule.matcher}"`);
      lines.push(`command = ${rule.command}`, `timeout = ${rule.timeout}`);
      return lines.join('\n');
    })
    .join('\n\n');
  return `${KIMI_MARKER_BEGIN}\n${body}\n${KIMI_MARKER_END}`;
}

export function upsertManagedBlock(content: string, block: string): string {
  const begin = content.indexOf(KIMI_MARKER_BEGIN);
  const end = content.indexOf(KIMI_MARKER_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return content.slice(0, begin) + block + content.slice(end + KIMI_MARKER_END.length);
  }
  const separator = content.length === 0 || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return content + separator + block + '\n';
}

export function removeManagedBlock(content: string): string {
  const begin = content.indexOf(KIMI_MARKER_BEGIN);
  const end = content.indexOf(KIMI_MARKER_END);
  if (begin === -1 || end === -1 || end <= begin) return content;
  return (content.slice(0, begin) + content.slice(end + KIMI_MARKER_END.length)).replace(/\n{3,}/g, '\n\n');
}

function backupOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'));
  }
}

export function installKimiHooks(): number {
  const workerPath = getWorkerServiceAbsolutePath();
  if (!workerPath) {
    console.error('Could not find worker-service.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const bunPath = getBunAbsolutePath();
  const configPath = kimiConfigPath();
  try {
    mkdirSync(kimiCodeHome(), { recursive: true });
    backupOnce(configPath);
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    writeFileSync(configPath, upsertManagedBlock(current, buildKimiHooksBlock(bunPath, workerPath)));
    console.log(`  Installed Kimi hooks into ${configPath}`);
    console.log(`    Bun runtime: ${bunPath}`);
    console.log(`    Worker: ${workerPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to install Kimi hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function configureKimiMcp(): number {
  const serverPath = getMcpServerAbsolutePath();
  if (!serverPath) {
    console.error('Could not find mcp-server.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const mcpPath = kimiMcpJsonPath();
  try {
    mkdirSync(kimiCodeHome(), { recursive: true });
    const config: { mcpServers?: Record<string, unknown> } = existsSync(mcpPath)
      ? JSON.parse(readFileSync(mcpPath, 'utf-8'))
      : {};
    config.mcpServers ??= {};
    if (config.mcpServers['mcp-search']) {
      console.log('  MCP server mcp-search already configured in mcp.json');
      return 0;
    }
    config.mcpServers['mcp-search'] = {
      type: 'stdio',
      command: getNodeAbsolutePath(),
      args: [serverPath],
    };
    writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`  Configured MCP server in ${mcpPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to configure Kimi MCP: ${(error as Error).message}`);
    return 1;
  }
}

export function uninstallKimiHooks(): number {
  const configPath = kimiConfigPath();
  if (!existsSync(configPath)) {
    console.log('  No Kimi config.toml found; nothing to uninstall');
    return 0;
  }
  try {
    const current = readFileSync(configPath, 'utf-8');
    const next = removeManagedBlock(current);
    if (next !== current) {
      writeFileSync(configPath, next);
      console.log('  Removed claude-mem hooks from config.toml');
    } else {
      console.log('  No claude-mem hook block found in config.toml');
    }
    return 0;
  } catch (error) {
    console.error(`Failed to uninstall Kimi hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function checkKimiHooksStatus(): number {
  const configPath = kimiConfigPath();
  const installed = existsSync(configPath) && readFileSync(configPath, 'utf-8').includes(KIMI_MARKER_BEGIN);
  if (installed) {
    console.log(`  Kimi hooks: installed (${configPath})`);
    return 0;
  }
  console.log('  Kimi hooks: not installed');
  return 1;
}

export async function handleKimiCommand(subcommand: string | undefined, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const hooks = installKimiHooks();
      const mcp = configureKimiMcp();
      return hooks === 0 && mcp === 0 ? 0 : 1;
    }
    case 'uninstall':
      return uninstallKimiHooks();
    case 'status':
      return checkKimiHooksStatus();
    default:
      console.log('Usage: claude-mem kimi <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/integration/kimi-hooks-installer.test.ts`
Expected: PASS (all four describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/services/integrations/KimiHooksInstaller.ts tests/integration/kimi-hooks-installer.test.ts
git commit -m "feat(kimi): config-merge installer for kimi hooks and MCP registration"
```

---

### Task 4: CLI, installer, and detection wiring + skip-tools defaults

**Files:**
- Modify: `src/services/worker-service.ts` (~line 1301, next to `case 'cursor'`)
- Modify: `src/npx-cli/commands/install.ts` (`makeIDETask`, next to `case 'cursor'` at line 319)
- Modify: `src/npx-cli/commands/ide-detection.ts` (`detectInstalledIDEs` list)
- Modify: `src/npx-cli/index.ts` (IDE identifier help text)
- Modify: `src/shared/SettingsDefaultsManager.ts` (line 123, skip-tools default)

**Interfaces:**
- Consumes: `handleKimiCommand`, `installKimiHooks`, `configureKimiMcp` from Task 3; existing `bufferConsole`, `recordFailure` patterns in `install.ts`.
- Produces: `claude-mem kimi <install|uninstall|status>` CLI; `kimi` appears in `npx claude-mem install` auto-detection.

- [ ] **Step 1: worker-service dispatch**

In `src/services/worker-service.ts`, add the import alongside `handleCursorCommand` (line ~73):

```ts
  handleKimiCommand
```

(add `handleKimiCommand` to the existing `import { ... } from './integrations/KimiHooksInstaller.js'` — create the import block mirroring the Cursor one), and a case next to `case 'cursor'` (line ~1301):

```ts
    case 'kimi': {
      const kimiSubcommand = process.argv[3];
      const kimiResult = await handleKimiCommand(kimiSubcommand, process.argv.slice(4));
      process.exit(kimiResult);
      break;
    }
```

- [ ] **Step 2: smoke the dispatch**

Run: `bun plugin/scripts/worker-service.cjs kimi status`
Expected: prints "Kimi hooks: not installed", exit code 1 (config.toml has no managed block yet). Note: run from the worktree so `getWorkerServiceAbsolutePath()` resolves via `process.cwd()/plugin`.

- [ ] **Step 3: npx install task**

In `src/npx-cli/commands/install.ts`, `makeIDETask`, next to `case 'cursor'`:

```ts
    case 'kimi': {
      return {
        title: 'Kimi Code: installing hooks + MCP',
        task: async (message) => {
          message('Loading Kimi installer…');
          const { installKimiHooks, configureKimiMcp } = await import('../../services/integrations/KimiHooksInstaller.js');
          message('Installing Kimi hooks…');
          const { result: hooksResult, output: hooksOutput } = await bufferConsole(() => installKimiHooks());
          if (hooksResult !== 0) {
            recordFailure('Kimi Code: hook installation failed', hooksOutput);
            return `Kimi Code: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          message('Configuring Kimi MCP…');
          const { result: mcpResult } = await bufferConsole(async () => configureKimiMcp());
          if (mcpResult === 0) {
            return `Kimi Code: hooks + MCP installed ${styleText('green', 'OK')}`;
          }
          return `Kimi Code: hooks installed; MCP setup failed — run \`npx claude-mem kimi install\` ${styleText('yellow', '!')}`;
        },
      };
    }
```

- [ ] **Step 4: IDE detection**

In `src/npx-cli/commands/ide-detection.ts`, add to the `detectInstalledIDEs()` array (after the `codex-cli` entry):

```ts
    {
      id: 'kimi',
      label: 'Kimi Code',
      detected: existsSync(join(home, '.kimi-code')) || isCommandInPath('kimi'),
      hint: 'hooks + MCP integration',
    },
```

In `src/npx-cli/index.ts`, find the IDE identifier list in the help text (grep anchor: `codex-cli`) and add `kimi` in the same style.

- [ ] **Step 5: skip-tools defaults**

In `src/shared/SettingsDefaultsManager.ts` line 123, extend the default so Kimi's chatter tools are skipped (only ADDS new-fresh installs; existing user settings are never rewritten by this manager):

```ts
    CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion,TodoList,TaskList,TaskOutput,TaskStop,CronCreate,CronList,CronDelete',
```

- [ ] **Step 6: verify build + full suite**

Run: `bun run build` (if a build script exists — check `package.json`; otherwise `bunx tsc --noEmit`) && `bun test`
Expected: type-check clean; entire suite green.

- [ ] **Step 7: Commit**

```bash
git add src/services/worker-service.ts src/npx-cli/commands/install.ts src/npx-cli/commands/ide-detection.ts src/npx-cli/index.ts src/shared/SettingsDefaultsManager.ts
git commit -m "feat(kimi): wire kimi harness into CLI dispatch, npx installer, and IDE detection"
```

---

### Task 5: Docs + changelog

**Files:**
- Create: `docs/public/kimi-integration.mdx`
- Modify: `docs/public/platform-integration.mdx` (harness table)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: write `docs/public/kimi-integration.mdx`**

Mirror the structure of `docs/public/openclaw-integration.mdx` (read it first and match its frontmatter/sections). Content: what gets installed (six `[[hooks]]` rules in `~/.kimi-code/config.toml`, `mcp-search` in `~/.kimi-code/mcp.json`), `KIMI_CODE_HOME` support, `npx claude-mem kimi install|status|uninstall`, event mapping table (copy the table from the spec section 3), fail-open behavior, backup note (`config.toml.bak-<date>`).

- [ ] **Step 2: platform-integration.mdx row**

Add Kimi Code to the supported-harness table in `docs/public/platform-integration.mdx`, matching the existing row format.

- [ ] **Step 3: CHANGELOG entry**

Add under the unreleased/`## [Unreleased]` heading if present, else at the top following the file's existing convention:

```markdown
- Kimi Code CLI harness: first-class integration with hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreToolUse`, `Stop`, `PreCompact`), MCP registration, `claude-mem kimi install|status|uninstall`, and `npx claude-mem install` auto-detection
```

- [ ] **Step 4: Commit**

```bash
git add docs/public/kimi-integration.mdx docs/public/platform-integration.mdx CHANGELOG.md
git commit -m "docs(kimi): kimi code harness integration guide and changelog"
```

---

### Task 6: Live verification gate (manual, with the user)

**No code. Verification checklist before the PR is opened.**

- [ ] **Step 1: scratch install**

```bash
export KIMI_CODE_HOME=/tmp/kimi-verify
bun plugin/scripts/worker-service.cjs kimi install
cat /tmp/kimi-verify/config.toml   # managed block present, no other content disturbed
cat /tmp/kimi-verify/mcp.json      # mcp-search entry
```

- [ ] **Step 2: real Kimi session against scratch home**

Run `KIMI_CODE_HOME=/tmp/kimi-verify kimi` in a scratch project, ask one question, run one tool. Then confirm capture in the worker DB:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, platform_source, substr(prompt,1,60) FROM sdk_sessions ORDER BY id DESC LIMIT 3;"
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE platform_source='kimi';"
```

(table names may differ — check `.tables`; `platform_source` must read `kimi`)

- [ ] **Step 3: compression via Ollama**

Confirm the new observations were compressed by the local pipeline (worker log references `localhost:11434` / `claude-mem-gemma`), and `git diff` shows no change to `~/.claude-mem/settings.json`.

- [ ] **Step 4: context injection**

Start a second scratch-home session and confirm the claude-mem context digest renders in the new session's context.

- [ ] **Step 5: uninstall cleanliness**

`bun plugin/scripts/worker-service.cjs kimi uninstall` against the scratch home; `config.toml` returns to its pre-install content.

- [ ] **Step 6: hand off for PR**

Report results. On the user's go: push `feat/kimi-harness` to `fork` and open the PR against `thedotmack/claude-mem` (user pings Alex on Discord after).
