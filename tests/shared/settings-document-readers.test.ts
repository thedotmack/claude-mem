import { describe, expect, it } from 'bun:test';
import { readFlatSettings } from '../../src/npx-cli/utils/settings.js';
import { settingsTarget } from '../../src/shared/settings-document.js';

describe('settings document readers', () => {
  it('routes all settings readers through the same classifier contract', () => {
    const document = { env: { CLAUDE_MEM_LOG_LEVEL: 'DEBUG', CLAUDE_MEM_MODEL: 'nested' }, hooks: [] };
    expect(settingsTarget(document)).toBe(document.env);
    // Root copies beside an env block holding claude-mem's keys are stale: the env block wins.
    expect(settingsTarget({ CLAUDE_MEM_MODEL: 'root', env: document.env })).toBe(document.env);
    // An env block without claude-mem's keys is Claude Code's: the root wins.
    const flat = { CLAUDE_MEM_MODEL: 'root', env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' } };
    expect(settingsTarget(flat)).toBe(flat);
  });

  it('keeps invalid reader input recoverable without selecting an array', () => {
    expect(() => settingsTarget({ env: ['sentinel'] } as never)).not.toThrow();
    expect(readFlatSettings('missing-settings-document.json')).toBeNull();
  });
});
