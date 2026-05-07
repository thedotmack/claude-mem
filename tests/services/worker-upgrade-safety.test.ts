import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { VersionCheckResult } from '../../src/services/infrastructure/HealthMonitor.js';
import type { PidInfo } from '../../src/services/infrastructure/ProcessManager.js';
import {
  hasClaudeMemWorkerOwnershipProof,
  shutdownIncompatibleWorkerIfRunning,
  type WorkerUpgradeSafetyDependencies,
} from '../../src/services/worker-upgrade-safety.js';

const ownedWorkerPath =
  '/Users/test/.claude/plugins/cache/thedotmack/claude-mem/12.7.4/dist/worker-service.cjs';

let versionChecks: VersionCheckResult[] = [];
let healthDetails: Array<Record<string, unknown> | null> = [];
let healthChecks: boolean[] = [];
let shutdownCalls: Array<{ port: number | string; timeoutMs: number }> = [];
let pidInfo: PidInfo | null = null;
let pidOwnershipValid = false;

const checkVersionMatchMock = mock(async () => {
  const next = versionChecks.shift();
  if (!next) throw new Error('unexpected checkVersionMatch call');
  return next;
});

const waitForHealthMock = mock(async () => {
  return healthChecks.shift() ?? false;
});

const getRunningWorkerHealthMock = mock(async () => {
  return healthDetails.shift() ?? null;
});

const shutdownWorkerAndWaitMock = mock(async (port: number | string, timeoutMs: number) => {
  shutdownCalls.push({ port, timeoutMs });
  return {
    workerWasRunning: true,
    healthStoppedResponding: true,
    portFreed: true,
    shutdownConfirmed: true,
  };
});

const readPidFileMock = mock(() => pidInfo);
const verifyPidFileOwnershipMock = mock(() => pidOwnershipValid);

const dependencies: WorkerUpgradeSafetyDependencies = {
  checkVersionMatch: checkVersionMatchMock,
  getRunningWorkerHealth: getRunningWorkerHealthMock,
  waitForHealth: waitForHealthMock,
  shutdownWorkerAndWait: shutdownWorkerAndWaitMock,
  readPidFile: readPidFileMock,
  verifyPidFileOwnership: verifyPidFileOwnershipMock,
};

