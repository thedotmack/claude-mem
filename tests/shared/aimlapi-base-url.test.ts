// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  AIMLAPI_DEFAULT_BASE_URL,
  DEFAULT_AIMLAPI_API_URL,
  resolveAimlapiChatCompletionsUrl,
} from '../../src/shared/aimlapi-base-url.js';

describe('aimlapi.com default endpoint', () => {
  // aimlapi.com serves the OpenAI-compatible surface under /v1. The /v2 prefix
  // on the same host is billing/usage only and 404s for chat completions, so
  // pinning this guards against a plausible-looking wrong default.
  it('points at the /v1 surface', () => {
    expect(AIMLAPI_DEFAULT_BASE_URL).toBe('https://api.aimlapi.com/v1');
    expect(DEFAULT_AIMLAPI_API_URL).toBe('https://api.aimlapi.com/v1/chat/completions');
  });
});

describe('resolveAimlapiChatCompletionsUrl', () => {
  it('returns the default URL when unset (undefined)', () => {
    expect(resolveAimlapiChatCompletionsUrl(undefined)).toBe(DEFAULT_AIMLAPI_API_URL);
  });

  it('returns the default URL when null', () => {
    expect(resolveAimlapiChatCompletionsUrl(null)).toBe(DEFAULT_AIMLAPI_API_URL);
  });

  it('returns the default URL for empty / whitespace string', () => {
    expect(resolveAimlapiChatCompletionsUrl('')).toBe(DEFAULT_AIMLAPI_API_URL);
    expect(resolveAimlapiChatCompletionsUrl('   ')).toBe(DEFAULT_AIMLAPI_API_URL);
  });

  it('appends /chat/completions to a versioned base', () => {
    expect(resolveAimlapiChatCompletionsUrl('https://api.aimlapi.com/v1')).toBe(
      'https://api.aimlapi.com/v1/chat/completions',
    );
  });

  it('uses a full chat-completions URL verbatim', () => {
    expect(
      resolveAimlapiChatCompletionsUrl('https://api.aimlapi.com/v1/chat/completions'),
    ).toBe('https://api.aimlapi.com/v1/chat/completions');
  });

  it('normalizes trailing slashes', () => {
    expect(resolveAimlapiChatCompletionsUrl('https://api.aimlapi.com/v1/')).toBe(
      'https://api.aimlapi.com/v1/chat/completions',
    );
    expect(resolveAimlapiChatCompletionsUrl('https://api.aimlapi.com/v1///')).toBe(
      'https://api.aimlapi.com/v1/chat/completions',
    );
  });

  // The override exists so one build can be pointed at the staging backend;
  // production stays the compiled-in default so no staging host ever ships.
  it('honours a staging override', () => {
    expect(resolveAimlapiChatCompletionsUrl('https://api.staging.aimlapi.com/v1')).toBe(
      'https://api.staging.aimlapi.com/v1/chat/completions',
    );
  });
});
