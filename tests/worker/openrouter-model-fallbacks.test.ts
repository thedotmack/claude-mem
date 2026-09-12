// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildOpenRouterRequestBody,
  isOpenRouterApiUrl,
  resolveOpenRouterConfig,
} from '../../src/services/worker/OpenRouterProvider.js';
import { DEFAULT_OPENROUTER_API_URL } from '../../src/shared/openrouter-base-url.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const ENV_KEYS = [
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'OPENROUTER_BASE_URL',
  'CLAUDE_MEM_ENV_FILE',
  'CMEM_PRO_ORIGIN',
] as const;

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('CLAUDE_MEM_OPENROUTER_MODEL as a fallback list', () => {
  let tempDir: string;
  let settingsPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  const write = (model: unknown): void => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-personal',
      CLAUDE_MEM_OPENROUTER_MODEL: model,
    }));
  };

  it('keeps a single model id exactly as it is today, with no fallbacks', () => {
    write('vendor/model-a');
    const config = resolveOpenRouterConfig(settingsPath);
    expect(config.model).toBe('vendor/model-a');
    expect(config.fallbackModels).toEqual([]);
  });

  it('takes the first array entry as the model and the rest as fallbacks', () => {
    write(['vendor/model-a', 'vendor/model-b', 'vendor/model-c']);
    const config = resolveOpenRouterConfig(settingsPath);
    expect(config.model).toBe('vendor/model-a');
    expect(config.fallbackModels).toEqual(['vendor/model-b', 'vendor/model-c']);
  });

  it('never comma-joins an array into one unusable model id', () => {
    write(['vendor/model-a', 'vendor/model-b']);
    expect(resolveOpenRouterConfig(settingsPath).model).not.toContain(',');
  });

  it('splits a comma- or newline-separated string, which is equally unusable as one id', () => {
    write('vendor/model-a, vendor/model-b');
    const config = resolveOpenRouterConfig(settingsPath);
    expect(config.model).toBe('vendor/model-a');
    expect(config.fallbackModels).toEqual(['vendor/model-b']);
  });

  it('drops blanks and duplicates rather than spending a fallback slot on them', () => {
    write(['vendor/model-a', '', '  ', 'vendor/model-a', 'vendor/model-b']);
    const config = resolveOpenRouterConfig(settingsPath);
    expect(config.model).toBe('vendor/model-a');
    expect(config.fallbackModels).toEqual(['vendor/model-b']);
  });

  it('falls back to the shipped default for an empty or unusable setting', () => {
    const shipped = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL;
    for (const raw of [[], '', '   ', ',,', 42]) {
      write(raw);
      const config = resolveOpenRouterConfig(settingsPath);
      expect(config.model).toBe(shipped);
      expect(config.fallbackModels).toEqual([]);
    }
  });
});

describe('buildOpenRouterRequestBody', () => {
  it('sends a bare model field when there is no fallback list — the unchanged path', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: [],
      messages: MESSAGES,
      apiUrl: DEFAULT_OPENROUTER_API_URL,
    });
    expect(body.model).toBe('vendor/model-a');
    expect(body).not.toHaveProperty('models');
  });

  it('sends models[] in priority order and NO model field when fallbacks exist', () => {
    // OpenRouter's documented shape: the array replaces `model`, and entries
    // are tried in order.
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: ['vendor/model-b', 'vendor/model-c'],
      messages: MESSAGES,
      apiUrl: DEFAULT_OPENROUTER_API_URL,
    });
    expect(body.models).toEqual(['vendor/model-a', 'vendor/model-b', 'vendor/model-c']);
    expect(body).not.toHaveProperty('model');
  });

  it('keeps a single model field for a non-openrouter.ai gateway, which may reject models[]', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
      messages: MESSAGES,
      apiUrl: 'https://gateway.example.com/v1/chat/completions',
    });
    expect(body.model).toBe('vendor/model-a');
    expect(body).not.toHaveProperty('models');
  });

  it('keeps the usage-accounting flag gated on openrouter.ai exactly as before', () => {
    const onOpenRouter = buildOpenRouterRequestBody({
      model: 'vendor/model-a', fallbackModels: [], messages: MESSAGES, apiUrl: DEFAULT_OPENROUTER_API_URL,
    });
    const elsewhere = buildOpenRouterRequestBody({
      model: 'vendor/model-a', fallbackModels: [], messages: MESSAGES, apiUrl: 'https://gateway.example.com/v1/chat/completions',
    });
    expect(onOpenRouter.usage).toEqual({ include: true });
    expect(elsewhere).not.toHaveProperty('usage');
  });

  it('sends OpenRouter fields for https://openrouter.ai/... when fallbacks exist', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
      messages: MESSAGES,
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    });
    expect(body.models).toEqual(['vendor/model-a', 'vendor/model-b']);
    expect(body.usage).toEqual({ include: true });
    expect(body).not.toHaveProperty('model');
  });

  it('treats a path containing openrouter.ai on a different host as a custom gateway', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
      messages: MESSAGES,
      apiUrl: 'https://gateway.example.com/proxy/openrouter.ai/v1/chat/completions',
    });
    expect(body.model).toBe('vendor/model-a');
    expect(body).not.toHaveProperty('models');
    expect(body).not.toHaveProperty('usage');
  });

  it('treats a lookalike hostname as a custom gateway', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
      messages: MESSAGES,
      apiUrl: 'https://openrouter.ai.evil.example/v1/chat/completions',
    });
    expect(body.model).toBe('vendor/model-a');
    expect(body).not.toHaveProperty('models');
    expect(body).not.toHaveProperty('usage');
  });

  it('treats a malformed URL as a custom gateway (model only)', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a',
      fallbackModels: ['vendor/model-b'],
      messages: MESSAGES,
      apiUrl: 'not a url',
    });
    expect(body.model).toBe('vendor/model-a');
    expect(body).not.toHaveProperty('models');
    expect(body).not.toHaveProperty('usage');
  });

  it('carries the existing sampling parameters unchanged', () => {
    const body = buildOpenRouterRequestBody({
      model: 'vendor/model-a', fallbackModels: [], messages: MESSAGES, apiUrl: DEFAULT_OPENROUTER_API_URL,
    });
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual(MESSAGES);
  });
});

describe('isOpenRouterApiUrl', () => {
  it('matches the real openrouter.ai hostname, case-insensitively', () => {
    expect(isOpenRouterApiUrl(DEFAULT_OPENROUTER_API_URL)).toBe(true);
    expect(isOpenRouterApiUrl('https://OpenRouter.AI/api/v1/chat/completions')).toBe(true);
  });

  it('rejects path-text, lookalike hosts, and malformed URLs', () => {
    expect(isOpenRouterApiUrl('https://gateway.example.com/proxy/openrouter.ai/v1/chat/completions')).toBe(false);
    expect(isOpenRouterApiUrl('https://openrouter.ai.evil.example/v1/chat/completions')).toBe(false);
    expect(isOpenRouterApiUrl('not a url')).toBe(false);
  });
});
