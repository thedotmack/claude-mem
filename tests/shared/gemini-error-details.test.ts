import { describe, it, expect } from 'bun:test';
import { parseGeminiErrorDetails, parseRetryDelayMs } from '../../src/shared/gemini-error-details.js';

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

describe('parseGeminiErrorDetails', () => {
  const body = (details: unknown[]) => JSON.stringify({
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).', details },
  });
  const quotaFailure = (...quotaIds: string[]) => ({
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: quotaIds.map(quotaId => ({ quotaId, quotaValue: '10' })),
  });
  const retryInfo = (retryDelay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });

  it('reads a per-minute window as no spent period, with the retry hint', () => {
    expect(parseGeminiErrorDetails(body([
      quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'),
      retryInfo('7s'),
    ]))).toEqual({ periodQuotaExhausted: false, retryDelayMs: 7000 });
  });

  for (const window of ['PerDay', 'PerWeek', 'PerMonth']) {
    it(`reads a ${window} window as a spent period`, () => {
      expect(parseGeminiErrorDetails(body([
        quotaFailure('GenerateRequestsPerMinutePerProjectPerModel', `GenerateRequests${window}PerProjectPerModel-FreeTier`),
      ])).periodQuotaExhausted).toBe(true);
    });
  }

  it('looks only at the violations, not at text elsewhere in the body', () => {
    const text = JSON.stringify({
      error: {
        code: 429,
        message: 'Quota GenerateRequestsPerDayPerProjectPerModel is fine; slow down.',
        details: [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel')],
      },
    });
    expect(parseGeminiErrorDetails(text).periodQuotaExhausted).toBe(false);
  });

  it('reports nothing for a body that is not JSON or carries no details', () => {
    expect(parseGeminiErrorDetails('RESOURCE_EXHAUSTED: quota exceeded for metric')).toEqual({ periodQuotaExhausted: false });
    expect(parseGeminiErrorDetails(JSON.stringify({ error: { code: 429 } }))).toEqual({ periodQuotaExhausted: false });
    expect(parseGeminiErrorDetails('null')).toEqual({ periodQuotaExhausted: false });
  });
});
