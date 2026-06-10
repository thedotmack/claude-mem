import { describe, it, expect } from 'bun:test';
import { runShutdownSequence, type ShutdownSequenceOptions, type WorkerShutdownReason } from '../../src/services/worker-shutdown.js';

// runShutdownSequence lives in src/services/worker-shutdown.ts (not
// worker-service.ts) precisely so this test can import it without triggering
// worker-service.ts's top-level side effects (isMainModule bootstrap,
// bun:sqlite, MCP SDK, telemetry) — same seam precedent as restart-verify.ts.
// WorkerService.shutdown() delegates to this function with its real deps, so
// these tests exercise the production guard/deadline/handoff logic directly.

const PORT = 45678;
const SCRIPT = '/marketplace/plugin/scripts/worker-service.cjs';

interface Harness {
  options: ShutdownSequenceOptions;
  guard: { shuttingDown: boolean };
  calls: string[]; // ordered event log
  counters: {
    beforeGraceful: number;
    graceful: number;
    waitForPortFree: number;
    removePidFile: number;
    spawnDaemon: number;
  };
  spawnArgs: Array<{ scriptPath: string; port: number }>;
}

function makeHarness(overrides: {
  reason?: WorkerShutdownReason;
  gracefulDeadlineMs?: number;
  beforeGracefulThrows?: boolean;
  graceful?: () => Promise<void>;
  portFree?: boolean;
  spawnResult?: number | undefined;
  spawnThrows?: boolean;
} = {}): Harness {
  const guard = { shuttingDown: false };
  const calls: string[] = [];
  const counters = {
    beforeGraceful: 0,
    graceful: 0,
    waitForPortFree: 0,
    removePidFile: 0,
    spawnDaemon: 0,
  };
  const spawnArgs: Array<{ scriptPath: string; port: number }> = [];

  const options: ShutdownSequenceOptions = {
    reason: overrides.reason ?? 'stop',
    isShuttingDown: () => guard.shuttingDown,
    markShuttingDown: () => { guard.shuttingDown = true; },
    beforeGracefulShutdown: async () => {
      counters.beforeGraceful++;
      calls.push('beforeGraceful');
      if (overrides.beforeGracefulThrows) {
        throw new Error('telemetry flush failed');
      }
    },
    performGracefulShutdown: () => {
      counters.graceful++;
      calls.push('graceful');
      return overrides.graceful ? overrides.graceful() : Promise.resolve();
    },
    gracefulDeadlineMs: overrides.gracefulDeadlineMs ?? 1000,
    restartHandoff: {
      port: PORT,
      portFreeTimeoutMs: 1000,
      resolveSuccessorScript: () => SCRIPT,
      waitForPortFree: async (port: number) => {
        counters.waitForPortFree++;
        calls.push(`waitForPortFree:${port}`);
        return overrides.portFree ?? true;
      },
      removePidFile: () => {
        counters.removePidFile++;
        calls.push('removePidFile');
      },
      spawnDaemon: (scriptPath: string, port: number) => {
        counters.spawnDaemon++;
        calls.push('spawnDaemon');
        spawnArgs.push({ scriptPath, port });
        if (overrides.spawnThrows) {
          throw new Error('Supervisor is shutting down, refusing to spawn worker daemon');
        }
        return 'spawnResult' in overrides ? overrides.spawnResult : 9999;
      },
    },
  };

  return { options, guard, calls, counters, spawnArgs };
}

describe('runShutdownSequence — re-entrancy guard', () => {
  it('runs performGracefulShutdown exactly once when shutdown is invoked twice', async () => {
    const h = makeHarness({ reason: 'stop' });

    await runShutdownSequence(h.options);
    await runShutdownSequence(h.options); // re-entrant call: must be a no-op

    expect(h.counters.graceful).toBe(1);
    expect(h.counters.beforeGraceful).toBe(1);
    expect(h.guard.shuttingDown).toBe(true);
  });

  it('blocks a concurrent second invocation (guard is set synchronously at entry)', async () => {
    const h = makeHarness({
      reason: 'stop',
      // Graceful takes a tick so the second call overlaps the first.
      graceful: () => new Promise(resolve => setTimeout(resolve, 20)),
    });

    await Promise.all([
      runShutdownSequence(h.options),
      runShutdownSequence(h.options),
    ]);

    expect(h.counters.graceful).toBe(1);
    expect(h.counters.beforeGraceful).toBe(1);
  });
});

