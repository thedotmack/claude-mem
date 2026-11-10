import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyRestartedWorker, verifyWorkerFinishedStarting, getCurrentWorkerPid } from '../../src/services/restart-verify.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { InitPhaseTracker } from '../../src/services/server/init-phase.js';
import { clearPortCache } from '../../src/shared/worker-utils.js';
import { logger } from '../../src/utils/logger.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';

// verifyRestartedWorker lives in src/services/restart-verify.ts (not
// worker-service.ts) precisely so this test can import it without triggering
// worker-service.ts's top-level side effects (isMainModule bootstrap, bun:sqlite,
// MCP SDK, telemetry).

const EXPECTED_VERSION = '13.5.5-test';
const OLD_PID = 11111;
const NEW_PID = 22222;
const PORT = 45678; // arbitrary; port is always injected, never resolved here

// Record every HTTP call the verifier makes (same fetchLog pattern as
// tests/shared/worker-utils-version-recycle.test.ts).
const fetchLog: Array<{ url: string; method: string }> = [];

// Each test sets this to script what /api/health reports per call.
// 'unreachable' rejects the fetch like a connection refusal. The
// `{ status, body }` form scripts a non-200 response (e.g. 503 degraded).
let healthResponder: (callIndex: number) =>
  | { pid?: number; version?: string }
  | { status: number; body: { pid?: number; version?: string } }
  | 'unreachable';

function installFetchMock(): void {
  fetchLog.length = 0;
  let callIndex = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: u, method });

    const scripted = healthResponder(callIndex++);
    if (scripted === 'unreachable') {
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    const status = 'body' in scripted ? scripted.status : 200;
    const body = 'body' in scripted ? scripted.body : scripted;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

// Short injectable deadline + poll interval so every test completes fast.
const FAST = { pollIntervalMs: 10, requestTimeoutMs: 100 };
const DEADLINE_MS = 300;

async function supportsIpv6Loopback(): Promise<boolean> {
  const probe = http.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.close(() => undefined);
      if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(error.code ?? '')) {
        resolve(false);
      } else {
        reject(error);
      }
    });
    probe.listen(0, '::1', () => {
      probe.close(error => error ? reject(error) : resolve(true));
    });
  });
}

const ipv6LoopbackSupported = await supportsIpv6Loopback();

describe('verifyRestartedWorker — restart must prove itself', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('succeeds when health flips to the new pid with the expected version', async () => {
    // First poll still sees the old worker, then the new one comes up.
    healthResponder = i =>
      i === 0
        ? { pid: OLD_PID, version: EXPECTED_VERSION }
        : { pid: NEW_PID, version: EXPECTED_VERSION };

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(NEW_PID);
      expect(result.version).toBe(EXPECTED_VERSION);
    }
    // It polled /api/health (only pid + version are read — no /api/version).
    expect(fetchLog.length).toBeGreaterThanOrEqual(2);
    expect(fetchLog.every(c => c.url.includes('/api/health') && c.method === 'GET')).toBe(true);
  });

  it('succeeds when health answers 503 (degraded) but reports the new pid and expected version', async () => {
    // /api/health returns 503 when the queue is degraded but still includes
    // pid/version — a degraded-but-booted worker still proves the restart.
    healthResponder = () => ({ status: 503, body: { pid: NEW_PID, version: EXPECTED_VERSION } });

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(NEW_PID);
      expect(result.version).toBe(EXPECTED_VERSION);
    }
  });

  it('succeeds on version alone when no previous worker existed (oldPid null)', async () => {
    // getCurrentWorkerPid returned null (nothing was listening before the
    // restart), so any pid counts — verification only requires the version.
    healthResponder = () => ({ pid: NEW_PID, version: EXPECTED_VERSION });

    const result = await verifyRestartedWorker(PORT, null, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(NEW_PID);
      expect(result.version).toBe(EXPECTED_VERSION);
    }
  });

  it('fails when health keeps returning the stale (old) pid', async () => {
    healthResponder = () => ({ pid: OLD_PID, version: EXPECTED_VERSION });

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastObserved).toContain(String(OLD_PID));
      // A live (stale) worker is serving — callers skip the port-free wait.
      expect(result.lastPollSawHealth).toBe(true);
    }
  });

  it('fails when the new worker reports the wrong version', async () => {
    healthResponder = () => ({ pid: NEW_PID, version: '0.0.1-stale' });

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastObserved).toContain('0.0.1-stale');
      // A live (wrong-version) worker is serving — callers skip the port-free wait.
      expect(result.lastPollSawHealth).toBe(true);
    }
  });

  it('fails on timeout when health is unreachable, reporting the connection error', async () => {
    healthResponder = () => 'unreachable';

    const start = Date.now();
    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastObserved).toContain('connection error');
      expect(result.lastObserved).toContain('ECONNREFUSED');
      // Nothing is serving on the port — callers may wait for it to free.
      expect(result.lastPollSawHealth).toBe(false);
    }
    // Hard cap: the deadline bounds the wait (generous slack for CI).
    expect(elapsed).toBeLessThan(DEADLINE_MS + 1000);
  });
});

