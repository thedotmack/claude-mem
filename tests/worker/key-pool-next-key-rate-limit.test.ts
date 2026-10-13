// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resetKeyPoolStateForTesting } from '../../src/shared/api-key-pool.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';

// Wave 3 gate R4-8: a two-key pool where key one was throttled a moment ago
// and key two is now spent. The pool used to rethrow key two's error, and a
// quota error arms the provider breaker for 30 minutes although key one is
// back within a minute. Every pooled provider now reports a rate limit that
// lasts until key one frees, so the session resumes then.

const ENV_KEYS = [
  'CLAUDE_MEM_GEMINI_API_KEY', 'CLAUDE_MEM_GEMINI_API_KEYS', 'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
  'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEYS', 'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET', 'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY', 'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
];

type Reply = 'throttled' | 'spent' | 'ok';

interface PooledProvider {
  getConfig(): unknown;
  query(history: unknown[], config: unknown): Promise<unknown>;
}

const CASES: Array<{
  name: string;
  env: Record<string, string>;
  keyOf: (url: string, init: RequestInit | undefined) => string;
  respond: (reply: Reply) => Response;
  make: () => PooledProvider;
}> = [
  {
    name: 'Gemini',
    env: {
      CLAUDE_MEM_GEMINI_API_KEY: 'gemini-key-one',
      CLAUDE_MEM_GEMINI_API_KEYS: 'gemini-key-two',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
    },
    keyOf: url => new URL(url).searchParams.get('key') ?? '',
    respond: reply => reply === 'ok'
      ? Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
      : reply === 'throttled'
        ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } })
        : new Response('API key not valid. Please pass a valid API key.', { status: 403 }),
    make: () => new GeminiProvider(null as never, null as never) as unknown as PooledProvider,
  },
  {
    name: 'OpenRouter',
    env: {
      CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-key-one',
      CLAUDE_MEM_OPENROUTER_API_KEYS: 'sk-or-key-two',
    },
    keyOf: (_url, init) => String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', ''),
    respond: reply => reply === 'ok'
      ? Response.json({ choices: [{ message: { content: 'ok' } }] })
      : reply === 'throttled'
        ? new Response('Rate limit exceeded', { status: 429, headers: { 'retry-after': '60' } })
        : new Response('Insufficient credits', { status: 402 }),
    make: () => new OpenRouterProvider(null as never, null as never) as unknown as PooledProvider,
  },
  {
    name: 'openai-compatible',
    env: {
      CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://api.example.test/v1',
      CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'example-model',
      CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'compat-key-one',
      CLAUDE_MEM_OPENAI_COMPAT_API_KEYS: 'compat-key-two',
    },
    keyOf: (_url, init) => String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', ''),
    respond: reply => reply === 'ok'
      ? Response.json({ choices: [{ message: { content: 'ok' } }] })
      : reply === 'throttled'
        ? new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60' } })
        : new Response('', { status: 402 }),
    make: () => new OpenAICompatProvider(null as never, null as never) as unknown as PooledProvider,
  },
];

describe('a pooled provider whose other key frees soon reports a rate limit, not the spent key', () => {
  let saved: Record<string, string | undefined>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetKeyPoolStateForTesting();
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetKeyPoolStateForTesting();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  for (const testCase of CASES) {
    it(testCase.name, async () => {
      Object.assign(process.env, testCase.env);
      const [keyOne, keyTwo] = Object.values(testCase.env).filter(value => value.includes('key-'));
      let request = 1;
      const sent: string[] = [];
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const key = testCase.keyOf(String(url), init);
        sent.push(`${request}:${key}`);
        if (key === keyOne) return testCase.respond('throttled');
        return testCase.respond(request === 1 ? 'ok' : 'spent');
      }) as typeof fetch;

      const provider = testCase.make();
      const history = [{ role: 'user', content: 'hi' }];
      await provider.query(history, provider.getConfig());

      request = 2;
      let thrown: unknown;
      try {
        await provider.query(history, provider.getConfig());
      } catch (error) {
        thrown = error;
      }

      expect(sent).toEqual([`1:${keyOne}`, `1:${keyTwo}`, `2:${keyTwo}`]);
      expect(thrown).toBeInstanceOf(ClassifiedProviderError);
      expect((thrown as ClassifiedProviderError).kind).toBe('rate_limit');
      expect((thrown as ClassifiedProviderError).retryAfterMs).toBeGreaterThan(50_000);
      expect((thrown as ClassifiedProviderError).retryAfterMs).toBeLessThanOrEqual(60_000);
    });
  }
});
