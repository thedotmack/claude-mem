import { describe, expect, it } from 'bun:test';
import { isWorkStateBatchEnabled, isWorkStateEnabled } from '../../src/shared/work-state-setting.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { FILE_ONLY_SETTING_KEYS } from '../../src/services/worker/http/routes/SettingsRoutes.js';

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

describe('CLAUDE_MEM_WORK_STATE_BATCH_ENABLED', () => {
  it('turns grouped writes on only for the exact string true', () => {
    expect(isWorkStateBatchEnabled('true')).toBe(true);
    expect(isWorkStateBatchEnabled(undefined)).toBe(false);
    expect(isWorkStateBatchEnabled('false')).toBe(false);
    expect(isWorkStateBatchEnabled('TRUE')).toBe(false);
    expect(isWorkStateBatchEnabled('1')).toBe(false);
    expect(isWorkStateBatchEnabled('')).toBe(false);
  });

  it('ships off by default and is not rejected by the settings routes', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_WORK_STATE_BATCH_ENABLED).toBe('false');
    expect(FILE_ONLY_SETTING_KEYS.has('CLAUDE_MEM_WORK_STATE_BATCH_ENABLED')).toBe(false);
  });
});
