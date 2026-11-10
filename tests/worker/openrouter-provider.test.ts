import { describe, expect, it } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';

describe('OpenRouterProvider token compatibility', () => {

  // The non-streamed (cmem gateway) request is the one this module calls fetch
  // for; a streamed request goes through worker-utils' fetchStreamWithIdleTimeout.
  it('invokes the runtime fetch with globalThis as its receiver', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: typeof globalThis, _input, init) {
      if (this !== globalThis) {
        return Promise.reject(new Error('fetch receiver was not globalThis'));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 }));
    } as typeof fetch;

    try {
      const provider = new OpenRouterProvider({} as never, {} as never);
      const result = await (provider as any).query(
        [{ role: 'user', content: 'hello' }],
        { apiKey: 'fake', model: 'gpt-5', fallbackModels: [], apiUrl: 'https://cmem.ai/api/inference/v1/chat/completions' },
      );

      expect(result.content).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
