
import { beforeEach, describe, it, expect, mock } from 'bun:test';
import { HOOK_TIMEOUTS } from '../../src/shared/hook-constants.js';

let healthResponse = false;
let healthResponses: boolean[] = [];
let readinessResponse = false;
let portInUse = false;
let pidFileStatus: 'missing' | 'alive' = 'missing';
let spawnLock = true;
let spawnCalls = 0;
let healthTimeouts: number[] = [];
let portChecks = 0;
mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  isPortInUse: async () => {
    portChecks++;
    return portInUse;
  },
  waitForHealth: async (_port: number, timeoutMs: number) => {
    healthTimeouts.push(timeoutMs);
    return healthResponses.length > 0 ? healthResponses.shift()! : healthResponse;
  },
  waitForReadiness: async () => readinessResponse,
}));
mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  cleanStalePidFile: () => pidFileStatus,
  getPlatformTimeout: (timeout: number) => timeout,
  spawnDaemon: () => { spawnCalls++; return 12345; },
  touchPidFile: () => {},
}));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({
  acquireSpawnLock: () => spawnLock,
  releaseSpawnLock: () => {},
}));

const { ensureWorkerStarted } = await import('../../src/services/worker-spawner.js');

describe('ensureWorkerStarted validation guards', () => {
  beforeEach(() => {
    healthResponse = false;
    readinessResponse = false;
    portInUse = false;
    pidFileStatus = 'missing';
    spawnLock = true;
    spawnCalls = 0;
    healthResponses = [];
    healthTimeouts = [];
    portChecks = 0;
  });

  it('returns "dead" when workerScriptPath is empty string', async () => {
    const result = await ensureWorkerStarted(39001, '');
    expect(result).toBe('dead');
  });

  it('returns "dead" when workerScriptPath does not exist on disk', async () => {
    const bogusPath = '/tmp/__claude-mem-test-nonexistent-worker-script-' + Date.now() + '.cjs';
    const result = await ensureWorkerStarted(39002, bogusPath);
    expect(result).toBe('dead');
  });

  it('returns "dead" when the spawned worker never answers health', async () => {
    const result = await ensureWorkerStarted(39003, process.execPath);

    expect(result).toBe('dead');
  });

  it('returns "dead" when a lock loser never sees the other launcher become healthy', async () => {
    spawnLock = false;

    const result = await ensureWorkerStarted(39004, process.execPath);

    expect(result).toBe('dead');
    expect(spawnCalls).toBe(0);
  });

  it('returns "ready" for an occupied healthy worker after the initial health miss, without spawning', async () => {
    portInUse = true;
    healthResponses = [false, true];
    readinessResponse = true;

    const result = await ensureWorkerStarted(39005, process.execPath);

    expect(result).toBe('ready');
    expect(spawnCalls).toBe(0);
    expect(portChecks).toBe(1);
    expect(healthTimeouts).toEqual([1000, HOOK_TIMEOUTS.PORT_IN_USE_WAIT]);
  });

  it('returns "warming" when health succeeds but readiness does not', async () => {
    healthResponse = true;
    readinessResponse = false;

    const result = await ensureWorkerStarted(39006, process.execPath);

    expect(result).toBe('warming');
    expect(spawnCalls).toBe(0);
  });
});
