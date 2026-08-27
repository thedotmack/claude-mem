import { describe, expect, it } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';

const compatibilityError = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";

describe('OpenRouterProvider token compatibility', () => {
  it('retries the exact issue response and returns the provider result', async () => {
    const originalFetch = globalThis.fetch;
    const requests: RequestInit[] = [];
    const responses = [
      new Response(JSON.stringify({ error: { message: compatibilityError } }), { status: 400 }),
      new Response(JSON.stringify({ choices: [{ message: { content: '<observation>ok</observation>' } }], usage: { total_tokens: 7 } }), { status: 200 }),
    ];
    globalThis.fetch = (async (_input, init) => {
      requests.push(init ?? {});
      return responses.shift()!;
    }) as typeof fetch;

    try {
      const provider = new OpenRouterProvider({} as never, {} as never);
      const result = await (provider as any).query(
        [{ role: 'user', content: 'hello' }],
        { apiKey: 'fake', model: 'gpt-5', apiUrl: 'https://gateway.test/v1/chat/completions' },
      );

      expect(result.content).toBe('<observation>ok</observation>');
      expect(requests).toHaveLength(2);
      const first = JSON.parse(String(requests[0].body)) as Record<string, unknown>;
      const second = JSON.parse(String(requests[1].body)) as Record<string, unknown>;
      expect(first.max_tokens).toBe(4096);
      expect(second.max_completion_tokens).toBe(4096);
      expect(second.max_tokens).toBeUndefined();
      expect(second.model).toBe(first.model);
      expect(second.messages).toEqual(first.messages);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry a similar incomplete compatibility response', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported" } }), { status: 400 });
    }) as typeof fetch;

    try {
      const provider = new OpenRouterProvider({} as never, {} as never);
      await expect((provider as any).query([{ role: 'user', content: 'hello' }], {
        apiKey: 'fake', model: 'gpt-5', apiUrl: 'https://gateway.test/v1/chat/completions',
      })).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
