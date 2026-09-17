// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_OPENCODE_GO_API_URL,
  resolveOpenCodeChatCompletionsUrl,
  classifyOpenCodeError,
} from '../../src/services/worker/OpenCodeProvider.js';

describe('OpenCodeProvider', () => {
  describe('resolveOpenCodeChatCompletionsUrl', () => {
    it('returns the default OpenCode Go URL when unset / empty', () => {
      expect(resolveOpenCodeChatCompletionsUrl(undefined)).toBe(DEFAULT_OPENCODE_GO_API_URL);
      expect(resolveOpenCodeChatCompletionsUrl(null)).toBe(DEFAULT_OPENCODE_GO_API_URL);
      expect(resolveOpenCodeChatCompletionsUrl('')).toBe(DEFAULT_OPENCODE_GO_API_URL);
      expect(resolveOpenCodeChatCompletionsUrl('   ')).toBe(DEFAULT_OPENCODE_GO_API_URL);
    });

    it('resolves OpenCode Zen base url', () => {
      expect(resolveOpenCodeChatCompletionsUrl('https://opencode.ai/zen/v1')).toBe(
        'https://opencode.ai/zen/v1/chat/completions'
      );
    });

    it('handles trailing slashes', () => {
      expect(resolveOpenCodeChatCompletionsUrl('https://opencode.ai/zen/go/v1/')).toBe(
        'https://opencode.ai/zen/go/v1/chat/completions'
      );
    });

    it('leaves full /chat/completions URL verbatim', () => {
      const full = 'https://opencode.ai/zen/go/v1/chat/completions';
      expect(resolveOpenCodeChatCompletionsUrl(full)).toBe(full);
    });
  });

  describe('classifyOpenCodeError', () => {
    it('classifies auth error for 401', () => {
      const err = classifyOpenCodeError({
        status: 401,
        bodyText: '{"error": {"message": "Invalid API key"}}',
        cause: new Error('401 Unauthorized'),
      });
      expect(err.kind).toBe('auth_invalid');
      expect(err.message).toContain('Invalid API key');
    });

    it('classifies rate limit for 429', () => {
      const err = classifyOpenCodeError({
        status: 429,
        bodyText: 'Rate limit exceeded',
        cause: new Error('429 Rate limited'),
      });
      expect(err.kind).toBe('rate_limit');
    });

    it('classifies quota exhausted', () => {
      const err = classifyOpenCodeError({
        status: 402,
        bodyText: 'insufficient credits',
        cause: new Error('402 Payment Required'),
      });
      expect(err.kind).toBe('quota_exhausted');
    });

    it('classifies 5xx upstream error as transient', () => {
      const err = classifyOpenCodeError({
        status: 502,
        bodyText: 'Bad Gateway',
        cause: new Error('502 Bad Gateway'),
      });
      expect(err.kind).toBe('transient');
    });
  });
});
