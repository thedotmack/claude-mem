// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { buildOpenRouterRequestBody } from '../../src/services/worker/OpenRouterProvider.js';

// #3664: a gateway that streams by default answers text/event-stream, which
// response.json() cannot read, so every observation failed. The request asks
// for one JSON body, except on the cmem gateway, whose requests stay as they
// were.

const base = {
  model: 'vendor/model',
  fallbackModels: [],
  messages: [{ role: 'user' as const, content: 'observe' }],
  maxOutputTokens: 4096,
};

describe('stream:false in the OpenRouter request body', () => {
  it('asks a custom gateway and openrouter.ai for a single JSON body', () => {
    for (const apiUrl of ['https://gateway.example/v1/chat/completions', 'https://openrouter.ai/api/v1/chat/completions']) {
      expect(buildOpenRouterRequestBody({ ...base, apiUrl }).stream).toBe(false);
    }
  });

  it('keeps it on a Telegram wrap-up too', () => {
    expect(buildOpenRouterRequestBody({ ...base, apiUrl: 'https://gateway.example/v1/chat/completions', plainText: true }).stream)
      .toBe(false);
  });

  it('leaves cmem gateway requests unchanged', () => {
    const body = buildOpenRouterRequestBody({ ...base, apiUrl: 'https://cmem.ai/api/inference/v1/chat/completions' });
    expect('stream' in body).toBe(false);
    expect(Object.keys(body)).toEqual(['model', 'messages', 'temperature', 'max_tokens']);
  });
});
