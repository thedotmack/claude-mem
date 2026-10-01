// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { isOpenAICompatAvailable, OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('API Route preset', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = '';
    }
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'api-route';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'api-route-fixture';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('requires an explicit model before becoming available', () => {
    const config = resolveOpenAICompatConfig();
    expect(config.apiUrl).toBe('https://global.api-route.com/v1/chat/completions');
    expect(config.requiresApiKey).toBe(true);
    expect(config.model).toBe('');
    expect(isOpenAICompatAvailable()).toBe(false);

    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'gpt-5.5';
    expect(isOpenAICompatAvailable()).toBe(true);
  });

  it('sends the selected model and dedicated bearer key through the shared client', async () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'gpt-5.5';
    const config = resolveOpenAICompatConfig();
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    try {
      await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<unknown>;
      }).query([{ role: 'user', content: 'observe' }], config);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://global.api-route.com/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer api-route-fixture');
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
      expect(JSON.parse(String(init.body)).model).toBe('gpt-5.5');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
