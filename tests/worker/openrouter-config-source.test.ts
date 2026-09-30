// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isOpenRouterAvailable,
  resolveOpenRouterConfig,
} from '../../src/services/worker/OpenRouterProvider.js';
import { DEFAULT_OPENROUTER_API_URL } from '../../src/shared/openrouter-base-url.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const DEFAULT_MODEL = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL;
const CMEM_BASE = 'https://cmem.ai/api/inference/v1';
const ENV_KEYS = [
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'OPENROUTER_BASE_URL',
  'CLAUDE_MEM_ENV_FILE',
  'CMEM_PRO_ORIGIN',
] as const;

describe('OpenRouter credential tuple source coherence', () => {
  let tempDir: string;
  let settingsPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_ENV_FILE = join(tempDir, '.env');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(overrides: Record<string, unknown> = {}): void {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_persisted',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_BASE,
      CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
      ...overrides,
    }));
  }

  it('ignores a key-only environment override when a persisted CMEM tuple is active', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'PERSONAL_KEY_MUST_NOT_REACH_CMEM';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('cm_pro_persisted');
    expect(config.apiUrl).toBe(`${CMEM_BASE}/chat/completions`);
    expect(config.model).toBe('cmem-observer');
    expect(isOpenRouterAvailable(settingsPath)).toBe(true);
  });

  it('fails closed when CMEM has no persisted key instead of borrowing a personal env key', () => {
    writeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: '' });
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'PERSONAL_KEY_MUST_NOT_REACH_CMEM';
    writeFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'OPENROUTER_API_KEY=PERSONAL_ENV_FILE_KEY\n');

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('');
    expect(config.apiUrl).toBe(`${CMEM_BASE}/chat/completions`);
    expect(isOpenRouterAvailable(settingsPath)).toBe(false);
  });

  it('accepts a personal key when the base is explicitly reset and restores the normal model', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-personal';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('sk-or-personal');
    expect(config.apiUrl).toBe(DEFAULT_OPENROUTER_API_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
  });

  it('fails closed when the CMEM base is reset without a personal key', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('');
    expect(config.apiUrl).toBe(DEFAULT_OPENROUTER_API_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(isOpenRouterAvailable(settingsPath)).toBe(false);
  });

  it('uses the personal env-file key for a base-only override, never the persisted CMEM key', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';
    writeFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'OPENROUTER_API_KEY=personal-env-file-key\n');

    expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
      apiKey: 'personal-env-file-key',
      apiUrl: 'https://gateway.example/v1/chat/completions',
      model: DEFAULT_MODEL,
    });
  });

  it('fails closed for a custom base-only override without a personal key', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('');
    expect(config.apiUrl).toBe('https://gateway.example/v1/chat/completions');
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(isOpenRouterAvailable(settingsPath)).toBe(false);
  });

  it('accepts an explicit replacement tuple, including a custom model', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'custom-key';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';
    process.env.CLAUDE_MEM_OPENROUTER_MODEL = 'custom-model';

    expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
      apiKey: 'custom-key',
      apiUrl: 'https://gateway.example/v1/chat/completions',
      model: 'custom-model',
    });
  });

  describe('the cmem memory key authenticates only against the cmem gateway', () => {
    const MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';

    it('withholds the key once the persisted base URL points at another host', () => {
      // What a settings-API write or a hand edit of settings.json leaves behind.
      writeSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: MEMORY_KEY,
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://gateway.example/v1',
      });

      const config = resolveOpenRouterConfig(settingsPath);

      expect(config.apiKey).toBe('');
      expect(config.apiUrl).toBe('https://gateway.example/v1/chat/completions');
      expect(isOpenRouterAvailable(settingsPath)).toBe(false);
    });

    it('withholds the key from openrouter.ai when the persisted base URL is cleared', () => {
      writeSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: MEMORY_KEY,
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
      });

      const config = resolveOpenRouterConfig(settingsPath);

      expect(config.apiKey).toBe('');
      expect(config.apiUrl).toBe(DEFAULT_OPENROUTER_API_URL);
    });

    it('withholds the key from a deceptive gateway lookalike', () => {
      writeSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: MEMORY_KEY,
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/api/inference/v1',
      });

      expect(resolveOpenRouterConfig(settingsPath).apiKey).toBe('');
    });

    it('withholds an exported key from an overridden non-gateway base', () => {
      writeSettings();
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = MEMORY_KEY;
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';

      expect(resolveOpenRouterConfig(settingsPath).apiKey).toBe('');
    });

    it('still sends the key to the gateway', () => {
      writeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: MEMORY_KEY });

      expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
        apiKey: MEMORY_KEY,
        apiUrl: `${CMEM_BASE}/chat/completions`,
        model: 'cmem-observer',
      });
    });

    it('leaves a personal key on its own host alone', () => {
      writeSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-deepseek-personal',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://api.deepseek.com',
        CLAUDE_MEM_OPENROUTER_MODEL: 'deepseek-chat',
      });

      expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
        apiKey: 'sk-deepseek-personal',
        apiUrl: 'https://api.deepseek.com/chat/completions',
      });
    });
  });

  it('does not treat a deceptive CMEM hostname as an account-owned tuple', () => {
    writeSettings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'custom-persisted-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'custom-model',
    });
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'custom-env-key';

    expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
      apiKey: 'custom-env-key',
      apiUrl: 'https://cmem.ai.evil.example/v1/chat/completions',
      model: 'custom-model',
    });
  });
});
