import { describe, expect, it } from 'bun:test';
import {
  SETTINGS_ROUTE_KEYS,
  SettingsRoutes,
} from '../../src/services/worker/http/routes/SettingsRoutes.js';

function validateSettings(settings: Record<string, unknown>): { valid: boolean; error?: string } {
  const routes = new SettingsRoutes({} as never) as unknown as {
    validateSettings(settings: Record<string, unknown>): { valid: boolean; error?: string };
  };
  return routes.validateSettings(settings);
}

describe('SettingsRoutes Codex settings', () => {
  it('allows the Codex observations-per-prompt cap to be persisted', () => {
    expect(SETTINGS_ROUTE_KEYS).toContain('CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT');
  });

  it('accepts the supported Codex observations-per-prompt range', () => {
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '1' })).toEqual({ valid: true });
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '6' })).toEqual({ valid: true });
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '50' })).toEqual({ valid: true });
  });

  it('rejects out-of-range Codex observations-per-prompt caps', () => {
    const expected = {
      valid: false,
      error: 'CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT must be between 1 and 50',
    };

    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '0' })).toEqual(expected);
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '51' })).toEqual(expected);
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: 'many' })).toEqual(expected);
  });
});
