import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeLoopbackPort,
  shutdownWorkerAndWait,
  type PortProbeResult,
  type ShutdownProbes,
  type ShutdownResult,
} from '../src/services/install/shutdown-helper';
import type { PidInfo } from '../src/supervisor/process-registry';
import {
  overwriteWithWorkerStopped,
  requireWorkerStopped,
  workerShutdownFailure,
} from '../src/npx-cli/commands/install';
import { uninstallShutdownNotice } from '../src/npx-cli/commands/uninstall';
import { createInstallSummary, InstallAbortError } from '../src/npx-cli/install/error-reporter';
import { ErrorSeverity } from '../src/npx-cli/install/error-taxonomy';
import { acquireSpawnLock } from '../src/shared/worker-spawn-gate';

// Every case injects the PID-file and port evidence, so no test touches a real
// worker, PID file, or port (the old refused-port test raced other processes
// for the released port).

const PORT = 37777;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ownedWorker(overrides: Partial<PidInfo> = {}): PidInfo {
  return { pid: 4242, port: PORT, startedAt: '2026-09-30T00:00:00.000Z', ...overrides };
}

interface FakeEvidence {
  /** The PID file's verified owner; an array answers successive reads, the last one repeating. */
  owned?: PidInfo | null | (PidInfo | null)[];
  /** Answers for successive liveness checks of the owned worker; the last one repeats. */
  alive?: boolean[];
  /** Answers for successive port probes; the last one repeats. */
  port?: PortProbeResult[];
  /** Pids the worker reports from /api/health on successive reads; the last one repeats. */
  healthPids?: (number | null)[];
}

function probes(evidence: FakeEvidence = {}): ShutdownProbes & { probeTimeouts: number[] } {
  const owned = Array.isArray(evidence.owned) ? [...evidence.owned] : [evidence.owned ?? null];
  const alive = [...(evidence.alive ?? [false])];
  const port = [...(evidence.port ?? ['refused'])];
  const healthPids = [...(evidence.healthPids ?? [null])];
  const probeTimeouts: number[] = [];
  return {
    probeTimeouts,
    readAnsweringWorkerPid: async () => (healthPids.length > 1 ? healthPids.shift()! : healthPids[0]),
    readOwnedWorker: () => (owned.length > 1 ? owned.shift()! : owned[0]),
    isOwnedWorkerAlive: () => (alive.length > 1 ? alive.shift()! : alive[0]),
    probePort: async (_port, timeoutMs) => {
      probeTimeouts.push(timeoutMs);
      return port.length > 1 ? port.shift()! : port[0];
    },
  };
}

function fetchRejects(error: unknown): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function fetchResponds(status: number): void {
  globalThis.fetch = (async () => new Response(null, { status })) as unknown as typeof fetch;
}

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');

describe('installer worker shutdown — explicit refusal', () => {
  it('treats a refused shutdown connection as no running worker', async () => {
    fetchRejects(refused());
    await expect(shutdownWorkerAndWait(PORT, 0, probes())).resolves.toEqual({ workerWasRunning: false, stopped: true });
  });

  it("treats Bun's ConnectionRefused shape as no running worker", async () => {
    // Bun's fetch rejects a refused connect with code 'ConnectionRefused' and an
    // "Unable to connect" message: no ECONNREFUSED anywhere on the error.
    fetchRejects(Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }));
    await expect(shutdownWorkerAndWait(PORT, 0, probes())).resolves.toEqual({ workerWasRunning: false, stopped: true });
  });

  it('accepts a slow refusal as a refusal, with no second probe that could time out (#4107)', async () => {
    // WSL2 mirrored networking can take seconds to refuse a loopback connect.
    // The old code re-probed /api/health with a 1s timeout, so a slow refusal
    // timed out there and aborted the install on a machine with no worker.
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw refused();
    }) as unknown as typeof fetch;
    const evidence = probes({ port: ['no-answer'] });
    await expect(shutdownWorkerAndWait(PORT, 0, evidence)).resolves.toEqual({ workerWasRunning: false, stopped: true });
    expect(evidence.probeTimeouts).toEqual([]);
  });
});

