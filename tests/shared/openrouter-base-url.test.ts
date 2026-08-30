// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_OPENROUTER_API_URL,
  isHttpUrl,
  resolveOpenRouterChatCompletionsUrl,
} from '../../src/shared/openrouter-base-url.js';

const KEYED_BASE_URL = 'https://api.example.com/v1?key=abc';
const KEYED_CHAT_COMPLETIONS_URL = 'https://api.example.com/v1/chat/completions?key=abc';

describe('resolveOpenRouterChatCompletionsUrl', () => {
  it('returns the default OpenRouter URL when unset (undefined)', () => {
    expect(resolveOpenRouterChatCompletionsUrl(undefined)).toBe(DEFAULT_OPENROUTER_API_URL);
  });

  it('returns the default OpenRouter URL when null', () => {
    expect(resolveOpenRouterChatCompletionsUrl(null)).toBe(DEFAULT_OPENROUTER_API_URL);
  });

  it('returns the default OpenRouter URL for empty / whitespace string', () => {
    expect(resolveOpenRouterChatCompletionsUrl('')).toBe(DEFAULT_OPENROUTER_API_URL);
    expect(resolveOpenRouterChatCompletionsUrl('   ')).toBe(DEFAULT_OPENROUTER_API_URL);
  });

  it('appends /chat/completions to a base URL (DeepSeek style)', () => {
    expect(resolveOpenRouterChatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });

  it('appends /chat/completions to a versioned base (LM Studio style)', () => {
    expect(resolveOpenRouterChatCompletionsUrl('http://localhost:1234/v1')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
  });

  it('uses a full /chat/completions URL verbatim', () => {
    const full = 'https://api.deepseek.com/v1/chat/completions';
    expect(resolveOpenRouterChatCompletionsUrl(full)).toBe(full);
  });

  it('normalizes trailing slashes before appending', () => {
    expect(resolveOpenRouterChatCompletionsUrl('http://localhost:1234/v1/')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
    expect(resolveOpenRouterChatCompletionsUrl('http://localhost:1234/v1///')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
  });

  it('normalizes a trailing slash on a full chat/completions URL', () => {
    expect(resolveOpenRouterChatCompletionsUrl('https://x.example.com/v1/chat/completions/')).toBe(
      'https://x.example.com/v1/chat/completions',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(resolveOpenRouterChatCompletionsUrl('  https://api.deepseek.com  ')).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });

  it('matches the /chat/completions suffix case-insensitively', () => {
    const mixed = 'https://x.example.com/v1/Chat/Completions';
    expect(resolveOpenRouterChatCompletionsUrl(mixed)).toBe(mixed);
  });

  it('keeps the chat-completions suffix in the path when the base URL has a query string', () => {
    expect(resolveOpenRouterChatCompletionsUrl(KEYED_BASE_URL)).toBe(KEYED_CHAT_COMPLETIONS_URL);
  });

  it('keeps the chat-completions suffix in the path when the base URL has a fragment', () => {
    expect(resolveOpenRouterChatCompletionsUrl('https://api.example.com/v1#frag')).toBe(
      'https://api.example.com/v1/chat/completions#frag',
    );
  });

  it('normalizes a trailing slash before the query string', () => {
    expect(resolveOpenRouterChatCompletionsUrl('https://api.example.com/v1/?key=abc')).toBe(
      KEYED_CHAT_COMPLETIONS_URL,
    );
  });

  it('preserves the query string on a base URL already ending in /chat/completions', () => {
    expect(resolveOpenRouterChatCompletionsUrl(KEYED_CHAT_COMPLETIONS_URL)).toBe(
      KEYED_CHAT_COMPLETIONS_URL,
    );
  });

  it('returns the origin in canonical form (lower-cased host, default port dropped)', () => {
    expect(resolveOpenRouterChatCompletionsUrl('https://API.EXAMPLE.com:443/v1')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('only accepts HTTP(S) URLs for custom endpoints', () => {
    expect(isHttpUrl('https://api.deepseek.com')).toBe(true);
    expect(isHttpUrl('http://localhost:1234/v1')).toBe(true);
    expect(isHttpUrl('ftp://example.com/v1')).toBe(false);
    expect(isHttpUrl('file:///tmp/openrouter')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });

  it('rejects unsupported custom endpoint protocols before fetch', () => {
    expect(() => resolveOpenRouterChatCompletionsUrl('ftp://example.com/v1')).toThrow(
      'OpenRouter base URL must use http or https',
    );
  });
});
