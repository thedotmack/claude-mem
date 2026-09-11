import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';

// #3606 — the four OpenRouter context-window settings. Distinct from
// settings-defaults-manager.test.ts's generic file/env-precedence coverage:
// this asserts the specific keys and their documented default values, plus
// that an env override wins per-key.

const OPENROUTER_CONTEXT_KEYS = [
  'CLAUDE_MEM_OPENROUTER_MAX_TOKENS',
  'CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES',
  'CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS',
  'CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS',
] as const satisfies ReadonlyArray<keyof SettingsDefaults>;

describe('SettingsDefaultsManager — OpenRouter context-window keys', () => {
  let tempDir: string;
  let settingsPath: string;
  const prevEnv: Partial<Record<(typeof OPENROUTER_CONTEXT_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    tempDir = join(tmpdir(), `settings-openrouter-keys-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');

    for (const key of OPENROUTER_CONTEXT_KEYS) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of OPENROUTER_CONTEXT_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('ships the documented defaults', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_OPENROUTER_MAX_TOKENS).toBe('4096');
    expect(defaults.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES).toBe('40');
    expect(defaults.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS).toBe('200000');
    expect(defaults.CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS).toBe('30000');
  });

  it('loads values from settings.json when no env override is set', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_OPENROUTER_MAX_TOKENS: '2048',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '10',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS: '50000',
      CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS: '5000',
    }), 'utf-8');

    const result = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(result.CLAUDE_MEM_OPENROUTER_MAX_TOKENS).toBe('2048');
    expect(result.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES).toBe('10');
    expect(result.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS).toBe('50000');
    expect(result.CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS).toBe('5000');
  });

  it('falls back to defaults for keys absent from the file entirely', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_MODEL: 'some-other-key' }), 'utf-8');

    const result = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(result.CLAUDE_MEM_OPENROUTER_MAX_TOKENS).toBe('4096');
    expect(result.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES).toBe('40');
    expect(result.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS).toBe('200000');
    expect(result.CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS).toBe('30000');
  });

  it('an env override wins over the file value, per key', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '10',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS: '50000',
    }), 'utf-8');
    process.env.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES = '99';

    const result = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(result.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES).toBe('99'); // env wins
    expect(result.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS).toBe('50000'); // file wins (no env set)
  });

  it('an env override wins even when the file has no OpenRouter keys at all', () => {
    writeFileSync(settingsPath, JSON.stringify({}), 'utf-8');
    process.env.CLAUDE_MEM_OPENROUTER_MAX_TOKENS = '512';
    process.env.CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS = '9999';

    const result = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(result.CLAUDE_MEM_OPENROUTER_MAX_TOKENS).toBe('512');
    expect(result.CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS).toBe('9999');
  });
});
