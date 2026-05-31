import { describe, expect, it } from 'bun:test';
import {
  isValidBooleanSettingValue,
  normalizeSettingValue,
} from '../../src/services/worker/http/routes/SettingsRoutes.js';

describe('SettingsRoutes boolean settings save compatibility', () => {
  it('normalizes JSON booleans to canonical settings strings before writing', () => {
    expect(normalizeSettingValue('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT', true)).toBe('true');
    expect(normalizeSettingValue('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT', false)).toBe('false');
  });

  it('does not coerce unrelated settings', () => {
    expect(normalizeSettingValue('CLAUDE_MEM_CONTEXT_OBSERVATIONS', true)).toBe(true);
    expect(normalizeSettingValue('CLAUDE_MEM_CONTEXT_OBSERVATIONS', '30')).toBe('30');
  });

  it('accepts legacy JSON booleans and canonical string booleans', () => {
    expect(isValidBooleanSettingValue(true)).toBe(true);
    expect(isValidBooleanSettingValue(false)).toBe(true);
    expect(isValidBooleanSettingValue('true')).toBe(true);
    expect(isValidBooleanSettingValue('false')).toBe(true);
  });

  it('rejects non-boolean values for boolean settings', () => {
    expect(isValidBooleanSettingValue('yes')).toBe(false);
    expect(isValidBooleanSettingValue(1)).toBe(false);
  });
});
