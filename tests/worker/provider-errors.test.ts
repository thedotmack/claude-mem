import { describe, it, expect } from 'bun:test';
import {
  ClassifiedProviderError,
  isClassified,
  type ProviderErrorClass,
} from '../../src/services/worker/provider-errors.js';

// These tests exercise the *type system* and *invariants of the class itself*.
// Per-provider classification helpers (the actual mapping from raw SDK errors
// to ClassifiedProviderError) come in a later task — here we feed stub inputs
// representing what those helpers will eventually produce.

describe('ClassifiedProviderError', () => {
  it('classifies a 429-with-no-Retry-After response as rate_limit with no retryAfterMs', () => {
    const stubRaw = {
      status: 429,
      headers: {}, // no Retry-After header
      body: 'Too Many Requests',
    };

    const err = new ClassifiedProviderError('rate limited', {
      kind: 'rate_limit',
      cause: stubRaw,
    });

    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.cause).toBe(stubRaw);
    expect(err.message).toBe('rate limited');
    expect(err.name).toBe('ClassifiedProviderError');
  });

  it('classifies a 500-with-quota-exceeded body as quota_exhausted', () => {
    const stubRaw = {
      status: 500,
      body: 'Internal error: quota exceeded for project',
    };

    const err = new ClassifiedProviderError('quota exceeded', {
      kind: 'quota_exhausted',
      cause: stubRaw,
    });

    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('quota_exhausted');
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.cause).toBe(stubRaw);
  });

  it('classifies an SDK-level OverloadedError as transient', () => {
    // Stand-in for an SDK error class instance (e.g. Anthropic OverloadedError).
    class OverloadedError extends Error {
      constructor() {
        super('Overloaded');
        this.name = 'OverloadedError';
      }
    }
    const stubRaw = new OverloadedError();

    const err = new ClassifiedProviderError('upstream overloaded', {
      kind: 'transient',
      cause: stubRaw,
      retryAfterMs: 2000,
    });

    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('transient');
    expect(err.retryAfterMs).toBe(2000);
    expect(err.cause).toBe(stubRaw);
  });

  it('classifies an unknown 4xx as unrecoverable', () => {
    const stubRaw = {
      status: 418,
      body: "I'm a teapot",
    };

    const err = new ClassifiedProviderError('unrecoverable client error', {
      kind: 'unrecoverable',
      cause: stubRaw,
    });

    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('unrecoverable');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('round-trips a custom string kind through the open-union type system', () => {
    // The (string & {}) branch in ProviderErrorClass means any string is
    // assignable, but the named literals still autocomplete. Verify that a
    // provider-specific kind survives unchanged through construction +
    // the isClassified guard, and that it satisfies the type.
    const customKind: ProviderErrorClass = 'flue_specific';

    const err = new ClassifiedProviderError('flue-specific failure', {
      kind: customKind,
      cause: { provider: 'flue', code: 'F-42' },
    });

    expect(isClassified(err)).toBe(true);
    expect(err.kind).toBe('flue_specific');

    // Narrowing through isClassified preserves the kind field as ProviderErrorClass.
    if (isClassified(err)) {
      const k: ProviderErrorClass = err.kind;
      expect(k).toBe('flue_specific');
    }
  });

  it('isClassified rejects non-ClassifiedProviderError values', () => {
    expect(isClassified(new Error('plain'))).toBe(false);
    expect(isClassified('rate_limit')).toBe(false);
    expect(isClassified(null)).toBe(false);
    expect(isClassified(undefined)).toBe(false);
    expect(isClassified({ kind: 'rate_limit' })).toBe(false);
  });
});
