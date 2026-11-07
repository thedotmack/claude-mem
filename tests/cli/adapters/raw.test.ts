import { describe, expect, test } from 'bun:test';
import { rawAdapter } from '../../../src/cli/adapters/raw.js';

describe('rawAdapter.normalizeInput', () => {
  // Hosts without a dedicated adapter (e.g. Devin CLI) send the final reply on
  // Stop with no transcript_path; without this mapping summarize skips (#4976).
  test('maps last_assistant_message from a Stop payload without a transcript', () => {
    const input = rawAdapter.normalizeInput({
      session_id: 'devin-session',
      cwd: process.cwd(),
      stop_hook_active: false,
      last_assistant_message: 'Done: fixed the failing test.',
    });
    expect(input.transcriptPath).toBeUndefined();
    expect(input.lastAssistantMessage).toBe('Done: fixed the failing test.');
  });

  test('accepts camelCase lastAssistantMessage', () => {
    const input = rawAdapter.normalizeInput({
      sessionId: 'raw-session',
      cwd: process.cwd(),
      lastAssistantMessage: 'All set.',
    });
    expect(input.lastAssistantMessage).toBe('All set.');
  });
});
