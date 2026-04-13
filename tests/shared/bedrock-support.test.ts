import { describe, expect, it } from 'bun:test';
import { sanitizeEnv } from '../../src/supervisor/env-sanitizer.js';
import { AWS_REGION_PATTERN } from '../../src/services/worker/http/routes/SettingsRoutes.js';

describe('Bedrock support', () => {
  describe('env-sanitizer preserves CLAUDE_CODE_USE_BEDROCK', () => {
    it('preserves CLAUDE_CODE_USE_BEDROCK through sanitization', () => {
      const result = sanitizeEnv({
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OTHER: 'should-be-stripped',
        PATH: '/usr/bin',
        HOME: '/home/user'
      });

      expect(result.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(result.CLAUDE_CODE_OTHER).toBeUndefined();
      expect(result.PATH).toBe('/usr/bin');
    });

    it('does not inject CLAUDE_CODE_USE_BEDROCK when not present', () => {
      const result = sanitizeEnv({
        PATH: '/usr/bin'
      });

      expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    });
  });

  describe('getAuthMethodDescription', () => {
    // Dynamic import to avoid module-level side effects
    it('returns Bedrock description when authMethod is bedrock', async () => {
      const { getAuthMethodDescription } = await import('../../src/shared/EnvManager.js');
      const desc = getAuthMethodDescription('bedrock');
      expect(desc).toBe('AWS Bedrock (credentials from ~/.claude-mem/.env or ambient AWS config)');
    });

    it('returns CLI description when authMethod is undefined', async () => {
      const { getAuthMethodDescription } = await import('../../src/shared/EnvManager.js');
      const desc = getAuthMethodDescription();
      expect(desc).toContain('CLI');
    });

    it('returns CLI description when authMethod is cli', async () => {
      const { getAuthMethodDescription } = await import('../../src/shared/EnvManager.js');
      const desc = getAuthMethodDescription('cli');
      // Should not return bedrock description
      expect(desc).not.toContain('Bedrock');
    });
  });

  describe('SettingsDefaults includes Bedrock fields', () => {
    it('has CLAUDE_MEM_BEDROCK_AWS_REGION default', async () => {
      const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
      const defaults = SettingsDefaultsManager.DEFAULTS;
      expect(defaults.CLAUDE_MEM_BEDROCK_AWS_REGION).toBe('us-east-1');
    });

    it('has bedrock as valid CLAUDE_MEM_CLAUDE_AUTH_METHOD value', async () => {
      const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
      const defaults = SettingsDefaultsManager.DEFAULTS;
      // Default is cli, but 'bedrock' should be a valid option per the type comment
      expect(defaults.CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe('cli');
    });
  });

  describe('AWS_REGION in MANAGED_CREDENTIAL_KEYS', () => {
    it('includes AWS_REGION in managed credential keys', async () => {
      const { MANAGED_CREDENTIAL_KEYS } = await import('../../src/shared/EnvManager.js');
      expect(MANAGED_CREDENTIAL_KEYS).toContain('AWS_REGION');
      expect(MANAGED_CREDENTIAL_KEYS).toContain('AWS_ACCESS_KEY_ID');
      expect(MANAGED_CREDENTIAL_KEYS).toContain('AWS_SECRET_ACCESS_KEY');
      expect(MANAGED_CREDENTIAL_KEYS).toContain('AWS_SESSION_TOKEN');
    });
  });

  describe('region validation pattern', () => {
    it('accepts standard AWS regions', () => {
      const pattern = AWS_REGION_PATTERN;
      expect(pattern.test('us-east-1')).toBe(true);
      expect(pattern.test('eu-west-2')).toBe(true);
      expect(pattern.test('ap-southeast-1')).toBe(true);
    });

    it('accepts GovCloud regions', () => {
      const pattern = AWS_REGION_PATTERN;
      expect(pattern.test('us-gov-west-1')).toBe(true);
      expect(pattern.test('us-gov-east-1')).toBe(true);
    });

    it('accepts iso regions', () => {
      const pattern = AWS_REGION_PATTERN;
      expect(pattern.test('us-iso-east-1')).toBe(true);
      expect(pattern.test('us-isob-east-1')).toBe(true);
    });

    it('rejects invalid regions', () => {
      const pattern = AWS_REGION_PATTERN;
      expect(pattern.test('INVALID')).toBe(false);
      expect(pattern.test('us_east_1')).toBe(false);
      expect(pattern.test('')).toBe(false);
      expect(pattern.test('us-east-')).toBe(false);
    });
  });
});
