import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import { logger } from '../../src/utils/logger.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realProcessManagerSnapshot = { ...realProcessManager };
const realHealthMonitorSnapshot = { ...realHealthMonitor };

// Phase 4 (liveness over deadlines): the hook decides "ready / booting /
// wedged" from ONE GET /api/ready read instead of polling /api/readiness and
// guessing from uptime. failed ⇒ recycle, close without a terminal phase ⇒
// recycle, silence (before or after headers) ⇒ recycle only once the same pid
// stays silent ≥30 s across hooks, ready ⇒ go, progress under a spent budget ⇒
// leave it alone, 404 ⇒ legacy probe.

const VERSION = '13.4.0';
const WEDGED_PID = 4343;

type ReadyScenario =
  | { kind: 'phases'; phases: Array<{ phase: string; message?: string }>; then: 'end' | 'hang' | 'ping' }
  | { kind: 'status'; status: number }
  /** Accepts the connection, never sends response headers (event loop blocked). */
  | { kind: 'no_headers' };

const READY_SUCCESSOR: ReadyScenario = { kind: 'phases', phases: [{ phase: 'starting' }, { phase: 'ready' }], then: 'end' };

/** What the worker currently on the port answers on /api/ready. */
let wedgedWorkerScenario: ReadyScenario;
/** What a spawned successor answers on /api/ready. */
let successorScenario: ReadyScenario = READY_SUCCESSOR;
let wedgedWorkerAlive = true;
let successorUp = false;
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;
const fetchLog: string[] = [];
const spawnCalls: string[] = [];

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve({ matches: true, pluginVersion: VERSION, workerVersion: VERSION }),
  isPortInUse: () => Promise.resolve(false),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
  readOwnedWorkerPidInfo: () => ownedPidInfo,
}));

mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  ...realProcessManagerSnapshot,
  resolveWorkerRuntimePath: () => '/usr/bin/bun',
  spawnDetachedWorkerDaemon: (_runtimePath: string, scriptPath: string) => {
    spawnCalls.push(scriptPath);
    successorUp = true;
    return 0;
  },
}));

mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  ...realHealthMonitorSnapshot,
  checkVersionMatch: () => Promise.resolve({ matches: true, pluginVersion: VERSION, workerVersion: VERSION }),
  isPortInUse: () => Promise.resolve(false),
  classifyPortOccupancy: () => Promise.resolve('free'),
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-ready-stream=${Date.now()}-${Math.random()}`);
}

const encoder = new TextEncoder();
const phaseFrame = (phase: string, message?: string) =>
  `event: phase\ndata: ${JSON.stringify({ phase, ...(message ? { message } : {}), version: VERSION, pid: WEDGED_PID })}\n\n`;

/** An SSE body that honours the request's abort signal, like a real socket. */
function readyStreamResponse(scenario: Extract<ReadyScenario, { kind: 'phases' }>, signal: AbortSignal | null | undefined): Response {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = (reason: unknown) => {
        if (pingTimer) clearInterval(pingTimer);
        try { controller.error(reason); } catch { /* already closed */ }
      };
      signal?.addEventListener('abort', () => stop(signal.reason), { once: true });
      for (const { phase, message } of scenario.phases) controller.enqueue(encoder.encode(phaseFrame(phase, message)));
      if (scenario.then === 'end') controller.close();
      if (scenario.then === 'ping') {
        pingTimer = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 30);
      }
    },
    cancel() {
      if (pingTimer) clearInterval(pingTimer);
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchMock(): void {
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchLog.push(u);
    if (!wedgedWorkerAlive && !successorUp) {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1'));
    }
    if (u.endsWith('/api/health')) return Promise.resolve(jsonResponse({ version: VERSION, uptime: 1 }));
    if (u.endsWith('/api/ready')) {
      const scenario = wedgedWorkerAlive ? wedgedWorkerScenario : successorScenario;
      if (scenario.kind === 'status') {
        return Promise.resolve(jsonResponse({ error: 'Not found' }, scenario.status));
      }
      if (scenario.kind === 'no_headers') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      }
      return Promise.resolve(readyStreamResponse(scenario, init?.signal));
    }
    if (u.endsWith('/api/readiness')) return Promise.resolve(jsonResponse({ status: 'ready' }));
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
}

describe('worker readiness via GET /api/ready', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalScriptPath = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  let tempDataDir: string;
  let killSpy: ReturnType<typeof spyOn>;
  let killCalls: Array<{ pid: number; signal: string | number | undefined }>;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-ready-stream-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    const scriptPath = join(tempDataDir, 'worker-service.cjs');
    writeFileSync(scriptPath, '// worker bundle\n');
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = scriptPath;
    fetchLog.length = 0;
    spawnCalls.length = 0;
    wedgedWorkerAlive = true;
    successorUp = false;
    successorScenario = READY_SUCCESSOR;
    ownedPidInfo = null;
    killCalls = [];
    installFetchMock();
    killSpy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      wedgedWorkerAlive = false;
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    global.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalScriptPath === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalScriptPath;
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
    mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
  });

  async function loadWithOwnedPid() {
    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: WEDGED_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    return workerUtils;
  }

  it('ready ⇒ proceeds without killing, spawning, or touching /api/readiness', async () => {
    wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'starting' }, { phase: 'db_ready' }, { phase: 'ready' }], then: 'end' };
    const workerUtils = await loadWithOwnedPid();

    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(killCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    expect(fetchLog.some(url => url.endsWith('/api/readiness'))).toBe(false);
  });

  it('failed ⇒ SIGKILLs the worker at once and spawns a successor', async () => {
    wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'starting' }, { phase: 'failed', message: 'bun:sqlite exploded' }], then: 'end' };
    const workerUtils = await loadWithOwnedPid();

    const startedAt = Date.now();
    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(killCalls).toEqual([{ pid: WEDGED_PID, signal: 'SIGKILL' }]);
    expect(spawnCalls).toHaveLength(1);
  });

  it('close without a terminal phase ⇒ treated as wedged (never as ready) and recycled', async () => {
    wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'starting' }], then: 'end' };
    const workerUtils = await loadWithOwnedPid();

    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(killCalls).toEqual([{ pid: WEDGED_PID, signal: 'SIGKILL' }]);
    expect(spawnCalls).toHaveLength(1);
  });

  describe('post-header silence (headers sent, then no phase or ping)', () => {
    const unresponsiveRecordPath = () => join(tempDataDir, 'worker-unresponsive.json');

    it('once ⇒ unresponsive: skips the hook without killing and records the pid', async () => {
      wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'starting' }], then: 'hang' };
      const workerUtils = await loadWithOwnedPid();

      const startedAt = Date.now();
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      const elapsedMs = Date.now() - startedAt;
      // The 5 s idle window, not the 10 s readiness budget, decided.
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      expect(elapsedMs).toBeLessThan(9_000);
      expect(killCalls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(0);
      expect(JSON.parse(readFileSync(unresponsiveRecordPath(), 'utf-8')).pid).toBe(WEDGED_PID);
    }, 15_000);

    it('same pid silent for ≥30 s across hooks (headers do not reset the record) ⇒ wedged ⇒ recycled', async () => {
      wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'starting' }], then: 'hang' };
      const workerUtils = await loadWithOwnedPid();
      writeFileSync(unresponsiveRecordPath(), JSON.stringify({ pid: WEDGED_PID, firstUnresponsiveAtEpochMs: Date.now() - 31_000 }));

      expect(await workerUtils.ensureWorkerRunning()).toBe(true);
      expect(killCalls).toEqual([{ pid: WEDGED_PID, signal: 'SIGKILL' }]);
      expect(spawnCalls).toHaveLength(1);
      expect(existsSync(unresponsiveRecordPath())).toBe(false);
    }, 15_000);
  });

  it('progress still arriving when the hook budget runs out ⇒ booting: no kill, no spawn', async () => {
    wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'starting' }, { phase: 'db_ready' }], then: 'ping' };
    const workerUtils = await loadWithOwnedPid();

    expect(await workerUtils.ensureWorkerRunning(400)).toBe(false);
    expect(killCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it('404 (older worker without /api/ready) ⇒ falls back to the /api/readiness probe once', async () => {
    wedgedWorkerScenario = { kind: 'status', status: 404 };
    const workerUtils = await loadWithOwnedPid();

    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(fetchLog.filter(url => url.endsWith('/api/ready'))).toHaveLength(1);
    expect(fetchLog.filter(url => url.endsWith('/api/readiness'))).toHaveLength(1);
    expect(killCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it('bounded startup (executeWithWorkerFallback + workerStartupTimeoutMs): failed ⇒ recycle, then the request runs', async () => {
    wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'failed', message: 'migration threw' }], then: 'end' };
    const workerUtils = await loadWithOwnedPid();

    const result = await workerUtils.executeWithWorkerFallback('/api/test', 'GET', undefined, {
      workerStartupTimeoutMs: 3_000,
      timeoutMs: 1_000,
    });

    expect(workerUtils.isWorkerFallback(result)).toBe(false);
    expect(killCalls).toEqual([{ pid: WEDGED_PID, signal: 'SIGKILL' }]);
    expect(spawnCalls).toHaveLength(1);
    expect(fetchLog.at(-1)).toEndWith('/api/test');
  });

  describe('restart-storm guard: same boot failure from the same bundle is recycled once', () => {
    let errorSpy: ReturnType<typeof spyOn>;
    beforeEach(() => { errorSpy = spyOn(logger, 'error'); });
    afterEach(() => { errorSpy.mockRestore(); });

    const stormErrors = () => errorSpy.mock.calls.filter(call => String(call[1]).includes('not recycling again'));

    it('same failure twice ⇒ second recycle refused, error logged once, hook skipped', async () => {
      wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'failed', message: 'SQLITE_CORRUPT: database disk image is malformed' }], then: 'end' };
      successorScenario = wedgedWorkerScenario;
      const workerUtils = await loadWithOwnedPid();

      // Hook 1: recycles the failing worker; the successor fails the same way.
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toHaveLength(1);
      expect(spawnCalls).toHaveLength(1);

      // Hook 2: same bundle, same message ⇒ no kill, no spawn, one error.
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toHaveLength(1);
      expect(spawnCalls).toHaveLength(1);
      expect(stormErrors()).toHaveLength(1);
      expect(JSON.stringify(stormErrors()[0])).toContain('SQLITE_CORRUPT');
      expect(JSON.stringify(stormErrors()[0])).toContain('npx claude-mem doctor');

      // Hook 3: still refused, but the error is not repeated.
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toHaveLength(1);
      expect(stormErrors()).toHaveLength(1);
    });

    it('different failure message ⇒ recycle allowed', async () => {
      wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'failed', message: 'migration 42 threw' }], then: 'end' };
      successorScenario = { kind: 'phases', phases: [{ phase: 'failed', message: 'migration 43 threw' }], then: 'end' };
      const workerUtils = await loadWithOwnedPid();

      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toHaveLength(2);
      expect(spawnCalls).toHaveLength(2);
      expect(stormErrors()).toHaveLength(0);
    });

    it('different build key ⇒ recycle allowed', async () => {
      wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'failed', message: 'migration 42 threw' }], then: 'end' };
      successorScenario = wedgedWorkerScenario;
      const workerUtils = await loadWithOwnedPid();

      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      // Reinstall: a new bundle on disk changes the build key.
      writeFileSync(process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH!, '// rebuilt worker bundle, different size\n');
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toHaveLength(2);
      expect(stormErrors()).toHaveLength(0);
    });
  });

  describe('pre-header silence (event loop blocked, e.g. bun:sqlite busy_timeout)', () => {
    const unresponsiveRecordPath = () => join(tempDataDir, 'worker-unresponsive.json');

    it('once ⇒ skips the hook without killing and records the pid', async () => {
      wedgedWorkerScenario = { kind: 'no_headers' };
      const workerUtils = await loadWithOwnedPid();

      const startedAt = Date.now();
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(9_000);
      expect(killCalls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(0);
      const record = JSON.parse(readFileSync(unresponsiveRecordPath(), 'utf-8'));
      expect(record.pid).toBe(WEDGED_PID);
      expect(Math.abs(record.firstUnresponsiveAtEpochMs - Date.now())).toBeLessThan(15_000);
    }, 15_000);

    it('same pid unresponsive for ≥30 s across hooks ⇒ wedged ⇒ recycled', async () => {
      wedgedWorkerScenario = { kind: 'no_headers' };
      const workerUtils = await loadWithOwnedPid();
      writeFileSync(unresponsiveRecordPath(), JSON.stringify({ pid: WEDGED_PID, firstUnresponsiveAtEpochMs: Date.now() - 31_000 }));

      expect(await workerUtils.ensureWorkerRunning()).toBe(true);
      expect(killCalls).toEqual([{ pid: WEDGED_PID, signal: 'SIGKILL' }]);
      expect(spawnCalls).toHaveLength(1);
      expect(existsSync(unresponsiveRecordPath())).toBe(false);
    }, 15_000);

    it('an old record for a DIFFERENT pid does not count ⇒ no kill, record restarts for this pid', async () => {
      wedgedWorkerScenario = { kind: 'no_headers' };
      const workerUtils = await loadWithOwnedPid();
      writeFileSync(unresponsiveRecordPath(), JSON.stringify({ pid: WEDGED_PID + 1, firstUnresponsiveAtEpochMs: Date.now() - 60_000 }));

      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toHaveLength(0);
      expect(JSON.parse(readFileSync(unresponsiveRecordPath(), 'utf-8')).pid).toBe(WEDGED_PID);
    }, 15_000);

    it('a ready read clears the record', async () => {
      wedgedWorkerScenario = { kind: 'phases', phases: [{ phase: 'ready' }], then: 'end' };
      const workerUtils = await loadWithOwnedPid();
      writeFileSync(unresponsiveRecordPath(), JSON.stringify({ pid: WEDGED_PID, firstUnresponsiveAtEpochMs: Date.now() - 20_000 }));

      expect(await workerUtils.ensureWorkerRunning()).toBe(true);
      expect(existsSync(unresponsiveRecordPath())).toBe(false);
    });

    it('bounded startup: pre-header silence once ⇒ no kill and no second worker spawned', async () => {
      wedgedWorkerScenario = { kind: 'no_headers' };
      const workerUtils = await loadWithOwnedPid();

      const result = await workerUtils.executeWithWorkerFallback('/api/test', 'GET', undefined, {
        workerStartupTimeoutMs: 7_000,
        timeoutMs: 1_000,
      });

      expect(workerUtils.isWorkerFallback(result)).toBe(true);
      expect(killCalls).toHaveLength(0);
      expect(spawnCalls).toHaveLength(0);
    }, 15_000);
  });
});
