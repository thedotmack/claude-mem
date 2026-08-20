import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
  it('creates API settings files with owner-only permissions because they can contain provider credentials', () => {
    if (process.platform === 'win32') return;

    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-settings-route-'));
    const settingsPath = join(tempDir, 'settings.json');
    const routes = new SettingsRoutes({} as never) as unknown as {
      ensureSettingsFile(path: string): void;
    };

    try {
      routes.ensureSettingsFile(settingsPath);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