describe('worker upgrade safety', () => {
  beforeEach(() => {
    versionChecks = [];
    healthDetails = [];
    healthChecks = [];
    shutdownCalls = [];
    pidInfo = null;
    pidOwnershipValid = false;
    checkVersionMatchMock.mockClear();
    getRunningWorkerHealthMock.mockClear();
    waitForHealthMock.mockClear();
    shutdownWorkerAndWaitMock.mockClear();
    readPidFileMock.mockClear();
    verifyPidFileOwnershipMock.mockClear();
  });

  it('asks a live mismatched worker to shut down before continuing', async () => {
    versionChecks = [
      { matches: false, pluginVersion: '12.7.5', workerVersion: '12.7.4' },
      { matches: true, pluginVersion: '12.7.5', workerVersion: null },
    ];
    healthDetails = [
      {
        status: 'ok',
        version: '12.7.4',
        pid: 42,
        managed: true,
        hasIpc: true,
        workerPath: ownedWorkerPath,
      },
      null,
    ];
    healthChecks = [false];

    const result = await shutdownIncompatibleWorkerIfRunning(37777, 0, {
      expectedVersion: '12.7.5',
      assumeWorkerHealthy: true,
      healthProbeTimeoutMs: 0,
      dependencies,
    });

    expect(result.action).toBe('shutdown-confirmed');
    expect(result.reason).toBe('version-mismatch');
    expect(result.ownershipVerified).toBe(true);
    expect(checkVersionMatchMock.mock.calls[0]).toEqual([37777, '12.7.5']);
    expect(shutdownCalls).toEqual([{ port: 37777, timeoutMs: 0 }]);
  });

  it('fails closed when the mismatched worker still reports the old version after shutdown', async () => {
    versionChecks = [
      { matches: false, pluginVersion: '12.7.5', workerVersion: '12.7.4' },
      { matches: false, pluginVersion: '12.7.5', workerVersion: '12.7.4' },
    ];
    healthDetails = [
      {
        status: 'ok',
        version: '12.7.4',
        pid: 42,
        managed: true,
        hasIpc: true,
        workerPath: ownedWorkerPath,
      },
      {
        status: 'ok',
        version: '12.7.4',
        pid: 42,
        managed: true,
        hasIpc: true,
        workerPath: ownedWorkerPath,
      },
    ];

    const result = await shutdownIncompatibleWorkerIfRunning(37777, 0, {
      expectedVersion: '12.7.5',
      assumeWorkerHealthy: true,
      healthProbeTimeoutMs: 0,
      dependencies,
    });

    expect(result.action).toBe('shutdown-failed');
    expect(result.shutdownConfirmed).toBe(false);
    expect(shutdownCalls).toEqual([{ port: 37777, timeoutMs: 0 }]);
  });

  it('treats a healthy worker with no version endpoint as unsafe for upgrade', async () => {
    versionChecks = [
      { matches: true, pluginVersion: '12.7.5', workerVersion: null },
      { matches: true, pluginVersion: '12.7.5', workerVersion: null },
    ];
    healthDetails = [
      { status: 'ok', pid: 42 },
      null,
    ];
    healthChecks = [true, false];
    pidInfo = { pid: 42, port: 37777, startedAt: new Date().toISOString() };
    pidOwnershipValid = true;

    const result = await shutdownIncompatibleWorkerIfRunning(37777, 0, {
      expectedVersion: '12.7.5',
      healthProbeTimeoutMs: 0,
      dependencies,
    });

    expect(result.action).toBe('shutdown-confirmed');
    expect(result.reason).toBe('version-unavailable');
    expect(result.ownershipVerified).toBe(true);
    expect(shutdownCalls).toEqual([{ port: 37777, timeoutMs: 0 }]);
  });

  it('refuses to shut down a healthy service when claude-mem ownership is unknown', async () => {
    versionChecks = [
      { matches: true, pluginVersion: '12.7.5', workerVersion: null },
    ];
    healthDetails = [
      { status: 'ok' },
    ];
    healthChecks = [true];

    const result = await shutdownIncompatibleWorkerIfRunning(37777, 0, {
      expectedVersion: '12.7.5',
      healthProbeTimeoutMs: 0,
      dependencies,
    });

    expect(result.action).toBe('shutdown-failed');
    expect(result.reason).toBe('unknown-owner');
    expect(result.shutdownRequested).toBe(false);
    expect(shutdownCalls).toEqual([]);
  });

  it('does not treat generic status/version/pid health as claude-mem ownership proof', async () => {
    versionChecks = [
      { matches: false, pluginVersion: '12.7.5', workerVersion: '12.7.4' },
    ];
    healthDetails = [
      { status: 'ok', version: '12.7.4', pid: 42 },
    ];

    const result = await shutdownIncompatibleWorkerIfRunning(37777, 0, {
      expectedVersion: '12.7.5',
      assumeWorkerHealthy: true,
      healthProbeTimeoutMs: 0,
      dependencies,
    });

    expect(result.action).toBe('shutdown-failed');
    expect(result.reason).toBe('unknown-owner');
    expect(result.shutdownRequested).toBe(false);
    expect(shutdownCalls).toEqual([]);
  });

  it('does not shut down a compatible worker', async () => {
    versionChecks = [
      { matches: true, pluginVersion: '12.7.5', workerVersion: '12.7.5' },
    ];
    healthDetails = [
      { status: 'ok', version: '12.7.5', pid: 42 },
    ];

    const result = await shutdownIncompatibleWorkerIfRunning(37777, 0, {
      expectedVersion: '12.7.5',
      assumeWorkerHealthy: true,
      healthProbeTimeoutMs: 0,
      dependencies,
    });

    expect(result.action).toBe('compatible');
    expect(result.ownershipVerified).toBe(false);
    expect(shutdownCalls).toEqual([]);
  });

  it('requires claude-mem install/cache evidence for self-reported health identity', () => {
    expect(hasClaudeMemWorkerOwnershipProof(37777, {
      status: 'ok',
      version: '12.7.5',
      pid: 42,
      managed: true,
      hasIpc: true,
      workerPath: '/tmp/worker-service.cjs',
    }, dependencies)).toBe(false);

    expect(hasClaudeMemWorkerOwnershipProof(37777, {
      status: 'ok',
      version: '12.7.5',
      pid: 42,
      managed: true,
      hasIpc: true,
      workerPath: '/Users/test/.claude/plugins/cache/thedotmack/claude-mem/12.7.5/dist/worker-service.cjs',
    }, dependencies)).toBe(true);
  });
});
