// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// OrcaRouter as a preset of the openai-compatible provider (#3581).

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('OrcaRouter preset', () => {
  it('points at api.orcarouter.ai with a model from its catalog', () => {
    const preset = resolveOpenAICompatPreset('orcarouter');
    expect(preset.baseUrl).toBe('https://api.orcarouter.ai/v1');
    expect(preset.defaultModel).toBe('openai/gpt-4o-mini');
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
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'orcarouter';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'sk-orca-fixture';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://api.orcarouter.ai/v1/chat/completions');
      expect(config.model).toBe('openai/gpt-4o-mini');
      expect(config.apiKey).toBe('sk-orca-fixture');
    });

    it('passes a provider-scoped model id through verbatim', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'orcarouter';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'sk-orca-fixture';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'anthropic/claude-haiku-4.5';

      expect(resolveOpenAICompatConfig().model).toBe('anthropic/claude-haiku-4.5');
    });
  });

  it('sends a plain OpenAI body with the bearer key and no attribution headers', async () => {
    const config = {
      apiKey: 'sk-orca-fixture',
      apiKeys: ['sk-orca-fixture'],
      model: 'openai/gpt-4o-mini',
      apiUrl: 'https://api.orcarouter.ai/v1/chat/completions',
      preset: resolveOpenAICompatPreset('orcarouter'),
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
      expect(url).toBe('https://api.orcarouter.ai/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-orca-fixture');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('openai/gpt-4o-mini');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
