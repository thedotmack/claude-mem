// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// iFlytek Spark (Astron MaaS) as a preset of the openai-compatible provider.

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('iFlytek preset', () => {
  it('points at the pay-as-you-go MaaS endpoint with spark-x2.5', () => {
    const preset = resolveOpenAICompatPreset('iflytek');
    expect(preset.baseUrl).toBe('https://maas-api.cn-huabei-1.xf-yun.com/v2');
    expect(preset.defaultModel).toBe('spark-x2.5');
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

    it('appends /chat/completions to the /v2 base', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'iflytek';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'maas-fixture';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions');
      expect(config.model).toBe('spark-x2.5');
      expect(config.apiKey).toBe('maas-fixture');
    });

    it('keeps the preset model when a Token Plan base URL is set', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'iflytek';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'maas-fixture';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://maas-token-api.cn-huabei-1.xf-yun.com/v2';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://maas-token-api.cn-huabei-1.xf-yun.com/v2/chat/completions');
      expect(config.model).toBe('spark-x2.5');
    });
  });

  it('stores the answer, not the separate reasoning_content', async () => {
    const config = {
      apiKey: 'maas-fixture',
      apiKeys: ['maas-fixture'],
      model: 'spark-x2.5',
      apiUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions',
      preset: resolveOpenAICompatPreset('iflytek'),
      requiresApiKey: true,
    };
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok', reasoning_content: 'thinking it over' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    try {
      const result = await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<{ content: string }>;
      }).query([{ role: 'user', content: 'observe' }], config);

      expect(result.content).toBe('ok');
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer maas-fixture');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('spark-x2.5');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
