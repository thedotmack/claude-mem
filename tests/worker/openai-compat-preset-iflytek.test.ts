// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from 'bun:test';
import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// iFlytek Spark (Astron MaaS) as a preset of the openai-compatible provider.

describe('iFlytek preset', () => {
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
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stores only the streamed answer deltas, not the reasoning deltas', async () => {
    const config = {
      apiKey: 'maas-fixture',
      apiKeys: ['maas-fixture'],
      model: 'spark-x2.5',
      apiUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions',
      preset: resolveOpenAICompatPreset('iflytek'),
      requiresApiKey: true,
    };
    // Spark streams its reasoning first, in deltas of its own, then the answer.
    const events = [
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'thinking ' } }] },
      { choices: [{ delta: { reasoning_content: 'it over' } }] },
      { choices: [{ delta: { content: 'o' } }] },
      { choices: [{ delta: { content: 'k' }, finish_reason: 'stop' }] },
    ];
    const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    try {
      const result = await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<{ content: string }>;
      }).query([{ role: 'user', content: 'observe' }], config);

      expect(result.content).toBe('ok');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
