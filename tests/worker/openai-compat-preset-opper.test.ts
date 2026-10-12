// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// Opper as a preset of the openai-compatible provider.

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('Opper preset', () => {
  it('points at api.opper.ai with a pooled default model', () => {
    const preset = resolveOpenAICompatPreset('opper');
    expect(preset.baseUrl).toBe('https://api.opper.ai/v3/compat');
    expect(preset.defaultModel).toBe('gpt-5.4-mini');
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

    it('appends /chat/completions to the versioned compat base', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opper';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'opper-fixture';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://api.opper.ai/v3/compat/chat/completions');
      expect(config.model).toBe('gpt-5.4-mini');
      expect(config.apiKey).toBe('opper-fixture');
    });

    it('passes a route-pinning provider/model id through verbatim', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opper';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'opper-fixture';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'aws/claude-haiku-4-5-eu';

      expect(resolveOpenAICompatConfig().model).toBe('aws/claude-haiku-4-5-eu');
    });
  });

  it('sends a plain OpenAI body with the bearer key and no attribution headers', async () => {
    const config = {
      apiKey: 'opper-fixture',
      apiKeys: ['opper-fixture'],
      model: 'gpt-5.4-mini',
      apiUrl: 'https://api.opper.ai/v3/compat/chat/completions',
      preset: resolveOpenAICompatPreset('opper'),
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
      expect(url).toBe('https://api.opper.ai/v3/compat/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer opper-fixture');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('gpt-5.4-mini');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
