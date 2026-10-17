import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { isWorkStateEnabled } from '../../src/shared/work-state-setting.js';

describe('CLAUDE_MEM_WORK_STATE_ENABLED (#4606)', () => {
  it('defaults to "true", so nothing changes unless a user turns it off', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_WORK_STATE_ENABLED).toBe('true');
    expect(isWorkStateEnabled(defaults.CLAUDE_MEM_WORK_STATE_ENABLED)).toBe(true);
  });

  it('is off only for "false", in any case and with surrounding spaces', () => {
    expect(isWorkStateEnabled('false')).toBe(false);
    expect(isWorkStateEnabled('FALSE')).toBe(false);
    expect(isWorkStateEnabled(' false ')).toBe(false);
  });

  it('stays on for a missing, blank or other value', () => {
    expect(isWorkStateEnabled(undefined)).toBe(true);
    expect(isWorkStateEnabled('')).toBe(true);
    expect(isWorkStateEnabled('true')).toBe(true);
    expect(isWorkStateEnabled('0')).toBe(true);
  });
});
