// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// PopNow as a preset of the openai-compatible provider.

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('PopNow preset', () => {
  it('points at api.popnow.ai with a task-suffixed default model', () => {
    const preset = resolveOpenAICompatPreset('popnow');
    expect(preset.baseUrl).toBe('https://api.popnow.ai/v1');
    expect(preset.defaultModel).toBe('deepseek/v4-flash/chat');
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

    it('uses the preset endpoint and default model', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'popnow';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'apikey-popnow-fixture';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://api.popnow.ai/v1/chat/completions');
      expect(config.model).toBe('deepseek/v4-flash/chat');
      expect(config.apiKey).toBe('apikey-popnow-fixture');
    });

    it('passes a task-suffixed model id through verbatim', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'popnow';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'apikey-popnow-fixture';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'moonshot/kimi-k3/chat';

      expect(resolveOpenAICompatConfig().model).toBe('moonshot/kimi-k3/chat');
    });
  });

  it('sends a plain OpenAI body with the bearer key and no attribution headers', async () => {
    const config = {
      apiKey: 'apikey-popnow-fixture',
      apiKeys: ['apikey-popnow-fixture'],
      model: 'deepseek/v4-flash/chat',
      apiUrl: 'https://api.popnow.ai/v1/chat/completions',
      preset: resolveOpenAICompatPreset('popnow'),
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
      expect(url).toBe('https://api.popnow.ai/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer apikey-popnow-fixture');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('deepseek/v4-flash/chat');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
