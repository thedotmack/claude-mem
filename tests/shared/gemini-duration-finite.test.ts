import { expect, test } from 'bun:test';
import { parseRetryDelayMs, parseGeminiErrorDetails } from '../../src/shared/gemini-error-details.js';
for (const duration of ['9'.repeat(400)+'s', '9007199254741s']) {
  test('ignores an unrepresentable duration '+duration.length, () => expect(parseRetryDelayMs(duration)).toBeUndefined());
}
test('does not propagate an infinite error-body retry hint', () => expect(parseGeminiErrorDetails(JSON.stringify({error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'9'.repeat(400)+'s'}]}}))).toEqual({periodQuotaExhausted:false}));
test('retains fractional and zero durations', () => {expect(parseRetryDelayMs('1.25s')).toBe(1250);expect(parseRetryDelayMs('0s')).toBe(0);});
