import { describe, it, expect } from 'bun:test';
import { checkVersionMatch, getRunningWorkerVersion } from '../../src/services/infrastructure/index.js';

// #3434 / plan-17 step 3: the UserPromptSubmit session-init budget only holds
// if every hook-side probe inside it is bounded. The version probe reaches the
// same `/api/health` route as the liveness check, so a worker that answers the
// first request and then stalls used to hold session-init open indefinitely —
// past the 15 s host hook cap — instead of returning the graceful fallback.
const STALLED_PROBE_TIMEOUT_MS = 300;
// Generous enough to survive CI scheduling jitter, far below the stall.
const DEADLINE_CEILING_MS = 3000;
const WORKER_VERSION = '13.12.0';
const LOOPBACK_HOST = '127.0.0.1';

/**
 * A worker that accepts the connection and never answers, mirroring the
 * bound-but-wedged listener in the plan-17 test matrix.
 */
function serveStalledHealth(): { port: number; stop: () => void } {
  let release: () => void = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({
    port: 0,
    hostname: LOOPBACK_HOST,
    async fetch() {
      await released;
      return Response.json({ version: WORKER_VERSION });
    },
  });
  return {
    port: server.port,
    stop: () => {
      release();
      server.stop(true);
    },
  };
}

describe('worker version probe deadline (3434)', () => {
  it('gives up on a stalled /api/health instead of outliving the caller budget', async () => {
    const worker = serveStalledHealth();
    try {
      const startedAt = Date.now();
      const result = await checkVersionMatch(worker.port, WORKER_VERSION, STALLED_PROBE_TIMEOUT_MS);
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(DEADLINE_CEILING_MS);
      // An unreadable version is not a mismatch: the caller must not recycle
      // a worker it could not interrogate, it must fall through gracefully.
      expect(result.workerVersion).toBeNull();
      expect(result.matches).toBe(true);
    } finally {
      worker.stop();
    }
  });

  it('returns null from the version read once the probe budget expires', async () => {
    const worker = serveStalledHealth();
    try {
      const startedAt = Date.now();
      const version = await getRunningWorkerVersion(worker.port, STALLED_PROBE_TIMEOUT_MS);
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(DEADLINE_CEILING_MS);
      expect(version).toBeNull();
    } finally {
      worker.stop();
    }
  });

  it('still reads the version when the worker answers within the budget', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: LOOPBACK_HOST,
      fetch: () => Response.json({ version: WORKER_VERSION }),
    });
    try {
      const result = await checkVersionMatch(server.port, WORKER_VERSION, STALLED_PROBE_TIMEOUT_MS);

      expect(result.workerVersion).toBe(WORKER_VERSION);
      expect(result.matches).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
