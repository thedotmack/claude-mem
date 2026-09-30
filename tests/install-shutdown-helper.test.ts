import { afterEach, describe, expect, it } from 'bun:test';
import { createServer } from 'node:net';
import {
  probeLoopbackPort,
  shutdownWorkerAndWait,
  type PortProbeResult,
  type ShutdownProbes,
} from '../src/services/install/shutdown-helper';
import type { PidInfo } from '../src/supervisor/process-registry';
import { workerShutdownFailure } from '../src/npx-cli/commands/install';
import { uninstallShutdownNotice } from '../src/npx-cli/commands/uninstall';
import { ErrorSeverity } from '../src/npx-cli/install/error-taxonomy';

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
  owned?: PidInfo | null;
  /** Answers for successive liveness checks of the owned worker; the last one repeats. */
  alive?: boolean[];
  /** Answers for successive port probes; the last one repeats. */
  port?: PortProbeResult[];
}

function probes(evidence: FakeEvidence = {}): ShutdownProbes & { probeTimeouts: number[] } {
  const alive = [...(evidence.alive ?? [false])];
  const port = [...(evidence.port ?? ['refused'])];
  const probeTimeouts: number[] = [];
  return {
    probeTimeouts,
    readOwnedWorker: () => evidence.owned ?? null,
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

  it('fails closed until the accepted shutdown actually frees the port', async () => {
    fetchResponds(200);
    await expect(shutdownWorkerAndWait(PORT, 0, probes({ owned: null, port: ['open'] }))).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: null },
    });
  });

  it('reports the worker stopped once its process exits and the port refuses', async () => {
    fetchResponds(200);
    await expect(
      shutdownWorkerAndWait(PORT, 2000, probes({ owned: ownedWorker(), alive: [true, false], port: ['refused'] })),
    ).resolves.toEqual({ workerWasRunning: true, stopped: true });
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

  it('keeps the generic abort when the stuck worker has no readable PID', () => {
    const failure = workerShutdownFailure({ kind: 'worker-still-running', pid: null }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.ABORT);
    expect(failure.remediation).toContain('npx claude-mem stop');
  });

  it('only warns for a foreign process, so the install still reaches sign-in', () => {
    const failure = workerShutdownFailure({ kind: 'port-held-by-other-process' }, PORT);
    expect(failure.severity).toBe(ErrorSeverity.WARN_CONTINUE);
    expect(failure.cause).toContain(`Port ${PORT}`);
    expect(failure.remediation).toContain('CLAUDE_MEM_WORKER_PORT');
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
});
