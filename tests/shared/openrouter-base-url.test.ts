// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_OPENROUTER_API_URL,
  resolveOpenRouterChatCompletionsUrl,
} from '../../src/shared/openrouter-base-url.js';

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
});
