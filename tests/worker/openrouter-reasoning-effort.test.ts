// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildOpenRouterRequestBody,
  parseOpenRouterReasoningEffort,
  resolveOpenRouterConfig,
} from '../../src/services/worker/OpenRouterProvider.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { logger } from '../../src/utils/logger.js';

// CLAUDE_MEM_OPENROUTER_REASONING_EFFORT (#3001, #2995): a typed reasoning
// control for openrouter.ai. Unset sends nothing; it never reaches a custom
// gateway or the cmem gateway, and never overrides a wrap-up's own control.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const base = {
  model: 'vendor/model',
  fallbackModels: [],
  messages: [{ role: 'user' as const, content: 'observe' }],
  maxOutputTokens: 4096,
};

describe('buildOpenRouterRequestBody reasoning effort', () => {
  it('sends no reasoning field when unset', () => {
    expect(buildOpenRouterRequestBody({ ...base, apiUrl: OPENROUTER_URL }).reasoning).toBeUndefined();
  });

  it('maps none to enabled:false and every other value to effort', () => {
    expect(buildOpenRouterRequestBody({ ...base, apiUrl: OPENROUTER_URL, reasoningEffort: 'none' }).reasoning)
      .toEqual({ enabled: false });
    for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
      expect(buildOpenRouterRequestBody({ ...base, apiUrl: OPENROUTER_URL, reasoningEffort: effort }).reasoning)
        .toEqual({ effort });
    }
  });

  it('sends it to openrouter.ai only: never to a custom gateway or the cmem gateway', () => {
    for (const apiUrl of ['https://api.deepseek.com/chat/completions', 'https://cmem.ai/api/inference/v1/chat/completions']) {
      expect(buildOpenRouterRequestBody({ ...base, apiUrl, reasoningEffort: 'low' }).reasoning).toBeUndefined();
    }
  });

  it('wins over a reasoning field in CLAUDE_MEM_OPENROUTER_EXTRA_BODY, keeping the rest of it', () => {
    const body = buildOpenRouterRequestBody({
      ...base,
      apiUrl: OPENROUTER_URL,
      reasoningEffort: 'low',
      extraBody: { reasoning: { effort: 'high' }, provider: { sort: 'price' } },
    });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.provider).toEqual({ sort: 'price' });
  });

  it('leaves the extra body\'s reasoning alone when the typed setting is unset', () => {
    const body = buildOpenRouterRequestBody({
      ...base,
      apiUrl: OPENROUTER_URL,
      extraBody: { reasoning: { enabled: false } },
    });
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it('never overrides a Telegram wrap-up\'s own reasoning control', () => {
    const body = buildOpenRouterRequestBody({ ...base, apiUrl: OPENROUTER_URL, plainText: true, reasoningEffort: 'high' });
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.response_format).toEqual({ type: 'text' });
  });
});

describe('parseOpenRouterReasoningEffort', () => {
  it('accepts the documented values, case-insensitively', () => {
    expect(parseOpenRouterReasoningEffort('LOW')).toBe('low');
    expect(parseOpenRouterReasoningEffort(' none ')).toBe('none');
  });

  it('reads anything else as unset', () => {
    for (const raw of ['', 'off', 'xhigh', undefined, 3]) {
      expect(parseOpenRouterReasoningEffort(raw)).toBeUndefined();
    }
  });
});

describe('resolveOpenRouterConfig reads the reasoning effort', () => {
  const ENV_KEYS = [
    'CLAUDE_MEM_OPENROUTER_API_KEY',
    'CLAUDE_MEM_OPENROUTER_BASE_URL',
    'CLAUDE_MEM_OPENROUTER_MODEL',
    'CLAUDE_MEM_OPENROUTER_REASONING_EFFORT',
    'OPENROUTER_BASE_URL',
    'CLAUDE_MEM_ENV_FILE',
    'CMEM_PRO_ORIGIN',
  ];
  let tempDir: string;
  let settingsPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-reasoning-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  const writeSettings = (settings: Record<string, unknown>) =>
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', ...settings }));

  it('carries a valid value', () => {
    writeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-personal', CLAUDE_MEM_OPENROUTER_REASONING_EFFORT: 'minimal' });
    expect(resolveOpenRouterConfig(settingsPath).reasoningEffort).toBe('minimal');
  });

  it('ignores an invalid value with one warning, never throwing on a status poll', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      writeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-personal', CLAUDE_MEM_OPENROUTER_REASONING_EFFORT: 'turbo' });
      expect(resolveOpenRouterConfig(settingsPath).reasoningEffort).toBeUndefined();
      expect(resolveOpenRouterConfig(settingsPath).reasoningEffort).toBeUndefined();
      expect(warn.mock.calls.filter(call => String(call[1]).includes('REASONING_EFFORT')).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('attaches nothing for the cmem gateway tuple', () => {
    writeSettings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_0123456789abcdef01234567',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
      CLAUDE_MEM_OPENROUTER_REASONING_EFFORT: 'none',
    });
    expect(resolveOpenRouterConfig(settingsPath).reasoningEffort).toBeUndefined();
  });
});

describe('the settings API validates the reasoning effort', () => {
  const validate = (value: string) => (new SettingsRoutes({} as never) as unknown as {
    validateSettings(settings: unknown): { valid: boolean; error?: string };
  }).validateSettings({ CLAUDE_MEM_OPENROUTER_REASONING_EFFORT: value });

  it('accepts empty and the documented values', () => {
    for (const value of ['', 'none', 'minimal', 'low', 'medium', 'high']) expect(validate(value).valid).toBe(true);
  });

  it('rejects anything else with the allowed values', () => {
    const result = validate('turbo');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('none, minimal, low, medium, high');
  });
});
