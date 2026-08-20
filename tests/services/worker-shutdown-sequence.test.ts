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
    reapSubprocesses: number;
    reapProcessRegistry: number;
    waitForPortFree: number;
    removePidFile: number;
    spawnDaemon: number;
  };
  spawnArgs: Array<{ scriptPath: string; port: number }>;
  /** successorSpawned as seen by each reapProcessRegistry call. */
  preserveFlags: boolean[];
}

function makeHarness(overrides: {
  reason?: WorkerShutdownReason;
  gracefulDeadlineMs?: number;
  beforeGracefulThrows?: boolean;
  graceful?: () => Promise<void>;
  reapSubprocesses?: () => Promise<void>;
  reapProcessRegistry?: () => Promise<void>;
  reapDeadlineMs?: number;
  reapRegistryDeadlineMs?: number;
  portFree?: boolean;
  spawnResult?: number | undefined;
  spawnThrows?: boolean;
} = {}): Harness {
  const guard = { shuttingDown: false };
  const calls: string[] = [];
  const preserveFlags: boolean[] = [];
  const counters = {
    beforeGraceful: 0,
    graceful: 0,
    reapSubprocesses: 0,
    reapProcessRegistry: 0,
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
    reapSubprocesses: () => {
      counters.reapSubprocesses++;
      calls.push('reapSubprocesses');
      return overrides.reapSubprocesses ? overrides.reapSubprocesses() : Promise.resolve();
    },
    reapDeadlineMs: overrides.reapDeadlineMs ?? 1000,
    reapRegistryDeadlineMs: overrides.reapRegistryDeadlineMs ?? 1000,
    reapProcessRegistry: (successorSpawned: boolean) => {
      counters.reapProcessRegistry++;
      calls.push('reapProcessRegistry');
      preserveFlags.push(successorSpawned);
      return overrides.reapProcessRegistry ? overrides.reapProcessRegistry() : Promise.resolve();
    },
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

  return { options, guard, calls, counters, spawnArgs, preserveFlags };
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

// performGracefulShutdown stops the chroma-mcp subprocess tree and runs the
// supervisor registry cascade as its LAST steps, behind a session drain the
// module header records at 35-40s — well past the 10s production deadline. When
// the deadline wins, the caller process.exit()s and the abandoned promise never
// reaches that teardown, orphaning the chroma-mcp tree (uvx -> uv -> python) to
// init, where it never exits because chroma-mcp ignores stdin EOF. These tests
// pin the backstop that guarantees teardown is still reached.
describe('runShutdownSequence — subprocess reap backstop', () => {
  it('reaps subprocesses when the graceful deadline expires mid-drain', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs forever — unbounded session drain */ }),
    });

    await runShutdownSequence(h.options);

    expect(h.counters.reapSubprocesses).toBe(1);
    // ...and it happens BEFORE the successor is spawned, so the replacement
    // worker never races a still-live predecessor chroma for the writer lock.
    expect(h.calls.indexOf('reapSubprocesses')).toBeLessThan(h.calls.indexOf('spawnDaemon'));
  });

  it('reaps subprocesses when performGracefulShutdown rejects', async () => {
    const h = makeHarness({
      reason: 'restart',
      graceful: () => Promise.reject(new Error('db close failed')),
    });

    await runShutdownSequence(h.options);

    expect(h.counters.reapSubprocesses).toBe(1);
  });

  it('does NOT reap when the graceful sequence completed (it already tore down)', async () => {
    const h = makeHarness({ reason: 'restart' });

    await runShutdownSequence(h.options);

    expect(h.counters.graceful).toBe(1);
    expect(h.counters.reapSubprocesses).toBe(0);
  });

  it('bounds a hanging reap on its own deadline and still completes the handoff', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
      reapDeadlineMs: 50,
      reapSubprocesses: () => new Promise<void>(() => { /* tree-kill wedged */ }),
    });

    const start = Date.now();
    await runShutdownSequence(h.options);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(h.counters.spawnDaemon).toBe(1);
  });

  it('proceeds (and does not reject) when the reap itself throws', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
      reapSubprocesses: () => Promise.reject(new Error('pkill unavailable')),
    });

    await runShutdownSequence(h.options); // must not throw

    expect(h.counters.spawnDaemon).toBe(1);
  });

  it("reaps on a 'stop' shutdown too, where there is no successor handoff", async () => {
    const h = makeHarness({
      reason: 'stop',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
    });

    await runShutdownSequence(h.options);

    expect(h.counters.reapSubprocesses).toBe(1);
    expect(h.counters.spawnDaemon).toBe(0);
  });
});