describe('installer worker shutdown — ambiguous HTTP result, decided by the PID file', () => {
  it('treats a timeout with dropped SYNs and no PID file as no running worker (#4107)', async () => {
    fetchRejects(timedOut());
    const evidence = probes({ owned: null, port: ['no-answer'] });
    await expect(shutdownWorkerAndWait(PORT, 0, evidence)).resolves.toEqual({ workerWasRunning: false, stopped: true });
    // One generous TCP attempt, not the old 1s probe.
    expect(evidence.probeTimeouts.every((timeoutMs) => timeoutMs >= 3000)).toBe(true);
  });

  it('fails closed, naming the PID, when the owned worker is alive after a timeout', async () => {
    fetchRejects(timedOut());
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: ownedWorker(), alive: [true] }))).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: 4242 },
    });
  });

  it('reports a foreign listener, not a stuck worker, when no claude-mem worker owns the open port', async () => {
    fetchRejects(timedOut());
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['open'] }))).resolves.toEqual({
      workerWasRunning: false,
      stopped: false,
      blocker: { kind: 'port-held-by-other-process' },
    });
  });

  it('accepts a reset shutdown socket once the port stops accepting connections', async () => {
    fetchRejects(new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }));
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['refused'] }))).resolves.toEqual({
      workerWasRunning: false,
      stopped: true,
    });
  });

  it('waits for an owned worker that exits after an ambiguous failure', async () => {
    fetchRejects(new TypeError('fetch failed'));
    await expect(
      shutdownWorkerAndWait(PORT, 2000, probes({ owned: ownedWorker(), alive: [true, false], port: ['refused'] })),
    ).resolves.toEqual({ workerWasRunning: true, stopped: true });
  });

  it('ignores a PID file that places the worker on another port', async () => {
    fetchRejects(timedOut());
    await expect(
      shutdownWorkerAndWait(PORT, 0, probes({ owned: ownedWorker({ port: 38888 }), alive: [true], port: ['no-answer'] })),
    ).resolves.toEqual({ workerWasRunning: false, stopped: true });
  });
});

describe('installer worker shutdown — HTTP answers', () => {
  it('fails closed, naming the PID, when the owned worker rejects shutdown', async () => {
    fetchResponds(503);
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: ownedWorker(), alive: [true] }))).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: 4242 },
    });
  });

  it('reports a foreign HTTP server that does not know the shutdown route', async () => {
    fetchResponds(404);
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['open'] }))).resolves.toEqual({
      workerWasRunning: false,
      stopped: false,
      blocker: { kind: 'port-held-by-other-process' },
    });
  });

  it('reports the port as taken again, naming no PID, when a worker with no PID file accepted shutdown but the port stays open', async () => {
    fetchResponds(200);
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['open'] }))).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'port-rebound', ownerPid: null },
    });
  });

  it('reports the worker stopped once its process exits and the port refuses', async () => {
    fetchResponds(200);
    await expect(
      shutdownWorkerAndWait(PORT, 2000, probes({ owned: ownedWorker(), alive: [true, false], port: ['refused'] })),
    ).resolves.toEqual({ workerWasRunning: true, stopped: true });
  });
});

describe('installer worker shutdown — the port is taken again after the worker exits', () => {
  it('reports a rebind, not a stuck worker, when the owned worker exits and something rebinds the port', async () => {
    // A hook's lazy spawn or a process manager bound the port between polls.
    // The old code re-checked only the PID it read at the start, found the port
    // open at the deadline, and aborted naming that dead PID.
    fetchResponds(200);
    await expect(
      shutdownWorkerAndWait(PORT, 600, probes({ owned: ownedWorker(), alive: [true, false], port: ['open'] })),
    ).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'port-rebound', ownerPid: null },
    });
  });

  it('names the new owner only when the PID file verifies a respawned worker on the port', async () => {
    fetchRejects(timedOut());
    const respawned = ownedWorker({ pid: 5151, startedAt: '2026-09-30T00:00:09.000Z' });
    await expect(
      shutdownWorkerAndWait(PORT, 0, probes({ owned: [ownedWorker(), respawned], alive: [false], port: ['open'] })),
    ).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'port-rebound', ownerPid: 5151 },
    });
  });

  it('never reports the dead PID it started with (Windows reuses PIDs)', async () => {
    fetchResponds(200);
    const result = await shutdownWorkerAndWait(PORT, 0, probes({ owned: ownedWorker(), alive: [false], port: ['open'] }));
    expect(JSON.stringify(result)).not.toContain('4242');
  });

  it('with no PID file, a worker still answering as the same process did not stop: it is not a rebind', async () => {
    // A worker that never wrote its PID file (a read-only data dir, a container)
    // accepted the shutdown but still serves at the deadline.
    fetchResponds(200);
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['open'], healthPids: [7070] }))).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: null },
    });
  });

  it('with no PID file, a different process answering at the deadline is a rebind', async () => {
    fetchResponds(200);
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['open'], healthPids: [7070, 8080] }))).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'port-rebound', ownerPid: null },
    });
  });
});

