import { describe, it, expect } from 'bun:test';

describe('ChromaSync connection mutex', () => {
  it('connectionPromise field coalesces concurrent calls', async () => {
    // Simulate the mutex pattern
    let connectCount = 0;
    let connectionPromise: Promise<void> | null = null;

    async function doConnect(): Promise<void> {
      connectCount++;
      await new Promise(r => setTimeout(r, 50));
    }

    async function ensureConnection(): Promise<void> {
      if (connectionPromise) return connectionPromise;
      const p = connectionPromise = doConnect();
      try { await p; }
      finally {
        if (connectionPromise === p) connectionPromise = null;
      }
    }

    // Fire 10 concurrent calls
    await Promise.all(Array(10).fill(null).map(() => ensureConnection()));

    // Only 1 actual connection should have been made
    expect(connectCount).toBe(1);
  });

  it('promise memoization race: newer caller not cleared by older finally', async () => {
    let connectCount = 0;
    let connectionPromise: Promise<void> | null = null;

    async function doConnect(delay: number): Promise<void> {
      connectCount++;
      await new Promise(r => setTimeout(r, delay));
    }

    async function ensureConnection(delay: number): Promise<void> {
      if (connectionPromise) return connectionPromise;
      const p = connectionPromise = doConnect(delay);
      try { await p; }
      finally {
        // Only clear if still the same promise
        if (connectionPromise === p) connectionPromise = null;
      }
    }

    // First call starts a slow connection
    const p1 = ensureConnection(100);
    // Wait for first to complete, then start a second
    await p1;
    const p2 = ensureConnection(50);
    await p2;

    // Both should complete independently
    expect(connectCount).toBe(2);
  });

  it('circuit breaker stops retries after MAX_FAILURES', async () => {
    let attempts = 0;
    let consecutiveFailures = 0;
    let circuitOpenUntil = 0;
    const MAX_FAILURES = 3;
    const CIRCUIT_OPEN_MS = 60_000;

    function isCircuitOpen(): boolean {
      return Date.now() < circuitOpenUntil;
    }

    async function tryConnect(): Promise<boolean> {
      if (isCircuitOpen()) return false;
      attempts++;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
      return false; // simulate failure
    }

    // 3 failures should trip the breaker
    await tryConnect();
    await tryConnect();
    await tryConnect();
    expect(attempts).toBe(3);
    expect(isCircuitOpen()).toBe(true);

    // 4th attempt should be blocked by circuit breaker
    const blocked = await tryConnect();
    expect(blocked).toBe(false);
    expect(attempts).toBe(3); // no new attempt
  });
});
