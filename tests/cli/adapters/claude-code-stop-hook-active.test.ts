import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.normalizeInput — stop_hook_active (#3161)', () => {
  const base = { session_id: 's1', cwd: '/tmp' };

  it('maps stop_hook_active so the summarize re-entry breaker can fire on Claude Code', () => {
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: true }).stopHookActive).toBe(true);
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: false }).stopHookActive).toBe(false);
    expect(claudeCodeAdapter.normalizeInput(base).stopHookActive).toBeUndefined();
  });

  it('never coerces a non-boolean value (the handler checks === true)', () => {
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: 'yes' }).stopHookActive).toBeUndefined();
  });
});
