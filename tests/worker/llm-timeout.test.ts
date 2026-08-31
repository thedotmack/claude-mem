import { describe, it, expect } from 'bun:test';
import { resolveLlmTimeoutMs, withRetry } from '../../src/services/worker/retry.js';

// #3794: the per-attempt deadline was hardcoded at 30s and unreachable from
// configuration. On a local model that truncates work already computed — a
// reported Ollama backend had a p99 of 29.8s against a 30s deadline — and the
// only workaround was editing the installed bundle after every update.
describe('resolveLlmTimeoutMs', () => {
  it('defaults to 30s when nothing is configured', () => {
    expect(resolveLlmTimeoutMs({})).toBe(30_000);
  });

  it('takes a value inside the shared 500..300000 bounds', () => {
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '90000' })).toBe(90_000);
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '500' })).toBe(500);
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '300000' })).toBe(300_000);
  });

  it('falls back to the default rather than trusting a value out of range', () => {
    // A zero or a negative would disable the deadline; a huge one would park a
    // worker for hours. Both keep the default, matching the other
    // CLAUDE_MEM_*_TIMEOUT_MS settings.
    for (const value of ['0', '-1', '499', '300001', 'abc', '']) {
      expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: value })).toBe(30_000);
    }
  });
});

describe('per-attempt deadline', () => {
  it('does not retry a request that blew the deadline', async () => {
    // The abort surfaces with no HTTP status, so it classified as transient and
    // was retried twice against a backend that is already saturated.
    let attempts = 0;
    const started = Date.now();
    await expect(
      withRetry(
        async signal => {
          attempts += 1;
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
          });
          return 'unreachable';
        },
        { label: 'probe', perAttemptTimeoutMs: 20, maxRetries: 2 },
      ),
    ).rejects.toThrow(/per-attempt deadline/);
    expect(attempts).toBe(1);
    // Three attempts plus backoff would take far longer than one deadline.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still retries a genuine transient failure', async () => {
    let attempts = 0;
    const out = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('socket hang up');
        return 'ok';
      },
      { label: 'probe', perAttemptTimeoutMs: 5_000, maxRetries: 2, baseDelayMs: 1 },
    );
    expect(out).toBe('ok');
    expect(attempts).toBe(2);
  });
});