describe('probeLoopbackPort', () => {
  it('reports open for a live listener', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port');
    try {
      await expect(probeLoopbackPort(address.port, 3000)).resolves.toBe('open');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe('installer reaction to a port that is not free', () => {
  it('aborts on a claude-mem worker that will not stop, naming its PID', () => {
    const failure = workerShutdownFailure({ kind: 'worker-still-running', pid: 4242 }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.ABORT);
    expect(failure.cause).toContain('PID 4242');
    expect(failure.remediation).toContain('npx claude-mem stop');
    expect(failure.remediation).toContain('4242');
  });

  it('only warns when the port was taken again after the worker stopped, and prints no kill command', () => {
    const failure = workerShutdownFailure({ kind: 'port-rebound', ownerPid: null }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.WARN_CONTINUE);
    expect(failure.remediation).toContain('npx claude-mem restart');
    expect(failure.remediation).not.toMatch(/taskkill|\bkill\b/);
  });

  it('aborts without a kill command for a worker identified only by its HTTP answers', () => {
    const failure = workerShutdownFailure({ kind: 'worker-still-running', pid: null }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.ABORT);
    expect(failure.remediation).toContain('npx claude-mem stop');
    expect(failure.remediation).not.toMatch(/taskkill|\bkill\b/);
  });

  it('names a verified respawned worker in the warning without telling the user to kill it', () => {
    const failure = workerShutdownFailure({ kind: 'port-rebound', ownerPid: 5151 }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.WARN_CONTINUE);
    expect(failure.cause).toContain('PID 5151');
    expect(failure.remediation).not.toMatch(/taskkill|\bkill\b/);
  });

  it('only warns for a foreign process, so the install still reaches sign-in', () => {
    const failure = workerShutdownFailure({ kind: 'port-held-by-other-process' }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.WARN_CONTINUE);
    expect(failure.cause).toContain(`Port ${PORT}`);
    expect(failure.remediation).toContain('CLAUDE_MEM_WORKER_PORT');
  });
});

function fakeStop(result: ShutdownResult | Error) {
  const calls: Array<number | string> = [];
  const stop = async (port: number | string): Promise<ShutdownResult> => {
    calls.push(port);
    if (result instanceof Error) throw result;
    return result;
  };
  return { stop, calls };
}

describe('installer pre-overwrite stop — never aborts before sign-in without a live worker', () => {
  const originalAutostart = process.env.CLAUDE_MEM_WORKER_AUTOSTART;
  afterEach(() => {
    if (originalAutostart === undefined) delete process.env.CLAUDE_MEM_WORKER_AUTOSTART;
    else process.env.CLAUDE_MEM_WORKER_AUTOSTART = originalAutostart;
  });

  it('leaves an externally managed worker running (CLAUDE_MEM_WORKER_AUTOSTART=false) and warns once', async () => {
    process.env.CLAUDE_MEM_WORKER_AUTOSTART = 'false';
    const { stop, calls } = fakeStop({ workerWasRunning: true, stopped: true });
    const summary = createInstallSummary();

    await requireWorkerStopped(PORT, 'pre-overwrite', summary, { stopWorker: stop });
    await requireWorkerStopped(PORT, 'provider-cutover', summary, { stopWorker: stop });

    expect(calls).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0].message).toContain('CLAUDE_MEM_WORKER_AUTOSTART=false');
  });

  it('warns and continues when the port was taken again after the worker stopped', async () => {
    const { stop } = fakeStop({ workerWasRunning: true, stopped: false, blocker: { kind: 'port-rebound', ownerPid: null } });
    const summary = createInstallSummary();

    await expect(requireWorkerStopped(PORT, 'pre-overwrite', summary, { stopWorker: stop })).resolves.toBeUndefined();
    expect(summary.warnings).toHaveLength(1);
  });

  it('warns and continues when the stop itself fails and no live worker owns the port', async () => {
    const { stop } = fakeStop(new Error('probe exploded'));
    const summary = createInstallSummary();

    await expect(
      requireWorkerStopped(PORT, 'pre-overwrite', summary, { stopWorker: stop, readOwnedWorker: () => null }),
    ).resolves.toBeUndefined();
    expect(summary.warnings[0].message).toContain('probe exploded');
  });

  it('still aborts when the stop fails but the PID file shows a live worker on the port', async () => {
    const { stop } = fakeStop(new Error('probe exploded'));
    await expect(
      requireWorkerStopped(PORT, 'pre-overwrite', createInstallSummary(), { stopWorker: stop, readOwnedWorker: () => ownedWorker() }),
    ).rejects.toBeInstanceOf(InstallAbortError);
  });

  it('aborts only for the verified live worker that did not stop', async () => {
    const { stop } = fakeStop({ workerWasRunning: true, stopped: false, blocker: { kind: 'worker-still-running', pid: 4242 } });
    await expect(requireWorkerStopped(PORT, 'pre-overwrite', createInstallSummary(), { stopWorker: stop })).rejects.toBeInstanceOf(InstallAbortError);
  });
});

describe('installer holds the spawn lock from the stop through the overwrite', () => {
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-install-lock-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps every launcher from spawning while the worker stops and the files are overwritten', async () => {
    // acquireSpawnLock() is what a hook, the MCP server or `start` calls before
    // a lazy spawn; false means it must skip the spawn.
    const launcherCouldSpawn: boolean[] = [];
    const stop = async (): Promise<ShutdownResult> => {
      launcherCouldSpawn.push(acquireSpawnLock());
      return { workerWasRunning: true, stopped: true };
    };

    await overwriteWithWorkerStopped(PORT, createInstallSummary(), async () => {
      launcherCouldSpawn.push(acquireSpawnLock());
    }, { stopWorker: stop });

    expect(launcherCouldSpawn).toEqual([false, false]);
    expect(existsSync(join(dataDir, 'spawn.lock'))).toBe(false);
  });

  it('releases the lock when the stop aborts the install', async () => {
    const stop = async (): Promise<ShutdownResult> => ({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: 4242 },
    });
    await expect(overwriteWithWorkerStopped(PORT, createInstallSummary(), async () => {}, { stopWorker: stop })).rejects.toBeInstanceOf(InstallAbortError);
    expect(existsSync(join(dataDir, 'spawn.lock'))).toBe(false);
  });

  it('when another process keeps the lock, still overwrites but warns how to recover', async () => {
    // A live holder that keeps its lock fresh (another install running now).
    const holderPayload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    writeFileSync(join(dataDir, 'spawn.lock'), holderPayload);
    const summary = createInstallSummary();
    let overwritten = false;

    await overwriteWithWorkerStopped(PORT, summary, async () => {
      overwritten = true;
    }, { stopWorker: async () => ({ workerWasRunning: false, stopped: true }), spawnLockWaitMs: 300 });

    expect(overwritten).toBe(true);
    expect(summary.warnings.map((warning) => warning.message).join('\n')).toContain('spawn lock');
    expect(readFileSync(join(dataDir, 'spawn.lock'), 'utf-8')).toBe(holderPayload);
  });
});

describe('uninstall reaction to the worker stop (shares the helper)', () => {
  it('names a worker that did not stop and keeps cleaning up', () => {
    expect(uninstallShutdownNotice({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: 4242 },
    })).toEqual({ level: 'warn', message: 'Worker service (PID 4242) did not confirm shutdown; continuing uninstall cleanup.' });
  });

  it('does not blame claude-mem for a foreign listener', () => {
    expect(uninstallShutdownNotice({
      workerWasRunning: false,
      stopped: false,
      blocker: { kind: 'port-held-by-other-process' },
    })?.level).toBe('info');
  });

  it('stays quiet when no worker was running', () => {
    expect(uninstallShutdownNotice({ workerWasRunning: false, stopped: true })).toBeNull();
  });

  it('says the worker stopped when the port was taken again, without a kill hint', () => {
    expect(uninstallShutdownNotice({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'port-rebound', ownerPid: 5151 },
    })).toEqual({
      level: 'warn',
      message: 'Worker service stopped, but another claude-mem worker (PID 5151) took its port again; continuing uninstall cleanup.',
    });
  });
});
