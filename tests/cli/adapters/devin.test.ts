import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { devinAdapter, getPlatformAdapter } from '../../../src/cli/adapters/index.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

const ORIGINAL_PROJECT_DIR = process.env.DEVIN_PROJECT_DIR;

afterEach(() => {
  if (ORIGINAL_PROJECT_DIR === undefined) delete process.env.DEVIN_PROJECT_DIR;
  else process.env.DEVIN_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
});

// Payload shapes pinned from Devin's hook docs (tests/fixtures/hosts/devin-hooks.json).
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'hosts', 'devin-hooks.json'), 'utf-8'),
);

describe('devinAdapter against Devin payloads', () => {
  test('is the adapter for the devin platform', () => {
    expect(getPlatformAdapter('devin')).toBe(devinAdapter);
  });

  test('maps exec to Bash and keeps its command and tool_response', () => {
    const input = devinAdapter.normalizeInput(fixture.payloads.PostToolUse);
    expect(input.sessionId).toBe('devin-session-1');
    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual({ command: 'npm test', shell_id: 'main' });
    expect(input.toolResponse).toEqual({ success: true, output: '12 passing\n', error: null });
    expect(input.turnId).toBe('prompt-1');
  });

  test('reads the prompt, the Stop message and the SessionEnd reason', () => {
    expect(devinAdapter.normalizeInput(fixture.payloads.UserPromptSubmit).prompt).toBe('fix the login redirect');
    expect(devinAdapter.normalizeInput(fixture.payloads.Stop).lastAssistantMessage)
      .toBe('The login redirect now keeps the original query string.');
    expect(devinAdapter.normalizeInput(fixture.payloads.SessionEnd).reason).toBe('prompt_input_exit');
  });

  test('maps SessionStart source and has no prompt-scoped turn yet', () => {
    const input = devinAdapter.normalizeInput(fixture.payloads.SessionStart);
    expect(input.sessionSource).toBe('startup');
    expect(input.turnId).toBeUndefined();
    expect(devinAdapter.normalizeInput({ ...fixture.payloads.SessionStart, source: 'other' }).sessionSource).toBeUndefined();
  });

  test('takes cwd from DEVIN_PROJECT_DIR when the payload has none', () => {
    process.env.DEVIN_PROJECT_DIR = import.meta.dir;
    expect(devinAdapter.normalizeInput(fixture.payloads.PostToolUse).cwd).toBe(import.meta.dir);
    delete process.env.DEVIN_PROJECT_DIR;
    expect(devinAdapter.normalizeInput(fixture.payloads.PostToolUse).cwd).toBe(process.cwd());
    expect(devinAdapter.normalizeInput({ ...fixture.payloads.PostToolUse, cwd: import.meta.dir }).cwd).toBe(import.meta.dir);
  });

  test('rejects a payload without session_id', () => {
    expect(() => devinAdapter.normalizeInput({ tool_name: 'exec' })).toThrow(AdapterRejectedInput);
  });
});

describe('devinAdapter tool names', () => {
  const normalize = (tool_name: string, tool_input: unknown = {}) =>
    devinAdapter.normalizeInput({ session_id: 's', tool_name, tool_input });

  test.each([
    ['exec', 'Bash'], ['read', 'Read'], ['edit', 'Edit'], ['write', 'Write'],
    ['notebook_edit', 'NotebookEdit'], ['grep', 'Grep'], ['glob', 'Glob'],
    ['webfetch', 'WebFetch'], ['todo_write', 'TodoWrite'], ['skill', 'Skill'],
  ])('maps %s to %s', (devinName, claudeName) => {
    expect(normalize(devinName).toolName).toBe(claudeName);
  });

  test('passes unmapped and MCP tool names through', () => {
    expect(normalize('run_subagent').toolName).toBe('run_subagent');
    expect(normalize('mcp__github__get_issue').toolName).toBe('mcp__github__get_issue');
  });

  test('aliases a file tool path to file_path without mutating the input', () => {
    const raw = { path: 'src/login.ts', offset: 2 };
    const before = { ...raw };
    expect(normalize('read', raw).toolInput).toEqual({ ...before, file_path: 'src/login.ts' });
    expect(raw).toEqual(before);
    const supplied = { file_path: 'src/a.ts', path: 'src/b.ts' };
    expect(normalize('edit', supplied).toolInput).toBe(supplied);
    const execInput = { path: 'x', command: 'ls' };
    expect(normalize('exec', execInput).toolInput).toBe(execInput);
  });
});

describe('devinAdapter.formatOutput', () => {
  test('emits the hookSpecificOutput envelope Devin reads for context injection', () => {
    const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory' } };
    expect(devinAdapter.formatOutput(result)).toEqual({ hookSpecificOutput: result.hookSpecificOutput });
    expect(devinAdapter.formatOutput({})).toEqual({});
  });
});
