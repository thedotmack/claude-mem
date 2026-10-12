import { describe, expect, it } from 'bun:test';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';

const hookInput = (fields: Record<string, unknown> = {}) => ({
  session_id: 'codex-session',
  cwd: '/tmp',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'pwd' },
  tool_response: { stdout: '/tmp' },
  ...fields,
});

describe('codexAdapter native attribution', () => {
  it.each(['PreToolUse', 'PostToolUse'])('preserves tool IDs and subagent fields on %s', hookEventName => {
    const input = codexAdapter.normalizeInput(hookInput({
      hook_event_name: hookEventName,
      tool_use_id: 'call-codex-1',
      agent_id: 'codex-agent-1',
      agent_type: 'explorer',
    }));

    expect(input.toolUseId).toBe('call-codex-1');
    expect(input.agentId).toBe('codex-agent-1');
    expect(input.agentType).toBe('explorer');
  });

  it('leaves missing attribution absent for main-session hooks', () => {
    const input = codexAdapter.normalizeInput(hookInput());

    expect(input.toolUseId).toBeUndefined();
    expect(input.agentId).toBeUndefined();
    expect(input.agentType).toBeUndefined();
  });

  it.each([undefined, null, '', 42, {}, []].map(value => ({ value })))('ignores invalid attribution values: %j', ({ value }) => {
    const input = codexAdapter.normalizeInput(hookInput({
      tool_use_id: value,
      agent_id: value,
      agent_type: value,
    }));

    expect(input.toolUseId).toBeUndefined();
    expect(input.agentId).toBeUndefined();
    expect(input.agentType).toBeUndefined();
  });

  it('keeps agent fields at the shared 128-character boundary', () => {
    const value = 'a'.repeat(128);
    const input = codexAdapter.normalizeInput(hookInput({ agent_id: value, agent_type: value }));

    expect(input.agentId).toBe(value);
    expect(input.agentType).toBe(value);
  });

  it('drops oversized agent fields without discarding the tool ID', () => {
    const value = 'a'.repeat(129);
    const input = codexAdapter.normalizeInput(hookInput({
      tool_use_id: 'call-codex-2',
      agent_id: value,
      agent_type: value,
    }));

    expect(input.toolUseId).toBe('call-codex-2');
    expect(input.agentId).toBeUndefined();
    expect(input.agentType).toBeUndefined();
  });

  it('preserves independent agent fields on lifecycle events', () => {
    expect(codexAdapter.normalizeInput(hookInput({
      hook_event_name: 'Stop', agent_id: 'codex-agent-1',
    })).agentId).toBe('codex-agent-1');
    expect(codexAdapter.normalizeInput(hookInput({
      hook_event_name: 'SessionStart', agent_type: 'explorer',
    })).agentType).toBe('explorer');
  });
});
