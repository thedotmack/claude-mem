import { jest } from 'bun:test';

/**
 * Runs `start` under bun's fake clock and drives the clock forward until the
 * promise settles. ensureWorkerRunning's cold-boot wait is a real ~15.5 s
 * exponential backoff (500 ms doubling over 6 attempts); every probe it makes
 * is mocked to answer instantly, so only the backoff timers stand between the
 * call and its verdict. Fake timers also mock Date.now, so the production
 * deadlines see exactly the elapsed time they would in real life.
 *
 * Each step yields one real macrotask (setImmediate is not faked) so pending
 * promise chains run before the clock moves again.
 */
const FAKE_CLOCK_STEP_MS = 100;
const FAKE_CLOCK_LIMIT_MS = 120_000;

export async function settleUnderFakeClock<T>(start: () => Promise<T>): Promise<{ value: T; fakeElapsedMs: number }> {
  jest.useFakeTimers();
  const startedAt = Date.now();
  try {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
    start().then(
      value => { outcome = { ok: true, value }; },
      error => { outcome = { ok: false, error }; },
    );
    while (outcome === null) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (outcome !== null) break;
      if (Date.now() - startedAt > FAKE_CLOCK_LIMIT_MS) {
        throw new Error(`did not settle within ${FAKE_CLOCK_LIMIT_MS} ms of fake time`);
      }
      jest.advanceTimersByTime(FAKE_CLOCK_STEP_MS);
    }
    const settled = outcome as { ok: true; value: T } | { ok: false; error: unknown };
    if (!settled.ok) throw settled.error;
    return { value: settled.value, fakeElapsedMs: Date.now() - startedAt };
  } finally {
    jest.useRealTimers();
  }
}
