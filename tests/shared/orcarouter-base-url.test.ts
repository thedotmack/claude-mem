// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ORCAROUTER_API_URL,
  resolveOrcaRouterChatCompletionsUrl,
} from '../../src/shared/orcarouter-base-url.js';

describe('resolveOrcaRouterChatCompletionsUrl', () => {
  it('returns the default OrcaRouter URL when unset (undefined)', () => {
    expect(resolveOrcaRouterChatCompletionsUrl(undefined)).toBe(DEFAULT_ORCAROUTER_API_URL);
  });

  it('returns the default OrcaRouter URL when null', () => {
    expect(resolveOrcaRouterChatCompletionsUrl(null)).toBe(DEFAULT_ORCAROUTER_API_URL);
  });

  it('returns the default OrcaRouter URL for empty / whitespace string', () => {
    expect(resolveOrcaRouterChatCompletionsUrl('')).toBe(DEFAULT_ORCAROUTER_API_URL);
    expect(resolveOrcaRouterChatCompletionsUrl('   ')).toBe(DEFAULT_ORCAROUTER_API_URL);
  });

  it('appends /chat/completions to a base URL (OrcaRouter style)', () => {
    expect(resolveOrcaRouterChatCompletionsUrl('https://api.orcarouter.ai/v1')).toBe(
      'https://api.orcarouter.ai/v1/chat/completions',
    );
  });

  it('appends /chat/completions to a bare base', () => {
    expect(resolveOrcaRouterChatCompletionsUrl('https://gateway.example.com')).toBe(
      'https://gateway.example.com/chat/completions',
    );
  });

  it('uses a full /chat/completions URL verbatim', () => {
    const full = 'https://api.orcarouter.ai/v1/chat/completions';
    expect(resolveOrcaRouterChatCompletionsUrl(full)).toBe(full);
  });

  it('normalizes trailing slashes before appending', () => {
    expect(resolveOrcaRouterChatCompletionsUrl('https://api.orcarouter.ai/v1/')).toBe(
      'https://api.orcarouter.ai/v1/chat/completions',
    );
    expect(resolveOrcaRouterChatCompletionsUrl('https://api.orcarouter.ai/v1///')).toBe(
      'https://api.orcarouter.ai/v1/chat/completions',
    );
  });

  it('normalizes a trailing slash on a full chat/completions URL', () => {
    expect(resolveOrcaRouterChatCompletionsUrl('https://x.example.com/v1/chat/completions/')).toBe(
      'https://x.example.com/v1/chat/completions',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(resolveOrcaRouterChatCompletionsUrl('  https://api.orcarouter.ai/v1  ')).toBe(
      'https://api.orcarouter.ai/v1/chat/completions',
    );
  });

  it('matches the /chat/completions suffix case-insensitively', () => {
    const mixed = 'https://x.example.com/v1/Chat/Completions';
    expect(resolveOrcaRouterChatCompletionsUrl(mixed)).toBe(mixed);
  });
});
