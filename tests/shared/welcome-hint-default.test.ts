import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('CLAUDE_MEM_WELCOME_HINT_ENABLED default', () => {
  it('is set to "true" in getAllDefaults()', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_WELCOME_HINT_ENABLED).toBe('true');
  });
});
