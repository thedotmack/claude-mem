import { jest } from 'bun:test';

export async function settleWithFakeClock<T>(start: () => Promise<T>, step: () => number = () => 10): Promise<T> {
  jest.useFakeTimers();
  const startedAt = Date.now();
  try {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    start().then(value => { outcome = { ok: true, value }; }, error => { outcome = { ok: false, error }; });
    while (!outcome) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (outcome) break;
      if (Date.now() - startedAt > 60000) throw new Error('Did not settle within 60 seconds of fake time');
      jest.advanceTimersByTime(step());
    }
    const settled = outcome as { ok: true; value: T } | { ok: false; error: unknown };
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    jest.useRealTimers();
  }
}
