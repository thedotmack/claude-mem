import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { paths } from '../../src/shared/paths.js';
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
  it('retains current upstream endpoint settings and all Codex provider keys', () => {
    for (const key of ['CLAUDE_MEM_OPENROUTER_BASE_URL', 'CLAUDE_MEM_CLAUDE_AUTH_METHOD',
      'CLAUDE_MEM_CODEX_MODEL', 'CLAUDE_MEM_CODEX_PATH', 'CLAUDE_MEM_CODEX_REASONING_EFFORT',
      'CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES', 'CLAUDE_MEM_CODEX_MAX_TOKENS',
      'CLAUDE_MEM_CODEX_TIMEOUT_MS', 'CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT']) {
      expect(SETTINGS_ROUTE_KEYS).toContain(key);
    }
    expect(new Set(SETTINGS_ROUTE_KEYS).size).toBe(SETTINGS_ROUTE_KEYS.length);
  });

  it('accepts native Codex none reasoning without changing the provider', () => {
    expect(validateSettings({ CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_REASONING_EFFORT: 'none' }))
      .toEqual({ valid: true });
    expect(validateSettings({ CLAUDE_MEM_CODEX_REASONING_EFFORT: 'invalid' }).valid).toBe(false);
  });

  it('updates nested settings while preserving root peer keys, credentials and file permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-update-'));
    const settingsPath = join(dir, 'settings.json');
    const originalSettingsPath = paths.settings;
    const original = { theme: 'dark', permissions: { defaultMode: 'auto' }, env: {
      CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'preserved-key',
    } };
    try {
      writeFileSync(settingsPath, JSON.stringify(original), { mode: 0o644 });
      paths.settings = () => settingsPath;
      const routes = new SettingsRoutes({} as never) as unknown as {
        handleUpdateSettings(req: unknown, res: unknown, next: (error?: unknown) => void): unknown;
      };
      let response: unknown;
      await routes.handleUpdateSettings({ body: {
        CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_MODEL: 'custom-model',
        CLAUDE_MEM_CODEX_REASONING_EFFORT: 'none',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://example.invalid/v1',
        UNRECOGNIZED_SETTING: 'must-not-write',
      } }, { json: (body: unknown) => { response = body; } }, (error) => { if (error) throw error; });
      expect(response).toMatchObject({ success: true });
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ ...original, env: {
        ...original.env, CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_MODEL: 'custom-model',
        CLAUDE_MEM_CODEX_REASONING_EFFORT: 'none',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://example.invalid/v1',
      } });
      if (process.platform !== 'win32') expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    } finally {
      paths.settings = originalSettingsPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('retains the legacy Codex observations-per-prompt key for settings round trips', () => {
    expect(SETTINGS_ROUTE_KEYS).toContain('CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT');
  });

  it('accepts the legacy Codex observations-per-prompt range', () => {
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '1' })).toEqual({ valid: true });
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '6' })).toEqual({ valid: true });
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '50' })).toEqual({ valid: true });
  });

  it('rejects out-of-range legacy Codex observations-per-prompt values', () => {
    const expected = {
      valid: false,
      error: 'CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT must be between 1 and 50',
    };

    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '0' })).toEqual(expected);
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: '51' })).toEqual(expected);
    expect(validateSettings({ CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT: 'many' })).toEqual(expected);
  });
});
