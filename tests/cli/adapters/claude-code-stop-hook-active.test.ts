import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — stop_hook_active', () => {
  const base = { session_id: 's1', cwd: '/tmp' };

  it('ignores stop_hook_active: claude-mem never blocks a stop, so the flag never marks its own loop', () => {
    // Claude Code sets the flag after ANOTHER plugin's Stop hook blocked the
    // stop. Mapping it (#3168) made summarize skip every later turn's summary.
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: true }).stopHookActive).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: false }).stopHookActive).toBeUndefined();
    expect(claudeCodeAdapter.normalizeInput(base).stopHookActive).toBeUndefined();
  });
});