describe('getCurrentWorkerPid — old-pid capture before shutdown', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the running worker pid from /api/health', async () => {
    healthResponder = () => ({ pid: OLD_PID, version: EXPECTED_VERSION });
    expect(await getCurrentWorkerPid(PORT, 100)).toBe(OLD_PID);
  });

  it('returns null when no worker is reachable', async () => {
    healthResponder = () => 'unreachable';
    expect(await getCurrentWorkerPid(PORT, 100)).toBeNull();
  });
});

describe('restart verification against an IPv6 worker host', () => {
  const originalHost = process.env.CLAUDE_MEM_WORKER_HOST;
  let server: http.Server | null = null;

  afterEach(async () => {
    if (originalHost === undefined) delete process.env.CLAUDE_MEM_WORKER_HOST;
    else process.env.CLAUDE_MEM_WORKER_HOST = originalHost;
    clearPortCache();
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it.skipIf(!ipv6LoopbackSupported)('reads the pid of a worker listening on ::1', async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ pid: OLD_PID, version: EXPECTED_VERSION }));
    });
    await new Promise<void>(resolve => server!.listen(0, '::1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    process.env.CLAUDE_MEM_WORKER_HOST = '::1';
    clearPortCache();

    expect(await getCurrentWorkerPid(port, 2000)).toBe(OLD_PID);
  });
});

