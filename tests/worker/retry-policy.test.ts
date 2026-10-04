import { describe, it, expect } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { isRetryableKind } from '../../src/services/worker/retry.js';

// Pins the retry policy ("never pay twice", Phase 1): only a send the backend
// refused before doing any work (a rate limit) is retried in place.
// quota/auth/unrecoverable fail fast; transient (network, 5xx, deadline) is
// ambiguous — the work may have been billed — so the session's transport pause
// decides instead; unclassified errors are no longer assumed transient.

const classified = (kind: string) => new ClassifiedProviderError(`test ${kind}`, { kind, cause: null });

describe('isRetryableKind', () => {
  for (const kind of ['quota_exhausted', 'auth_invalid', 'unrecoverable']) {
    it(`does not retry ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(false);
    });
  }

  it('retries rate_limit (refused before work)', () => {
    expect(isRetryableKind(classified('rate_limit'))).toBe(true);
  });

  // Was retried before Phase 1; ambiguous now.
  it('does not retry transient (ambiguous: may have been billed)', () => {
    expect(isRetryableKind(classified('transient'))).toBe(false);
  });

  // Was the "treat as transient" default before Phase 1 (retry.ts:164-167, flipped).
  it('does not retry a plain (unclassified) Error', () => {
    expect(isRetryableKind(new Error('ECONNRESET'))).toBe(false);
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
