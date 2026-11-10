// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_OPENROUTER_API_URL,
  isHttpUrl,
  resolveOpenRouterChatCompletionsUrl,
} from '../../src/shared/openrouter-base-url.js';
import { isCmemGatewayUrl } from '../../src/shared/cmem-gateway.js';

const KEYED_BASE_URL = 'https://api.example.com/v1?key=abc';
const KEYED_CHAT_COMPLETIONS_URL = 'https://api.example.com/v1/chat/completions?key=abc';

describe('resolveOpenRouterChatCompletionsUrl', () => {
  it.each([
    [undefined, DEFAULT_OPENROUTER_API_URL],
    [null, DEFAULT_OPENROUTER_API_URL],
    ['', DEFAULT_OPENROUTER_API_URL],
    ['   ', DEFAULT_OPENROUTER_API_URL],
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
    ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1/chat/completions'],
    ['http://localhost:1234/v1///', 'http://localhost:1234/v1/chat/completions'],
    ['https://x.example.com/v1/chat/completions/', 'https://x.example.com/v1/chat/completions'],
    ['  https://api.deepseek.com  ', 'https://api.deepseek.com/chat/completions'],
    ['https://x.example.com/v1/Chat/Completions', 'https://x.example.com/v1/Chat/Completions'],
    [KEYED_BASE_URL, KEYED_CHAT_COMPLETIONS_URL],
    ['https://api.example.com/v1#frag', 'https://api.example.com/v1/chat/completions#frag'],
    ['https://api.example.com/v1/?key=abc', KEYED_CHAT_COMPLETIONS_URL],
    [KEYED_CHAT_COMPLETIONS_URL, KEYED_CHAT_COMPLETIONS_URL],
    ['https://API.EXAMPLE.com:443/v1', 'https://api.example.com/v1/chat/completions'],
    ['api.deepseek.com/v1', 'api.deepseek.com/v1/chat/completions'],
    ['ftp://example.com/v1', 'ftp://example.com/v1/chat/completions'],
    ['ftp://example.com/v1/', 'ftp://example.com/v1/chat/completions'],
  ])('resolves %s to %s', (input, expected) => {
    expect(resolveOpenRouterChatCompletionsUrl(input)).toBe(expected);
  });

  it('only accepts HTTP(S) URLs for custom endpoints', () => {
    expect(isHttpUrl('https://api.deepseek.com')).toBe(true);
    expect(isHttpUrl('http://localhost:1234/v1')).toBe(true);
    expect(isHttpUrl('ftp://example.com/v1')).toBe(false);
    expect(isHttpUrl('file:///tmp/openrouter')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

});

describe('the canonical URL still identifies the cmem gateway', () => {
  const withOrigin = (origin: string | undefined, run: () => void) => {
    const saved = process.env.CMEM_PRO_ORIGIN;
    if (origin === undefined) delete process.env.CMEM_PRO_ORIGIN;
    else process.env.CMEM_PRO_ORIGIN = origin;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.CMEM_PRO_ORIGIN;
      else process.env.CMEM_PRO_ORIGIN = saved;
    }
  };

  it('for the production gateway, whatever the host case or explicit default port', () => {
    withOrigin(undefined, () => {
      for (const base of ['https://cmem.ai/api/inference/v1', 'https://CMEM.ai:443/api/inference/v1/']) {
        expect(isCmemGatewayUrl(resolveOpenRouterChatCompletionsUrl(base))).toBe(true);
      }
    });
  });

  it('for a dev gateway whose CMEM_PRO_ORIGIN carries a base path', () => {
    withOrigin('http://localhost:3005/mock', () => {
      const apiUrl = resolveOpenRouterChatCompletionsUrl('http://localhost:3005/mock/api/inference/v1');
      expect(apiUrl).toBe('http://localhost:3005/mock/api/inference/v1/chat/completions');
      expect(isCmemGatewayUrl(apiUrl)).toBe(true);
    });
  });
});
