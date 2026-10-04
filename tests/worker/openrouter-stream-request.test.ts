// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { buildOpenRouterRequestBody } from '../../src/services/worker/OpenRouterProvider.js';

// Liveness over deadlines (Phase 3): requests are streamed, so tokens and `:`
// pings prove the backend is alive, and the reply is assembled back into one
// chat.completion. Usage arrives on the final chunk only when asked for. The
// cmem gateway answers with one JSON body whatever is asked, and its requests
// stay exactly as they were.

const base = {
  model: 'vendor/model',
  fallbackModels: [],
  messages: [{ role: 'user' as const, content: 'observe' }],
  maxOutputTokens: 4096,
};

describe('streaming fields in the OpenRouter request body', () => {
  it('asks a custom gateway and openrouter.ai for a stream with usage', () => {
    for (const apiUrl of ['https://gateway.example/v1/chat/completions', 'https://openrouter.ai/api/v1/chat/completions']) {
      const body = buildOpenRouterRequestBody({ ...base, apiUrl });
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    }
  });

  it('keeps it on a Telegram wrap-up too', () => {
    expect(buildOpenRouterRequestBody({ ...base, apiUrl: 'https://gateway.example/v1/chat/completions', plainText: true }).stream)
      .toBe(true);
  });

  it('leaves cmem gateway requests unchanged', () => {
    const body = buildOpenRouterRequestBody({ ...base, apiUrl: 'https://cmem.ai/api/inference/v1/chat/completions' });
    expect('stream' in body).toBe(false);
    expect(Object.keys(body)).toEqual(['model', 'messages', 'temperature', 'max_tokens']);
  });
});
