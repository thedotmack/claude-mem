import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

// Shape captured from Claude Code 2.1.287 for `ls ./does-not-exist`.
const postToolUseFailurePayload = {
  session_id: 's1',
  cwd: '/tmp',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'ls ./does-not-exist', description: 'List nonexistent directory' },
  tool_use_id: 'toolu_01TW23kr6AgmuFcagxiwvpC7',
  error: 'Exit code 1\nls: ./does-not-exist: No such file or directory',
  is_interrupt: false,
  duration_ms: 2146,
};

describe('claudeCodeAdapter.normalizeInput — PostToolUseFailure', () => {
  it('records the error of a failed call as its tool response', () => {
    const input = claudeCodeAdapter.normalizeInput(postToolUseFailurePayload);

    expect(input.toolName).toBe('Bash');
    expect(input.toolInput).toEqual(postToolUseFailurePayload.tool_input);
    expect(input.toolUseId).toBe('toolu_01TW23kr6AgmuFcagxiwvpC7');
    expect(input.toolResponse).toEqual({
      error: 'Exit code 1\nls: ./does-not-exist: No such file or directory',
      is_interrupt: false,
    });
  });

  it('keeps that the user interrupted the call, which the error text does not say', () => {
    const input = claudeCodeAdapter.normalizeInput({
      ...postToolUseFailurePayload,
      error: 'Command failed',
      is_interrupt: true,
    });

    expect(input.toolResponse).toEqual({ error: 'Command failed', is_interrupt: true });
  });

  it('leaves a successful call\'s tool_response as it is', () => {
    const toolResponse = { stdout: 'README.md\n', stderr: '', interrupted: false };
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 's1',
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: toolResponse,
    });

    expect(input.toolResponse).toEqual(toolResponse);
  });

  it('has no tool response for an event that carries neither field', () => {
    expect(claudeCodeAdapter.normalizeInput({ session_id: 's1', cwd: '/tmp' }).toolResponse).toBeUndefined();
  });
});
