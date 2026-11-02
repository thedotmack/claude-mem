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

// Devin payloads: read/edit captured from a real session, the rest from the
// hook docs (tests/fixtures/hosts/devin-hooks.json).
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

  test('maps captured read and edit payloads to Read and Edit, keeping file_path and tool_use_id', () => {
    const read = devinAdapter.normalizeInput(fixture.payloads.PostToolUseRead);
    expect(read.sessionId).toBe('glamorous-energy');
    expect(read.toolName).toBe('Read');
    expect(read.toolInput).toEqual({ file_path: '/tmp/devin-fixture-test.txt' });
    expect(read.toolUseId).toBe('read:10#51bd603fafe14ea1abae3969e7ce4f11');
    expect(read.turnId).toBe('74fe6288-4e56-4bf2-9e2e-d8b184c43ee9');

    const edit = devinAdapter.normalizeInput(fixture.payloads.PostToolUseEdit);
    expect(edit.toolName).toBe('Edit');
    expect(edit.toolInput).toEqual({ file_path: '/tmp/devin-fixture-test.txt', old_string: 'hello', new_string: 'world' });
    expect(edit.toolResponse).toEqual(fixture.payloads.PostToolUseEdit.tool_response);
    expect(edit.toolUseId).toBe('edit:11#0065a456c7b04520b184df9e7dcc49ae');
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
});

describe('devinAdapter.formatOutput', () => {
  test('emits the hookSpecificOutput envelope Devin reads for context injection', () => {
    const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory' } };
    expect(devinAdapter.formatOutput(result)).toEqual({ hookSpecificOutput: result.hookSpecificOutput });
    expect(devinAdapter.formatOutput({})).toEqual({});
  });
});
