import { describe, expect, it } from 'bun:test';
import { classifyOpenAICompatError } from '../../src/services/worker/OpenAICompatProvider.js';
import { parseRetryAfterMs, withRetry } from '../../src/services/worker/retry.js';
import { parseRetryAfterMs as parseServerRetryAfterMs } from '../../src/server/generation/providers/shared/error-classification.js';

describe('finite Retry-After hints', () => {
  for (const [name, parse] of [['worker', parseRetryAfterMs], ['server', parseServerRetryAfterMs]] as const) {
    it(`${name} ignores non-finite values and overflowing millisecond conversions`, () => {
      for (const value of ['Infinity', '1e309', '1e308']) {
        expect(parse(value)).toBeUndefined();
      }
      expect(parse('0')).toBe(0);
      expect(parse('60')).toBe(60_000);
      expect(parse('Wed, 01 Jan 2020 00:00:00 GMT')).toBe(0);
      expect(parse(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(58_000);
    });
  }

  it('uses normal backoff after a real endpoint sends a non-finite rate-limit hint', async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch() {
        requests++;
        return requests === 1
          ? new Response('rate limit', { status: 429, headers: { 'Retry-After': 'Infinity' } })
          : new Response('recovered');
      },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const result = await withRetry(async signal => {
        const response = await fetch(server.url, { signal });
        const bodyText = await response.text();
        if (!response.ok) {
          throw classifyOpenAICompatError({ status: response.status, headers: response.headers, bodyText, cause: null });
        }
        return bodyText;
      }, { abortSignal: controller.signal, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, perAttemptTimeoutMs: 1_000 });
      expect(result).toBe('recovered');
      expect(requests).toBe(2);
    } finally {
      clearTimeout(timeout);
      server.stop(true);
    }
  }, 10_000);
});
