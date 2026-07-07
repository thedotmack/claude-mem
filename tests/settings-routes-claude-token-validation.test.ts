import { describe, expect, it } from 'bun:test';
import { SettingsRoutes } from '../src/services/worker/http/routes/SettingsRoutes.js';

function validateClaudeTokenSetting(value: string): { valid: boolean; error?: string } {
  const routes = new SettingsRoutes({} as never);
  return (routes as unknown as {
    validateSettings(settings: Record<string, string>): { valid: boolean; error?: string };
  }).validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: value });
}

describe('SettingsRoutes Claude token cap validation', () => {
  it('accepts whole-number values in the supported range', () => {
    expect(validateClaudeTokenSetting('1000').valid).toBe(true);
    expect(validateClaudeTokenSetting('150000').valid).toBe(true);
    expect(validateClaudeTokenSetting('1000000').valid).toBe(true);
  });

  it('rejects partial numbers and values outside the supported range', () => {
    for (const value of ['999', '1000001', '-1', '1000abc', 'abc1000']) {
      const result = validateClaudeTokenSetting(value);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('CLAUDE_MEM_CLAUDE_MAX_TOKENS must be between 1000 and 1000000');
    }
  });
});
