// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  parseServerMaxOutputTokens,
  parseServerProviderParams,
} from '../../../src/server/runtime/create-server-service.js';

describe('parseServerMaxOutputTokens (#3630)', () => {
  it('accepts a whole-string positive integer', () => {
    expect(parseServerMaxOutputTokens({ CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS: '1000' })).toBe(1000);
    expect(parseServerMaxOutputTokens({ CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS: '  8192 ' })).toBe(8192);
  });

  it('rejects numeric prefixes, non-integers, and non-positive values', () => {
    for (const value of ['1e3', '1.5', '10px', '-5', '0', 'abc', '']) {
      expect(parseServerMaxOutputTokens({ CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS: value })).toBeUndefined();
    }
  });

  it('returns undefined when unset', () => {
    expect(parseServerMaxOutputTokens({})).toBeUndefined();
  });
});

describe('parseServerProviderParams (#3630)', () => {
  it('parses a JSON object', () => {
    expect(parseServerProviderParams({ CLAUDE_MEM_SERVER_PROVIDER_PARAMS: '{"thinking":{"type":"disabled"}}' }))
      .toEqual({ thinking: { type: 'disabled' } });
  });

  it('rejects non-object JSON and malformed JSON', () => {
    for (const value of ['[1,2]', '42', '"x"', '{bad', '']) {
      expect(parseServerProviderParams({ CLAUDE_MEM_SERVER_PROVIDER_PARAMS: value })).toBeUndefined();
    }
  });
});
