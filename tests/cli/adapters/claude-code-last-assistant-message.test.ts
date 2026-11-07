import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — last_assistant_message (#5445)', () => {
  const base = { session_id: 's1', cwd: '/tmp' };

  it('maps the field so the summarize handler can skip the transcript read', () => {
    expect(
      claudeCodeAdapter.normalizeInput({ ...base, last_assistant_message: 'Done.' }).lastAssistantMessage
    ).toBe('Done.');
  });

  it('drops the empty string (a session ending mid-tool-call) so the handler falls back to the transcript', () => {
    expect(claudeCodeAdapter.normalizeInput({ ...base, last_assistant_message: '' }).lastAssistantMessage).toBeUndefined();
  });

  it('drops missing and non-string values', () => {
    expect(claudeCodeAdapter.normalizeInput(base).lastAssistantMessage).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput({ ...base, last_assistant_message: 42 }).lastAssistantMessage).toBeUndefined();
  });
});
