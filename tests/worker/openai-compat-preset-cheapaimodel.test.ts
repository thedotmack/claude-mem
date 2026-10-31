// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// cheapaimodel as a preset of the openai-compatible provider.

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('cheapaimodel preset', () => {
  it('points at api.cheapaimodel.ai with a plain default model id', () => {
    const preset = resolveOpenAICompatPreset('cheapaimodel');
    expect(preset.baseUrl).toBe('https://api.cheapaimodel.ai/v1');
    expect(preset.defaultModel).toBe('deepseek-v4-1-flash');
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
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'cheapaimodel';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'sk-cam-fixture';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://api.cheapaimodel.ai/v1/chat/completions');
      expect(config.model).toBe('deepseek-v4-1-flash');
      expect(config.apiKey).toBe('sk-cam-fixture');
    });

    it('passes a model id through verbatim', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'cheapaimodel';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'sk-cam-fixture';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'glm-5.3';

      expect(resolveOpenAICompatConfig().model).toBe('glm-5.3');
    });
  });

  it('sends a plain OpenAI body with the bearer key and no attribution headers', async () => {
    const config = {
      apiKey: 'sk-cam-fixture',
      apiKeys: ['sk-cam-fixture'],
      model: 'deepseek-v4-1-flash',
      apiUrl: 'https://api.cheapaimodel.ai/v1/chat/completions',
      preset: resolveOpenAICompatPreset('cheapaimodel'),
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
      expect(url).toBe('https://api.cheapaimodel.ai/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-cam-fixture');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('deepseek-v4-1-flash');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