// verifyWorkerFinishedStarting against the worker's real GET /api/ready
// (Server.ts handleReadyStream) driven by a real InitPhaseTracker: the phases
// a starting worker publishes, with its pid and baked version. The worker
// here is this test process, so its pid is process.pid.
describe('verifyWorkerFinishedStarting — the new worker must finish starting', () => {
  /** Short enough to keep each test fast; long enough for several reads of the stream. */
  const CEILING_MS = 1500;
  /** The real server pings every 2 s; this keeps a quiet stream alive in a 1.5 s test. */
  const PING_INTERVAL_MS = 40;
  let servers: Server[] = [];
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = (['info', 'debug', 'warn', 'error'] as const).map(level => spyOn(logger, level).mockImplementation(() => {}));
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());
    for (const server of servers.splice(0)) {
      if (server.getHttpServer()) await closeWorkerServer(server);
    }
  });

  /** Under Bun, close() after closeAllConnections() can report ERR_SERVER_NOT_RUNNING (tests/server/ready-stream.test.ts): the server is closed either way. */
  async function closeWorkerServer(server: Server): Promise<void> {
    await server.close().catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    });
  }

  function workerOptions(tracker: InitPhaseTracker): ServerOptions {
    return {
      getInitializationComplete: () => tracker.getInitPhase().phase === 'ready',
      initPhaseSource: tracker,
      readyStreamPingIntervalMs: PING_INTERVAL_MS,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    };
  }

  /** A worker whose startup phase the test moves; resolves to its port and the version it bakes in. */
  async function startWorker(tracker: InitPhaseTracker): Promise<{ port: number; version: string }> {
    const server = new Server(workerOptions(tracker));
    servers.push(server);
    const port = await listenOnEphemeralPort(server);
    const version = (await (await fetch(`http://127.0.0.1:${port}/api/version`)).json() as { version: string }).version;
    return { port, version };
  }

  it('waits through the starting phases and proves the worker once it reports ready', async () => {
    const tracker = new InitPhaseTracker();
    const { port, version } = await startWorker(tracker);
    setTimeout(() => tracker.setInitPhase('db_ready'), 100);
    setTimeout(() => tracker.setInitPhase('routes_ready'), 200);
    setTimeout(() => tracker.setInitPhase('ready'), 300);

    const result = await verifyWorkerFinishedStarting(port, OLD_PID, version, CEILING_MS);

    expect(result).toEqual({ ok: true, pid: process.pid, version });
  });

  it('a worker that answers with its pid and version but never finishes starting is not proven', async () => {
    const tracker = new InitPhaseTracker();
    tracker.setInitPhase('db_ready');
    const { port, version } = await startWorker(tracker);

    const ceilingMs = 250;
    const start = Date.now();
    const result = await verifyWorkerFinishedStarting(port, OLD_PID, version, ceilingMs);

    expect(result).toEqual({ ok: false, startupFailed: false, lastObserved: expect.stringContaining('"phase":"db_ready"') });
    // It waited out the whole ceiling, and no longer (generous slack for CI).
    expect(Date.now() - start).toBeGreaterThanOrEqual(ceilingMs);
    expect(Date.now() - start).toBeLessThan(ceilingMs + 2000);
    // The restart CLI's proof, which reads only /api/health, would have taken this worker.
    expect((await verifyRestartedWorker(port, OLD_PID, version, CEILING_MS, FAST)).ok).toBe(true);
  });

  it('stops at once when the worker reports that its startup failed, with its message', async () => {
    const tracker = new InitPhaseTracker();
    const { port, version } = await startWorker(tracker);
    setTimeout(() => tracker.setInitPhase('failed', 'SQLITE_CORRUPT: database disk image is malformed'), 100);

    const start = Date.now();
    const result = await verifyWorkerFinishedStarting(port, OLD_PID, version, 30_000);

    expect(result).toEqual({ ok: false, startupFailed: true, pid: process.pid, message: 'SQLITE_CORRUPT: database disk image is malformed' });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('does not take the old worker, or a worker on another version, even when it is ready', async () => {
    const tracker = new InitPhaseTracker();
    tracker.setInitPhase('ready');
    const { port, version } = await startWorker(tracker);

    const sameWorker = await verifyWorkerFinishedStarting(port, process.pid, version, 250);
    expect(sameWorker).toEqual({ ok: false, startupFailed: false, lastObserved: expect.stringContaining(`"pid":${process.pid}`) });

    const otherVersion = await verifyWorkerFinishedStarting(port, OLD_PID, '0.0.1-stale', 250);
    expect(otherVersion).toEqual({ ok: false, startupFailed: false, lastObserved: expect.stringContaining(`"version":"${version}"`) });
  });

  it('keeps waiting while nothing listens yet, and proves the worker that starts listening later', async () => {
    // Every Server in this process bakes in the same version.
    const { version } = await startWorker(new InitPhaseTracker());
    // A port that was free a moment ago, with nothing on it now.
    const probe = new Server(workerOptions(new InitPhaseTracker()));
    const port = await listenOnEphemeralPort(probe);
    await closeWorkerServer(probe);
    const tracker = new InitPhaseTracker();
    tracker.setInitPhase('ready');
    setTimeout(() => {
      const server = new Server(workerOptions(tracker));
      servers.push(server);
      void server.listen(port, '127.0.0.1');
    }, 300);

    const result = await verifyWorkerFinishedStarting(port, OLD_PID, version, 5_000);

    expect(result).toEqual({ ok: true, pid: process.pid, version });
  });

  it('a worker that goes silent (a migration holding its event loop) only starts the next read', async () => {
    const tracker = new InitPhaseTracker();
    const { port: realPort, version } = await startWorker(tracker);
    tracker.setInitPhase('ready');
    // A stand-in that accepts the first connection and answers nothing, then forwards to the real worker.
    let connections = 0;
    const silentThenReady = http.createServer((req, res) => {
      if (connections++ === 0) return;
      void fetch(`http://127.0.0.1:${realPort}${req.url}`).then(async upstream => {
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? '' });
        res.end(await upstream.text());
      });
    });
    await new Promise<void>(resolve => silentThenReady.listen(0, '127.0.0.1', () => resolve()));
    const port = (silentThenReady.address() as AddressInfo).port;
    try {
      const result = await verifyWorkerFinishedStarting(port, OLD_PID, version, 5_000, { idleTimeoutMs: 200, pollIntervalMs: 10 });
      expect(result).toEqual({ ok: true, pid: process.pid, version });
      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      silentThenReady.closeAllConnections();
      await new Promise<void>(resolve => silentThenReady.close(() => resolve()));
    }
  });
});
