import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };
const spawnCalls: string[] = [];
const classifierTimeouts: number[] = [];
let occupancy: 'free' | 'occupied' | 'indeterminate' = 'occupied';
let classifierResults: Array<'free' | 'occupied' | 'indeterminate'> = [];
let versionMatch = { matches: true, pluginVersion: '13.15.2', workerVersion: '13.15.2' };
let versionCheckCalls = 0;
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;

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
mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string) => {
    spawnCalls.push(command);
    return { unref: () => {} };
  },
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
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
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
    writeFileSync(join(dataDir, 'spawn.lock'), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString() }));
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

  it('indeterminate bind does not spawn', async () => {
    occupancy = 'indeterminate';
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it('caches the failed fallback for later calls in the same hook process', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(false);
    occupancy = 'free';
    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });
});
