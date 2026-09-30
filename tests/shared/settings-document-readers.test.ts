import { describe, expect, it } from 'bun:test';
import { readFlatSettings } from '../../src/npx-cli/utils/settings.js';
import { settingsTarget } from '../../src/shared/settings-document.js';

describe('settings document readers', () => {
  it('routes all settings readers through the same classifier contract', () => {
    const document = { env: { CLAUDE_MEM_LOG_LEVEL: 'DEBUG', CLAUDE_MEM_MODEL: 'nested' }, hooks: [] };
    expect(settingsTarget(document)).toBe(document.env);
    expect(settingsTarget({ CLAUDE_MEM_MODEL: 'root', env: document.env })).toEqual({ CLAUDE_MEM_MODEL: 'root', env: document.env });
  });

  it('keeps invalid reader input recoverable without selecting an array', () => {
    expect(() => settingsTarget({ env: ['sentinel'] } as never)).not.toThrow();
    expect(readFlatSettings('missing-settings-document.json')).toBeNull();
  });
});
