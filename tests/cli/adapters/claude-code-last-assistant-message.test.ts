import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — last_assistant_message', () => {
  const base = { session_id: 's1', cwd: '/tmp' };

  it('maps last_assistant_message to lastAssistantMessage when present as a string', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      ...base,
      last_assistant_message: 'Completed refactoring database queries',
    });
    expect(normalized.lastAssistantMessage).toBe('Completed refactoring database queries');
  });

  it('normalizes empty string to empty string so summarize handler can detect and fall back to transcript if needed', () => {
    const normalized = claudeCodeAdapter.normalizeInput({
      ...base,
      last_assistant_message: '',
    });
    expect(normalized.lastAssistantMessage).toBe('');
  });

  it('drops non-string values to undefined', () => {
    expect(claudeCodeAdapter.normalizeInput({ ...base, last_assistant_message: null }).lastAssistantMessage).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput({ ...base, last_assistant_message: 123 }).lastAssistantMessage).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput({ ...base, last_assistant_message: true }).lastAssistantMessage).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput(base).lastAssistantMessage).toBeUndefined();
  });
});
