import { describe, expect, test } from 'bun:test';
import { claudeCodeAdapter, getPlatformAdapter, mcodeAdapter } from '../../../src/cli/adapters/index.js';
import { AdapterRejectedInput } from '../../../src/cli/adapters/errors.js';

// MiniMax Code 0.7.10 hook payloads (hooks.json in ~/.minimax), sanitized.
const BASE = {
  session_id: 'mvs_00000000000000000000000000000001',
  turn_id: 'turn_0000000_000000',
  transcript_path: '/tmp/minimax-plugin-hooks/transcripts/0000.compatible.jsonl',
  cwd: '/home/example/project',
  model: 'MiniMax-M3.1-Flash',
  permission_mode: 'bypassPermissions',
};
const READ = {
  ...BASE,
  hook_event_name: 'PostToolUse',
  tool_name: 'read',
  tool_input: { path: 'notes.txt' },
  tool_response: { content: [{ type: 'text', text: '     1→The deploy port is 4317.\n' }], details: {} },
  tool_use_id: 'call_1',
};

describe('mcodeAdapter', () => {
  test('is the adapter for the mcode platform', () => {
    expect(getPlatformAdapter('mcode')).toBe(mcodeAdapter);
  });

  test('reads SessionStart and UserPromptSubmit', () => {
    const start = mcodeAdapter.normalizeInput({ ...BASE, hook_event_name: 'SessionStart', source: 'startup' });
    expect(start.sessionId).toBe(BASE.session_id);
    expect(start.cwd).toBe(BASE.cwd);
    expect(start.sessionSource).toBe('startup');
    expect(mcodeAdapter.normalizeInput({ ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'Read notes.txt' }).prompt).toBe('Read notes.txt');
  });

  test('maps read to Read and gives its path a file_path', () => {
    const input = mcodeAdapter.normalizeInput(READ);
    expect(input.toolName).toBe('Read');
    expect(input.toolInput).toEqual({ path: 'notes.txt', file_path: 'notes.txt' });
    expect(input.toolResponse).toEqual(READ.tool_response);
    expect(input.toolUseId).toBe('call_1');
  });

  test('maps write and bash, and passes other tools through unchanged', () => {
    const write = mcodeAdapter.normalizeInput({ ...READ, tool_name: 'write', tool_input: { path: 'a.txt', content: 'x' } });
    expect(write.toolName).toBe('Write');
    expect(write.toolInput).toEqual({ path: 'a.txt', content: 'x', file_path: 'a.txt' });
    const bash = mcodeAdapter.normalizeInput({ ...READ, tool_name: 'bash', tool_input: { command: 'ls', path: 'src' } });
    expect(bash.toolName).toBe('Bash');
    expect(bash.toolInput).toEqual({ command: 'ls', path: 'src' });
    const grep = mcodeAdapter.normalizeInput({ ...READ, tool_name: 'grep', tool_input: { pattern: 'x', path: 'src' } });
    expect(grep.toolInput).toEqual({ pattern: 'x', path: 'src' });
    expect(mcodeAdapter.normalizeInput({ ...READ, tool_name: 'mcp__claude-mem__search' }).toolName).toBe('mcp__claude-mem__search');
    expect(mcodeAdapter.normalizeInput({ ...READ, tool_name: 'toString' }).toolName).toBe('toString');
  });

  test('ignores the temporary transcript_path and keeps the Stop message', () => {
    const input = mcodeAdapter.normalizeInput({ ...BASE, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'The deploy port is 4317.' });
    expect(input.transcriptPath).toBeUndefined();
    expect(input.lastAssistantMessage).toBe('The deploy port is 4317.');
  });

  test('rejects a payload without a session id', () => {
    expect(() => mcodeAdapter.normalizeInput({ ...BASE, session_id: '' })).toThrow(AdapterRejectedInput);
  });

  test('returns context in the Claude Code envelope', () => {
    const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory' } };
    expect(mcodeAdapter.formatOutput(result)).toEqual(claudeCodeAdapter.formatOutput(result));
  });
});
