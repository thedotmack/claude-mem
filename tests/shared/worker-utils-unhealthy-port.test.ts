import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realPortReclaim from '../../src/shared/port-reclaim.js';
import * as realSpawnGate from '../../src/shared/worker-spawn-gate.js';
import { logger } from '../../src/utils/logger.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realSupervisorSnapshot = { ...realSupervisor };
const realProcessManagerSnapshot = { ...realProcessManager };
const realPortReclaimSnapshot = { ...realPortReclaim };
const realSpawnGateSnapshot = { ...realSpawnGate };
const spawnCalls: string[] = [];
const classifierTimeouts: number[] = [];
let occupancy: 'free' | 'occupied' | 'indeterminate' = 'occupied';
let classifierResults: Array<'free' | 'occupied' | 'indeterminate'> = [];
let versionMatch = { matches: true, pluginVersion: '13.15.2', workerVersion: '13.15.2' };
let versionCheckCalls = 0;
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;
let spawnLockResult = true;
const reclaimCalls: number[] = [];
let reclaimResult: { reclaimed: boolean; reason?: string; killedPids: number[] } = {
  reclaimed: false,
  reason: 'not-supported',
  killedPids: [],
};

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => {
    versionCheckCalls += 1;
    return Promise.resolve(versionMatch);
  },
}));
mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  ...realHealthMonitorSnapshot,
  checkVersionMatch: () => {
    versionCheckCalls += 1;
    return Promise.resolve(versionMatch);
  },
  classifyPortOccupancy: (_port: number, timeoutMs: number) => {
    classifierTimeouts.push(timeoutMs);
    return Promise.resolve(classifierResults.shift() ?? occupancy);
  },
}));
mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'missing',
  readOwnedWorkerPidInfo: () => ownedPidInfo,
}));
// Every lazy spawn goes through the one hidden-daemon helper (#3529).
mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  ...realProcessManagerSnapshot,
  spawnDetachedWorkerDaemon: (runtimePath: string) => {
    spawnCalls.push(runtimePath);
    return 4343;
  },
}));
// The gate's one reclaim attempt on an occupied port; the real one shells out
// to netstat/lsof, so it is stubbed and asserted here.
mock.module('../../src/shared/port-reclaim.js', () => ({
  ...realPortReclaimSnapshot,
  reclaimGhostListeningPort: (port: number) => {
    reclaimCalls.push(port);
    return Promise.resolve(reclaimResult);
  },
}));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({
  acquireSpawnLock: () => spawnLockResult,
  releaseSpawnLock: () => {},
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?unhealthy-port=${Date.now()}-${Math.random()}`);
}

describe('ensureWorkerRunning — unhealthy port guard', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalScript = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  let dataDir: string;
  let scriptPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-unhealthy-port-'));
    scriptPath = join(dataDir, 'worker-service.cjs');
    writeFileSync(scriptPath, '');
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = scriptPath;
    spawnCalls.length = 0;
    classifierTimeouts.length = 0;
    classifierResults = [];
    occupancy = 'occupied';
    versionMatch = { matches: true, pluginVersion: '13.15.2', workerVersion: '13.15.2' };
    versionCheckCalls = 0;
    ownedPidInfo = null;
    spawnLockResult = true;
    reclaimCalls.length = 0;
    reclaimResult = { reclaimed: false, reason: 'not-supported', killedPids: [] };
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') } as unknown as Response));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalScript === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalScript;
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
    mock.module('../../src/shared/port-reclaim.js', () => realPortReclaimSnapshot);
    mock.module('../../src/shared/worker-spawn-gate.js', () => realSpawnGateSnapshot);
  });

  it('wedged listener returns fallback without spawn', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();
    expect(result).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it('proven-free bind reaches the existing spawn gate once', async () => {
    occupancy = 'free';
    let healthCalls = 0;
    global.fetch = mock(() => {
      healthCalls += 1;
      return Promise.resolve({ ok: healthCalls > 1, status: healthCalls > 1 ? 200 : 503, text: () => Promise.resolve('') } as unknown as Response);
    });
    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();
    expect(result).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  it('waits for an active spawn lock without binding the worker port', async () => {
    spawnLockResult = false;
    let healthCalls = 0;
    global.fetch = mock(() => {
      healthCalls += 1;
      return Promise.resolve({ ok: healthCalls > 1, status: healthCalls > 1 ? 200 : 503, text: () => Promise.resolve('') } as unknown as Response);
    });
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(classifierTimeouts).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it('passes positive remaining time to the health and bind probes', async () => {
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(5000);
      return {} as AbortSignal;
    });
    classifierResults = ['indeterminate'];
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(false);
    expect(classifierTimeouts[0]).toBeGreaterThan(0);
    expect(classifierTimeouts[0]).toBeLessThanOrEqual(5000);
    expect(timeoutSpy).toHaveBeenCalled();
    timeoutSpy.mockRestore();
  });

  it('does not start a bind probe after the deadline expires', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    let nowCalls = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      return nowCalls <= 2 ? 1000 : 6001;
    });
    expect(await workerUtils.ensureWorkerRunning()).toBe(false);
    expect(classifierTimeouts).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    nowSpy.mockRestore();
  });

  it('does not suppress verified stale-worker recycling when the port wait consumes the deadline', async () => {
    versionMatch = { matches: false, pluginVersion: '13.15.2', workerVersion: '13.14.0' };
    // The killed worker's port binds free again (the release check after the
    // kill is a bind probe since #3416; the recycle path skips the pre-spawn gate).
    occupancy = 'free';
    delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: 4242, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    let nowCalls = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      return nowCalls <= 2 ? 1000 : 7000;
    });
    const killSpy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      expect(pid).toBe(4242);
      expect(signal).toBe('SIGKILL');
      return true;
    }) as typeof process.kill);
    let healthCalls = 0;
    global.fetch = mock((url: string) => {
      if (url.includes('/api/health')) {
        healthCalls += 1;
        if (healthCalls <= 2) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
            json: () => Promise.resolve({ version: '13.14.0' }),
          } as unknown as Response);
        }
        if (healthCalls === 3) {
          return Promise.reject(new Error('connect ECONNREFUSED'));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({ version: '13.15.2' }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') } as unknown as Response);
    }) as unknown as typeof fetch;
    const result = await workerUtils.ensureWorkerRunning();
    expect(result).toBe(true);
    expect(versionCheckCalls).toBe(1);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toHaveLength(1);
    nowSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('indeterminate bind does not spawn, and does not try to reclaim either', async () => {
    occupancy = 'indeterminate';
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
    expect(reclaimCalls).toHaveLength(0);
  });

  it('occupied port: reclaims exactly once and spawns when the reclaim freed it', async () => {
    occupancy = 'occupied';
    reclaimResult = { reclaimed: true, killedPids: [3001] };
    let healthCalls = 0;
    global.fetch = mock(() => {
      healthCalls += 1;
      return Promise.resolve({ ok: healthCalls > 1, status: healthCalls > 1 ? 200 : 503, text: () => Promise.resolve('') } as unknown as Response);
    });
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(reclaimCalls).toEqual([workerUtils.getWorkerPort()]);
    expect(spawnCalls).toHaveLength(1);
  });

  it('occupied port the reclaim cannot free: no spawn, one reclaim, and the orphaned port is diagnosed', async () => {
    occupancy = 'occupied';
    reclaimResult = { reclaimed: false, reason: 'owner-alive', killedPids: [] };
    ownedPidInfo = null;
    const workerUtils = await importWorkerUtilsFresh();
    const warnSpy = spyOn(logger, 'warn');
    try {
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(reclaimCalls).toHaveLength(1);
      expect(spawnCalls).toHaveLength(0);
      const gateWarning = warnSpy.mock.calls.find(([, message]) => String(message).includes('skipping lazy-spawn'));
      expect(gateWarning?.[2]).toMatchObject({ reclaimReason: 'owner-alive', fix: expect.any(String) });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not call the port orphaned when our own PID file claims the listener', async () => {
    occupancy = 'occupied';
    reclaimResult = { reclaimed: false, reason: 'owner-booting', killedPids: [] };
    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: 5151, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const warnSpy = spyOn(logger, 'warn');
    try {
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      const gateWarning = warnSpy.mock.calls.find(([, message]) => String(message).includes('skipping lazy-spawn'));
      expect(gateWarning?.[2]).toMatchObject({ reclaimReason: 'owner-booting' });
      expect((gateWarning?.[2] as Record<string, unknown>).fix).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('caches the failed fallback for later calls in the same hook process', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(false);
    occupancy = 'free';
    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });
});
