import { describe, it, expect } from 'bun:test';
import {
  ClassifiedProviderError,
  isExpectedBudgetError,
} from '../../src/services/worker/provider-errors.js';

// isExpectedBudgetError decides whether a session error is a spent budget
// (log at warn, keep out of the error-tracking sink) or a real crash.

describe('isExpectedBudgetError', () => {
  it('matches the classified rate_limit kind', () => {
    const err = new ClassifiedProviderError('rate limited', { kind: 'rate_limit', cause: null });
    expect(isExpectedBudgetError(err)).toBe(true);
  });

  it('matches the classified quota_exhausted kind', () => {
    const err = new ClassifiedProviderError('out of credits', { kind: 'quota_exhausted', cause: null });
    expect(isExpectedBudgetError(err)).toBe(true);
  });

  it('matches a wrapped daily-request-limit error by message', () => {
    // The exact shape a patched worker bundle throws — a plain Error that never
    // reaches a provider classifier.
    const err = new Error('Daily LLM request limit reached (600/600 for 2026-08-11)');
    err.name = 'DailyLlmRequestLimitError';
    expect(isExpectedBudgetError(err)).toBe(true);
  });

  it('matches raw rate-limit, quota, and 429 messages', () => {
    expect(isExpectedBudgetError(new Error('provider rate limit exceeded'))).toBe(true);
    expect(isExpectedBudgetError(new Error('quota exceeded for model'))).toBe(true);
    expect(isExpectedBudgetError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isExpectedBudgetError(new Error('insufficient credits'))).toBe(true);
  });

  it('does not match context-overflow or generic crashes', () => {
    expect(isExpectedBudgetError(new Error('prompt is too long for context window'))).toBe(false);
    expect(isExpectedBudgetError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isExpectedBudgetError(new ClassifiedProviderError('bad request', { kind: 'unrecoverable', cause: null }))).toBe(false);
  });

  it('keeps a classified kind authoritative over the message heuristics', () => {
    // A non-budget classified error whose message happens to contain a budget
    // word must stay on the error-reporting path, not the warn path.
    expect(isExpectedBudgetError(new ClassifiedProviderError('Provider quota lookup failed', { kind: 'unrecoverable', cause: null }))).toBe(false);
    expect(isExpectedBudgetError(new ClassifiedProviderError('rate limit config parse error', { kind: 'transient', cause: null }))).toBe(false);
  });

  it('handles non-Error inputs without throwing', () => {
    expect(isExpectedBudgetError('daily request limit reached')).toBe(true);
    expect(isExpectedBudgetError(null)).toBe(false);
    expect(isExpectedBudgetError(undefined)).toBe(false);
  });
});
