// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  EMPTY_RESPONSE_RETRY_MIN_BUDGET,
  isTruncationStopReason,
  nextRetryBudget,
  shouldRetryEmptyResponse,
} from '../../../src/server/generation/providers/shared/empty-response.js';

describe('empty-response helpers (#3630)', () => {
  it('nextRetryBudget doubles the budget but never drops below the floor', () => {
    expect(nextRetryBudget(600)).toBe(EMPTY_RESPONSE_RETRY_MIN_BUDGET);
    expect(nextRetryBudget(4096)).toBe(8192);
    expect(nextRetryBudget(10000)).toBe(20000);
  });

  it('isTruncationStopReason recognizes each provider marker, case-insensitively', () => {
    expect(isTruncationStopReason('max_tokens')).toBe(true); // Anthropic
    expect(isTruncationStopReason('length')).toBe(true); // OpenAI
    expect(isTruncationStopReason('MAX_TOKENS')).toBe(true); // Gemini
    expect(isTruncationStopReason('end_turn')).toBe(false);
    expect(isTruncationStopReason('stop')).toBe(false);
    expect(isTruncationStopReason(null)).toBe(false);
    expect(isTruncationStopReason(undefined)).toBe(false);
  });

  it('shouldRetryEmptyResponse only retries empty text that was truncated or has no stop reason', () => {
    expect(shouldRetryEmptyResponse('', 'max_tokens')).toBe(true);
    expect(shouldRetryEmptyResponse('', null)).toBe(true);
    expect(shouldRetryEmptyResponse('', undefined)).toBe(true);
    expect(shouldRetryEmptyResponse('', 'end_turn')).toBe(false);
    expect(shouldRetryEmptyResponse('some text', 'max_tokens')).toBe(false);
  });
});
