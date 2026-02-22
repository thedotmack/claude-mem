import { describe, it, expect } from 'vitest';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';

/**
 * Tests for SDKAgent effort configuration
 *
 * The effort option should:
 * - Pass valid effort values ('low', 'medium', 'high', 'max') to SDK query options
 * - Treat empty string as "no effort option" (SDK default behavior)
 * - Ignore invalid effort values
 * - Be exposed via getSDKOptions() alongside modelId
 */

type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Mirrors the effort validation logic from SDKAgent.getSDKOptions()
 * Extracted for testability without spawning an SDK process.
 */
function resolveEffort(effortSetting: string): EffortLevel | undefined {
  const validEfforts: EffortLevel[] = ['low', 'medium', 'high', 'max'];
  if (effortSetting && validEfforts.includes(effortSetting as EffortLevel)) {
    return effortSetting as EffortLevel;
  }
  return undefined;
}

/**
 * Mirrors getSDKOptions() from SDKAgent.ts
 * Returns both modelId and optional effort configuration.
 */
function getSDKOptions(settingsPath: string): { modelId: string; effort?: EffortLevel } {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const effort = resolveEffort(settings.MAGIC_CLAUDE_MEM_EFFORT);
  return { modelId: settings.MAGIC_CLAUDE_MEM_MODEL, effort };
}

describe('SDKAgent Effort Configuration', () => {
  describe('resolveEffort()', () => {
    it('should return "low" for valid "low" setting', () => {
      expect(resolveEffort('low')).toBe('low');
    });

    it('should return "medium" for valid "medium" setting', () => {
      expect(resolveEffort('medium')).toBe('medium');
    });

    it('should return "high" for valid "high" setting', () => {
      expect(resolveEffort('high')).toBe('high');
    });

    it('should return "max" for valid "max" setting', () => {
      expect(resolveEffort('max')).toBe('max');
    });

    it('should return undefined for empty string (SDK default behavior)', () => {
      expect(resolveEffort('')).toBeUndefined();
    });

    it('should return undefined for invalid effort values', () => {
      expect(resolveEffort('ultra')).toBeUndefined();
      expect(resolveEffort('minimal')).toBeUndefined();
      expect(resolveEffort('HIGH')).toBeUndefined(); // case-sensitive
      expect(resolveEffort('1')).toBeUndefined();
    });
  });

  describe('MAGIC_CLAUDE_MEM_EFFORT setting', () => {
    it('should have empty string as default value', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();
      expect(defaults.MAGIC_CLAUDE_MEM_EFFORT).toBe('');
    });

    it('should be accessible via get()', () => {
      const value = SettingsDefaultsManager.get('MAGIC_CLAUDE_MEM_EFFORT');
      expect(value).toBe('');
    });
  });

  describe('getSDKOptions()', () => {
    it('should return modelId from settings', () => {
      // Uses a non-existent path so it falls back to defaults
      const options = getSDKOptions('/tmp/nonexistent-settings-test-effort.json');
      expect(options.modelId).toBe('claude-sonnet-4-5');
    });

    it('should return undefined effort when setting is empty (default)', () => {
      const options = getSDKOptions('/tmp/nonexistent-settings-test-effort.json');
      expect(options.effort).toBeUndefined();
    });

    it('should return correct shape with both fields', () => {
      const options = getSDKOptions('/tmp/nonexistent-settings-test-effort.json');
      expect(options).toHaveProperty('modelId');
      expect(options).toHaveProperty('effort');
      expect(typeof options.modelId).toBe('string');
    });
  });

  describe('Effort option spreading into query options', () => {
    it('should produce empty object spread when effort is undefined', () => {
      const effort = resolveEffort('');
      const effortOption = effort ? { effort } : {};
      expect(effortOption).toEqual({});
    });

    it('should produce effort object when effort is valid', () => {
      const effort = resolveEffort('low');
      const effortOption = effort ? { effort } : {};
      expect(effortOption).toEqual({ effort: 'low' });
    });

    it('should merge correctly with other query options', () => {
      const effort = resolveEffort('medium');
      const effortOption = effort ? { effort } : {};
      const queryOptions = {
        model: 'claude-sonnet-4-5',
        ...effortOption,
        cwd: '/tmp',
      };
      expect(queryOptions).toEqual({
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        cwd: '/tmp',
      });
    });

    it('should not include effort key when empty string', () => {
      const effort = resolveEffort('');
      const effortOption = effort ? { effort } : {};
      const queryOptions = {
        model: 'claude-sonnet-4-5',
        ...effortOption,
        cwd: '/tmp',
      };
      expect(queryOptions).toEqual({
        model: 'claude-sonnet-4-5',
        cwd: '/tmp',
      });
      expect('effort' in queryOptions).toBe(false);
    });
  });
});