// The registry cascade (Supervisor.stop()) is the OTHER teardown step the
// deadline skips, and it covers every managed child — SDK trees, mcp servers —
// not just chroma. It has to run on the far side of the handoff: it holds the
// supervisor's spawn gate (assertCanSpawn) for its whole duration, so running
// it first can make the successor spawn throw.
describe('runShutdownSequence — registry cascade backstop', () => {
  it('reaps the process registry AFTER spawning the successor, never before', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
    });

    await runShutdownSequence(h.options);

    expect(h.counters.reapProcessRegistry).toBe(1);
    expect(h.calls.indexOf('reapProcessRegistry')).toBeGreaterThan(h.calls.indexOf('spawnDaemon'));
    // ...and the chroma reap stays on the near side, so the successor never
    // races a live predecessor for the chroma writer lock.
    expect(h.calls.indexOf('reapSubprocesses')).toBeLessThan(h.calls.indexOf('spawnDaemon'));
  });

  it("reaps the registry on a 'stop' shutdown, where no handoff happens", async () => {
    const h = makeHarness({
      reason: 'stop',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
    });

    await runShutdownSequence(h.options);

    expect(h.counters.reapProcessRegistry).toBe(1);
    expect(h.counters.spawnDaemon).toBe(0);
  });

  // Non-restart shutdowns still own their cascade inside performGracefulShutdown
  // (deferSupervisorStop is restart-only), so a completed graceful sequence has
  // already reaped and this must stay a pure backstop.
  it('does NOT reap the registry when a non-restart graceful sequence completed', async () => {
    const h = makeHarness({ reason: 'stop' });

    await runShutdownSequence(h.options);

    expect(h.counters.reapProcessRegistry).toBe(0);
  });

  // Restart is the exception: the graceful sequence defers its cascade so this
  // one always runs, after the handoff, even on the graceful outcome. Keeping
  // it off the spawn gate is the whole point — see deferSupervisorStop.
  it('DOES reap the registry on a graceful restart, after the handoff', async () => {
    const h = makeHarness({ reason: 'restart' });

    await runShutdownSequence(h.options);

    expect(h.counters.reapProcessRegistry).toBe(1);
    expect(h.calls.indexOf('reapProcessRegistry')).toBeGreaterThan(h.calls.indexOf('spawnDaemon'));
  });

  // Registry preservation is gated on a successor process having been launched.
  // Every handoff failure path leaves this worker as the sole known writer, so
  // suppressing its writes there would strand its own records with nothing left
  // to prune them.
  it('preserves the registry once a successor process is launched', async () => {
    const h = makeHarness({ reason: 'restart' });

    await runShutdownSequence(h.options);

    expect(h.preserveFlags).toEqual([true]);
  });

  it('does NOT preserve the registry when the port never freed', async () => {
    const h = makeHarness({ reason: 'restart', portFree: false });

    await runShutdownSequence(h.options);

    expect(h.counters.spawnDaemon).toBe(0);
    expect(h.preserveFlags).toEqual([false]);
  });

  it('does NOT preserve the registry when spawnDaemon returns no pid', async () => {
    const h = makeHarness({ reason: 'restart', spawnResult: undefined });

    await runShutdownSequence(h.options);

    expect(h.preserveFlags).toEqual([false]);
  });

  it('does NOT preserve the registry when the successor spawn throws', async () => {
    const h = makeHarness({ reason: 'restart', spawnThrows: true });

    await runShutdownSequence(h.options);

    expect(h.preserveFlags).toEqual([false]);
  });

  it('still reaps the registry when the successor spawn throws', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
      spawnThrows: true,
    });

    await runShutdownSequence(h.options); // must not throw

    expect(h.counters.reapProcessRegistry).toBe(1);
  });

  // The cascade is SIGTERM -> waitForExit(5s) -> SIGKILL -> waitForExit(1s) ->
  // unregister, so it legitimately needs ~6s. Sharing the chroma reap's tight
  // budget would truncate it mid-SIGKILL and skip the unregister pass, leaving
  // stubborn children alive at exit. The two budgets must be independent.
  it('gives the registry cascade a budget independent of the chroma reap', async () => {
    let cascadeCompleted = false;
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
      // Chroma's budget is deliberately shorter than the cascade takes.
      reapDeadlineMs: 30,
      reapRegistryDeadlineMs: 500,
      reapProcessRegistry: async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        cascadeCompleted = true;
      },
    });

    await runShutdownSequence(h.options);

    // Ran to completion rather than being cut off by the 30ms chroma budget.
    expect(cascadeCompleted).toBe(true);
  });

  it('bounds a hanging registry cascade on its own deadline', async () => {
    const h = makeHarness({
      reason: 'restart',
      gracefulDeadlineMs: 50,
      graceful: () => new Promise<void>(() => { /* hangs */ }),
      reapDeadlineMs: 50,
      reapProcessRegistry: () => new Promise<void>(() => { /* cascade wedged */ }),
    });

    const start = Date.now();
    await runShutdownSequence(h.options); // must not hang the dying worker
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
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
