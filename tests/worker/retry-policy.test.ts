import { describe, it, expect } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { isRetryableKind, parseRetryDelayMs } from '../../src/services/worker/retry.js';

// Pins the retry policy: quota/auth/unrecoverable errors must fail fast (no
// pointless retries of something that cannot succeed); transient and
// rate-limit errors retry; unclassified errors keep the historical
// "treat as transient" default.

const classified = (kind: string) => new ClassifiedProviderError(`test ${kind}`, { kind, cause: null });

describe('isRetryableKind', () => {
  for (const kind of ['quota_exhausted', 'auth_invalid', 'unrecoverable']) {
    it(`does not retry ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(false);
    });
  }

  for (const kind of ['transient', 'rate_limit']) {
    it(`retries ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(true);
    });
  }

  it('retries a plain (unclassified) Error — preserves the existing default', () => {
    expect(isRetryableKind(new Error('ECONNRESET'))).toBe(true);
  });

  it('does not retry an allowance_exhausted gateway envelope carried as quota_exhausted', () => {
    const err = new ClassifiedProviderError('You have used your allowance.', {
      kind: 'quota_exhausted',
      cause: null,
      code: 'allowance_exhausted',
      requestId: 'abc',
    });
    expect(isRetryableKind(err)).toBe(false);
  });
});

describe('parseRetryDelayMs', () => {
  for (const [input, expected] of [
    ['3s', 3000],
    ['1.5s', 1500],
    ['0.25s', 250],
    ['0s', 0],
    [' 7s ', 7000],
  ] as const) {
    it(`parses "${input}" as ${expected}ms`, () => {
      expect(parseRetryDelayMs(input)).toBe(expected);
    });
  }

  for (const input of ['', 'abc', '5', '5ms', '-1s', '1.5', 's', null, undefined]) {
    it(`returns undefined for ${JSON.stringify(input)}`, () => {
      expect(parseRetryDelayMs(input)).toBeUndefined();
    });
  }
});
