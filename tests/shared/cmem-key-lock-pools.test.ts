// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { keysForEndpoint } from '../../src/shared/cmem-gateway.js';
import { GeminiProvider, isGeminiAvailable } from '../../src/services/worker/GeminiProvider.js';
import { resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenRouterConfig } from '../../src/services/worker/OpenRouterProvider.js';

// Wave 3 gate R4-7: the cm_pro_ key lock (#4276) held per provider, not for
// every pool. openai-compatible pointed at the gateway pooled several account
// keys, and the Gemini pool sent a pasted cm_pro_ key to Google as ?key=. One
// rule now covers every pool: on the cmem gateway, the first cm_pro_ key and
// never a pool; on any other host, no cm_pro_ key at all.

const GATEWAY = 'https://cmem.ai/api/inference/v1';
const CM_A = 'cm_pro_0123456789abcdef01234567';
const CM_B = 'cm_pro_89abcdef0123456789abcdef';

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_GEMINI_API_KEY', 'CLAUDE_MEM_GEMINI_API_KEYS', 'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
  'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEYS', 'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET', 'CLAUDE_MEM_OPENAI_COMPAT_API_KEY', 'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
  'CMEM_PRO_ORIGIN', 'OPENROUTER_BASE_URL',
];

describe('keysForEndpoint', () => {
  it('gives the gateway the first account key only, never a pool and never a personal key', () => {
    expect(keysForEndpoint(`${GATEWAY}/chat/completions`, ['sk-personal', CM_A, CM_B])).toEqual([CM_A]);
    expect(keysForEndpoint(`${GATEWAY}/chat/completions`, ['sk-personal'])).toEqual([]);
  });

  it('gives every other host the non-account keys, in order', () => {
    expect(keysForEndpoint('https://generativelanguage.googleapis.com/v1beta/models', [CM_A, 'AIza-1', CM_B, 'AIza-2']))
      .toEqual(['AIza-1', 'AIza-2']);
  });
});

describe('every provider pool goes through the lock', () => {
  let saved: Record<string, string | undefined>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('openai-compatible on the gateway uses one account key, not a rotation through several', () => {
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = GATEWAY;
    process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'cmem-observer';
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = CM_A;
    process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS = CM_B;

    expect(resolveOpenAICompatConfig().apiKeys).toEqual([CM_A]);
  });

  it('never sends a cm_pro_ key from the Gemini pool to Google', async () => {
    process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEYS = `${CM_A}\nAIza-real-key`;
    process.env.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED = 'false';
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 });
    }) as typeof fetch;

    const provider = new GeminiProvider(null as never, null as never) as unknown as {
      query(h: unknown[], c: unknown): Promise<unknown>;
      getConfig(): { apiKey: string; apiKeys: string[] };
    };
    const config = provider.getConfig();
    expect(config.apiKeys).toEqual(['AIza-real-key']);
    expect(config.apiKey).toBe('AIza-real-key');
    await provider.query([{ role: 'user', content: 'hi' }], config);

    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain('cm_pro_');
  });

  it('treats a Gemini setup holding only an account key as unconfigured', () => {
    process.env.CLAUDE_MEM_GEMINI_API_KEY = CM_A;
    process.env.CLAUDE_MEM_GEMINI_API_KEYS = CM_B;
    expect(isGeminiAvailable()).toBe(false);
  });

  it('keeps OpenRouter as it was: one key on the gateway, no account keys elsewhere', () => {
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = GATEWAY;
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = CM_A;
    process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = CM_B;
    expect(resolveOpenRouterConfig().apiKeys).toEqual([CM_A]);

    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-v1-personal';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = `${CM_A},sk-or-v1-second`;
    expect(resolveOpenRouterConfig().apiKeys).toEqual(['sk-or-v1-personal', 'sk-or-v1-second']);
  });
});
