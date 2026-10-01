// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  OpenAICompatProvider,
  isOpenAICompatAvailable,
  resolveOpenAICompatConfig,
} from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// OpenCode Go and Zen as presets of the openai-compatible provider (#3623).

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('OpenCode presets', () => {
  it('points opencode-go at the Go endpoint with kimi-k3', () => {
    const preset = resolveOpenAICompatPreset('opencode-go');
    expect(preset.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(preset.defaultModel).toBe('kimi-k3');
    expect(preset.requiresApiKey).toBe(true);
  });

  it('points opencode-zen at the Zen endpoint with no default model', () => {
    const preset = resolveOpenAICompatPreset('opencode-zen');
    expect(preset.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(preset.defaultModel).toBe('');
    expect(preset.requiresApiKey).toBe(true);
  });

  describe('resolved through settings', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        process.env[key] = '';
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it('resolves the Go endpoint and default model', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opencode-go';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-opencode-key';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      expect(config.model).toBe('kimi-k3');
      expect(isOpenAICompatAvailable()).toBe(true);
    });

    it('keeps Zen unconfigured until a model is set, so dispatch falls through instead of failing', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opencode-zen';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-opencode-key';
      expect(isOpenAICompatAvailable()).toBe(false);

      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'deepseek-v4-flash';
      expect(isOpenAICompatAvailable()).toBe(true);
      expect(resolveOpenAICompatConfig().apiUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    });
  });

  it('sends a plain OpenAI body with the bearer key and no session header', async () => {
    const config = {
      apiKey: 'fixture-opencode-key',
      apiKeys: ['fixture-opencode-key'],
      model: 'kimi-k3',
      apiUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
      preset: resolveOpenAICompatPreset('opencode-go'),
      requiresApiKey: true,
    };
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    try {
      await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<unknown>;
      }).query([{ role: 'user', content: 'observe' }], config);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer fixture-opencode-key');
      expect(headers['x-opencode-session']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('kimi-k3');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
