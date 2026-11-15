import { describe, expect, it } from 'bun:test';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';

describe('codexAdapter SessionStart source', () => {
  const base = { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp' };

  it('passes every Codex SessionStart source through, including fork', () => {
    // Codex 0.165 added fork to SessionStartSource (codex-rs/hooks/src/
    // events/session_start.rs) for its experimental attached thread forks.
    // The adapter must carry it, not drop it, so the context hook and any
    // later source-aware handling see a forked thread for what it is.
    for (const source of ['startup', 'resume', 'clear', 'fork']) {
      expect(codexAdapter.normalizeInput({ ...base, source }).sessionSource).toBe(source);
    }
  });

  it('drops unknown sources instead of passing them through', () => {
    expect(codexAdapter.normalizeInput({ ...base, source: 'archive' }).sessionSource).toBeUndefined();
    expect(codexAdapter.normalizeInput({ ...base }).sessionSource).toBeUndefined();
  });
});