describe('runShutdownSequence — pre-graceful bookkeeping guard', () => {
  it('proceeds to graceful shutdown and the restart handoff when beforeGracefulShutdown throws', async () => {
    const h = makeHarness({ reason: 'restart', beforeGracefulThrows: true });

    await runShutdownSequence(h.options); // must not throw

    // Bookkeeping failure is logged and skipped; the sequence still drains
    // gracefully and still hands off to the successor.
    expect(h.counters.beforeGraceful).toBe(1);
    expect(h.counters.graceful).toBe(1);
    expect(h.counters.waitForPortFree).toBe(1);
    expect(h.counters.spawnDaemon).toBe(1);
  });
});

describe('runShutdownSequence — graceful-shutdown deadline', () => {
  it('proceeds when performGracefulShutdown never resolves (hard deadline)', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs forever — unbounded session drain */ }),
    });

    const start = Date.now();
    await runShutdownSequence(h.options);
    const elapsed = Date.now() - start;

    // Deadlined and continued into the restart handoff anyway.
    expect(elapsed).toBeLessThan(2000);
    expect(h.counters.waitForPortFree).toBe(1);
    expect(h.counters.spawnDaemon).toBe(1);
  });

  it('proceeds (and does not reject) when performGracefulShutdown rejects', async () => {
    const h = makeHarness({
      reason: 'restart',
      graceful: () => Promise.reject(new Error('db close failed')),
    });

    await runShutdownSequence(h.options); // must not throw

    expect(h.counters.spawnDaemon).toBe(1);
  });
});

describe('runShutdownSequence — restart successor handoff', () => {
  it('spawns the successor only AFTER the port is confirmed free (restart)', async () => {
    const h = makeHarness({ reason: 'restart', portFree: true });

    await runShutdownSequence(h.options);

    expect(h.counters.spawnDaemon).toBe(1);
    expect(h.spawnArgs[0]).toEqual({ scriptPath: SCRIPT, port: PORT });
    // Ordering: graceful → port-free confirmation → pid-file cleanup → spawn.
    const order = h.calls;
    expect(order.indexOf(`waitForPortFree:${PORT}`)).toBeGreaterThan(order.indexOf('graceful'));
    expect(order.indexOf('removePidFile')).toBeGreaterThan(order.indexOf(`waitForPortFree:${PORT}`));
    expect(order.indexOf('spawnDaemon')).toBeGreaterThan(order.indexOf('removePidFile'));
  });

  it('never spawns when the port never frees', async () => {
    const h = makeHarness({ reason: 'restart', portFree: false });

    await runShutdownSequence(h.options);

    expect(h.counters.waitForPortFree).toBe(1);
    expect(h.counters.removePidFile).toBe(0);
    expect(h.counters.spawnDaemon).toBe(0);
  });

  it("stays kill-only for reason 'stop'", async () => {
    const h = makeHarness({ reason: 'stop' });

    await runShutdownSequence(h.options);

    expect(h.counters.waitForPortFree).toBe(0);
    expect(h.counters.spawnDaemon).toBe(0);
  });

  it("stays kill-only for reason 'signal'", async () => {
    const h = makeHarness({ reason: 'signal' });

    await runShutdownSequence(h.options);

    expect(h.counters.waitForPortFree).toBe(0);
    expect(h.counters.spawnDaemon).toBe(0);
  });

  it('completes (logging loudly, not throwing) when spawnDaemon returns undefined', async () => {
    const h = makeHarness({ reason: 'restart', spawnResult: undefined });

    await runShutdownSequence(h.options); // must not throw

    expect(h.counters.spawnDaemon).toBe(1);
  });

  it('completes when spawnDaemon throws (supervisor refusing mid-cascade)', async () => {
    const h = makeHarness({ reason: 'restart', spawnThrows: true });

    await runShutdownSequence(h.options); // must not throw

    expect(h.counters.spawnDaemon).toBe(1);
  });
});
