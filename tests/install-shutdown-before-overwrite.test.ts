import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  shutdownWorkerBeforeInstallOverwrite,
  type InstallShutdownDependencies,
} from '../src/npx-cli/commands/install-shutdown.js';
import { WorkerUpgradeSafetyError } from '../src/services/worker-upgrade-safety.js';

type SafetyResult = {
  action: 'compatible' | 'not-running' | 'shutdown-confirmed' | 'shutdown-failed';
  shutdownRequested: boolean;
  shutdownConfirmed: boolean;
  before: {
    matches: boolean;
    pluginVersion: string;
    workerVersion: string | null;
  };
  workerObserved: boolean;
  ownershipVerified: boolean;
};

type ShutdownResult = {
  workerWasRunning: boolean;
  healthStoppedResponding: boolean;
  portFreed: boolean;
  shutdownConfirmed: boolean;
};

let safetyResults: SafetyResult[] = [];
let shutdownResults: ShutdownResult[] = [];
let safetyCalls: Array<{
  port: number | string;
  timeoutMs: number;
  options: { expectedVersion: string };
}> = [];
let shutdownCalls: Array<{ port: number | string; timeoutMs: number; options?: { workerWasObserved?: boolean } }> = [];

const shutdownIncompatibleWorkerIfRunningMock = mock(
  async (port: number | string, timeoutMs: number, options: { expectedVersion: string }) => {
    safetyCalls.push({ port, timeoutMs, options });
    const next = safetyResults.shift();
    if (!next) throw new Error('unexpected shutdownIncompatibleWorkerIfRunning call');
    return next;
  },
);

const formatWorkerUpgradeSafetyErrorMock = mock(() => 'formatted safety failure');

const shutdownWorkerAndWaitMock = mock(async (
  port: number | string,
  timeoutMs: number,
  options?: { workerWasObserved?: boolean },
) => {
  shutdownCalls.push({ port, timeoutMs, options });
  const next = shutdownResults.shift();
  if (!next) throw new Error('unexpected shutdownWorkerAndWait call');
  return next;
});

const dependencies: InstallShutdownDependencies = {
  shutdownIncompatibleWorkerIfRunning: shutdownIncompatibleWorkerIfRunningMock,
  formatWorkerUpgradeSafetyError: formatWorkerUpgradeSafetyErrorMock,
  shutdownWorkerAndWait: shutdownWorkerAndWaitMock,
};

function safety(action: SafetyResult['action'], overrides: Partial<SafetyResult> = {}): SafetyResult {
  return {
    action,
    shutdownRequested: false,
    shutdownConfirmed: action !== 'shutdown-failed',
    before: {
      matches: true,
      pluginVersion: '12.7.5',
      workerVersion: '12.7.5',
    },
    workerObserved: action === 'compatible' || action === 'shutdown-confirmed',
    ownershipVerified: action !== 'shutdown-failed',
    ...overrides,
  };
}

describe('shutdownWorkerBeforeInstallOverwrite', () => {
  beforeEach(() => {
    safetyResults = [];
    shutdownResults = [];
    safetyCalls = [];
    shutdownCalls = [];
    shutdownIncompatibleWorkerIfRunningMock.mockClear();
    formatWorkerUpgradeSafetyErrorMock.mockClear();
    shutdownWorkerAndWaitMock.mockClear();
  });

  it('passes the expected version into worker upgrade safety', async () => {
    safetyResults = [safety('compatible')];
    shutdownResults = [{
      workerWasRunning: true,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    }];

    await shutdownWorkerBeforeInstallOverwrite(37777, '12.7.5', 1234, dependencies);

    expect(safetyCalls).toEqual([{
      port: 37777,
      timeoutMs: 1234,
      options: { expectedVersion: '12.7.5' },
    }]);
  });

  it('throws when worker upgrade safety fails', async () => {
    safetyResults = [safety('shutdown-failed', {
      shutdownConfirmed: false,
      before: {
        matches: false,
        pluginVersion: '12.7.5',
        workerVersion: '12.7.4',
      },
    })];

    await expect(
      shutdownWorkerBeforeInstallOverwrite(37777, '12.7.5', 1234, dependencies),
    ).rejects.toThrow('formatted safety failure');
    expect(shutdownCalls).toEqual([]);
  });

  it('blocks overwrite when a compatible running worker does not confirm shutdown', async () => {
    safetyResults = [safety('compatible')];
    shutdownResults = [{
      workerWasRunning: true,
      healthStoppedResponding: true,
      portFreed: false,
      shutdownConfirmed: false,
    }];

    let error: unknown;
    try {
      await shutdownWorkerBeforeInstallOverwrite(37777, '12.7.5', 1234, dependencies);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WorkerUpgradeSafetyError);
    expect(String((error as Error).message)).toContain('did not confirm shutdown');
    expect(shutdownCalls).toEqual([{ port: 37777, timeoutMs: 1234, options: { workerWasObserved: true } }]);
  });

  it('skips normal shutdown when safety reports no worker running', async () => {
    safetyResults = [safety('not-running')];

    const result = await shutdownWorkerBeforeInstallOverwrite(37777, '12.7.5', 1234, dependencies);

    expect(result).toEqual({
      workerWasRunning: false,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    });
    expect(shutdownCalls).toEqual([]);
  });

  it('fails closed for compatible services without ownership proof before admin shutdown', async () => {
    safetyResults = [safety('compatible', {
      workerObserved: true,
      ownershipVerified: false,
    })];

    await expect(
      shutdownWorkerBeforeInstallOverwrite(37777, '12.7.5', 1234, dependencies),
    ).rejects.toThrow('ownership could not be verified');

    expect(shutdownCalls).toEqual([]);
  });
});
