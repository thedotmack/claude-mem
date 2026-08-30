import { describe, it, expect } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS,
  getProviderAttemptTimeoutMs,
  isRetryableKind,
  ProviderAttemptTimeoutError,
  withRetry,
} from '../../src/services/worker/retry.js';

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

describe('provider attempt timeout', () => {
  it('uses the configured timeout only within the supported range', () => {
    expect(getProviderAttemptTimeoutMs('90000')).toBe(90000);
    expect(getProviderAttemptTimeoutMs('300001')).toBe(DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS);
  });

  it('does not retry an abort caused by its own deadline', async () => {
    let attempts = 0;
    await expect(withRetry(async signal => {
      attempts += 1;
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }, { perAttemptTimeoutMs: 1, maxRetries: 2 })).rejects.toBeInstanceOf(ProviderAttemptTimeoutError);
    expect(attempts).toBe(1);
  });

  it('still retries an ordinary transient failure', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw classified('transient');
      return 'ok';
    }, { maxRetries: 2, baseDelayMs: 0 });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('does not retry after an external abort', async () => {
    const controller = new AbortController();
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts += 1;
      controller.abort();
      throw new Error('cancelled');
    }, { abortSignal: controller.signal, maxRetries: 2 })).rejects.toThrow('cancelled');
    expect(attempts).toBe(1);
  });

  it('rejects a late result when the callback ignores the deadline abort', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return 'late-result';
    }, { perAttemptTimeoutMs: 1, maxRetries: 2 })).rejects.toBeInstanceOf(ProviderAttemptTimeoutError);
    expect(attempts).toBe(1);
  });

  it('rejects a callback that never settles after the deadline', async () => {
    const startedAt = Date.now();
    await expect(withRetry(async () => new Promise<never>(() => {}), {
      perAttemptTimeoutMs: 10,
      maxRetries: 2,
    })).rejects.toBeInstanceOf(ProviderAttemptTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
