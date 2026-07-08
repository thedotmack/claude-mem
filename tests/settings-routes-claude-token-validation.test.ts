import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { SettingsRoutes } from '../src/services/worker/http/routes/SettingsRoutes.js';

function validateClaudeTokenSetting(value: string): { valid: boolean; error?: string } {
  const routes = new SettingsRoutes({} as never);
  return (routes as unknown as {
    validateSettings(settings: Record<string, string>): { valid: boolean; error?: string };
  }).validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: value });
}

function validateSettings(settings: Record<string, unknown>): { valid: boolean; error?: string } {
  const routes = new SettingsRoutes({} as never);
  return (routes as unknown as {
    validateSettings(settings: Record<string, unknown>): { valid: boolean; error?: string };
  }).validateSettings(settings);
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

describe('SettingsRoutes settings allowlist', () => {
  it('persists subagent observation filter settings', () => {
    const source = readFileSync('src/services/worker/http/routes/SettingsRoutes.ts', 'utf-8');
    expect(source).toContain("'CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS'");
    expect(source).toContain("'CLAUDE_MEM_SKIP_AGENT_TYPES'");
    expect(source).toContain("'CLAUDE_MEM_ALLOW_DISMISS'");
  });

  it('validates subagent observation filter setting shapes', () => {
    expect(validateSettings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' }).valid).toBe(true);
    expect(validateSettings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false' }).valid).toBe(true);

    const booleanResult = validateSettings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: true });
    expect(booleanResult.valid).toBe(false);
    expect(booleanResult.error).toBe('CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS must be "true" or "false"');

    expect(validateSettings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent,Explore' }).valid).toBe(true);

    const listResult = validateSettings({ CLAUDE_MEM_SKIP_AGENT_TYPES: ['workflow-subagent'] });
    expect(listResult.valid).toBe(false);
    expect(listResult.error).toBe('CLAUDE_MEM_SKIP_AGENT_TYPES must be a comma-separated string');
  });

  it('validates the observation dismiss write gate setting', () => {
    expect(validateSettings({ CLAUDE_MEM_ALLOW_DISMISS: 'true' }).valid).toBe(true);
    expect(validateSettings({ CLAUDE_MEM_ALLOW_DISMISS: 'false' }).valid).toBe(true);

    const result = validateSettings({ CLAUDE_MEM_ALLOW_DISMISS: false });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('CLAUDE_MEM_ALLOW_DISMISS must be "true" or "false"');
  });
});
