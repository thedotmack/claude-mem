import { describe, expect, test } from 'bun:test';
import { addUsage, classifyError, emptyUsage, OpenRouterProvider, parseRetryAfterMs } from '../src/openrouter.ts';
import type { OpenRouterConfig } from '../src/config.ts';

const baseConfig: OpenRouterConfig = {
  apiKey: 'sk-test',
  model: 'anthropic/claude-sonnet-4.5',
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
  siteUrl: 'https://example.com',
  appName: 'test',
  temperature: 0,
  maxTokens: 1024,
};

describe('classifyError', () => {
  test('quota markers win over status', () => {
    expect(classifyError(200, 'insufficient credits').kind).toBe('quota');
  });
  test('429 → rate_limit', () => {
    expect(classifyError(429, '').kind).toBe('rate_limit');
  });
  test('401/403 → auth', () => {
    expect(classifyError(401, '').kind).toBe('auth');
    expect(classifyError(403, '').kind).toBe('auth');
  });
  test('5xx → transient', () => {
    expect(classifyError(503, '').kind).toBe('transient');
  });
  test('no status → transient (network)', () => {
    expect(classifyError(undefined, 'ECONNRESET').kind).toBe('transient');
  });
});

describe('parseRetryAfterMs', () => {
  test('seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });
  test('missing', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe('usage helpers', () => {
  test('addUsage sums and preserves cost presence', () => {
    const a = { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.1 };
    const b = { inputTokens: 4, outputTokens: 5, totalTokens: 9 };
    const sum = addUsage(a, b);
    expect(sum.totalTokens).toBe(12);
    expect(sum.costUsd).toBeCloseTo(0.1);
  });
  test('emptyUsage has no cost', () => {
    expect(emptyUsage().costUsd).toBeUndefined();
  });
});

describe('OpenRouterProvider.complete', () => {
  test('missing key throws auth error', async () => {
    const provider = new OpenRouterProvider({ ...baseConfig, apiKey: '' });
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow(/API key/);
  });

  test('parses tool_calls and usage', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: 'anthropic/claude-sonnet-4.5',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.002 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = new OpenRouterProvider(baseConfig, { maxAttempts: 1, baseDelayMs: 1 }, fetchImpl);
    const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(res.message.tool_calls?.[0]?.function.name).toBe('bash');
    expect(res.usage.totalTokens).toBe(14);
    expect(res.usage.costUsd).toBeCloseTo(0.002);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('retries on 429 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenRouterProvider(baseConfig, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }, fetchImpl);
    const res = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(calls).toBe(2);
    expect(res.message.content).toBe('ok');
  });

  test('gives up on auth error without retrying', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('bad key', { status: 401 });
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider(baseConfig, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }, fetchImpl);
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow(/auth/);
    expect(calls).toBe(1);
  });
});
