
import { describe, it, expect } from 'bun:test';
import {
  ensureWorkerStarted,
  startWorkerWithDependencies,
  type WorkerSpawnerDependencies,
} from '../../src/services/worker-spawner.js';

describe('ensureWorkerStarted validation guards', () => {

  it('returns "dead" when workerScriptPath is empty string', async () => {
    const result = await ensureWorkerStarted(39001, '');
    expect(result).toBe('dead');
  });

  it('returns "dead" when workerScriptPath does not exist on disk', async () => {
    const bogusPath = '/tmp/__claude-mem-test-nonexistent-worker-script-' + Date.now() + '.cjs';
    const result = await ensureWorkerStarted(39002, bogusPath);
    expect(result).toBe('dead');
  });
});

describe('ensureWorkerStarted automatic recovery', () => {
  function makeDependencies(overrides: Partial<WorkerSpawnerDependencies> = {}): WorkerSpawnerDependencies {
    let healthCall = 0;
    return {
      workerScriptExists: () => true,
      cleanStalePidFile: () => 'missing',
      waitForHealth: async () => {
        healthCall += 1;
        return healthCall >= 4;
      },
      waitForReadiness: async () => true,
      isPortInUse: async () => true,
      recoverUnhealthyWorker: async () => true,
      shouldSkipSpawnOnWindows: () => false,
      markWorkerSpawnAttempted: () => {},
      clearWorkerSpawnAttempted: () => {},
      acquireSpawnLock: () => true,
      releaseSpawnLock: () => {},
      spawnDaemon: () => 4242,
      touchPidFile: () => {},
      getPlatformTimeout: timeout => timeout,
      ...overrides,
    };
  }

  it('recovers an unhealthy occupied port before spawning a replacement', async () => {
    const calls: string[] = [];
    const dependencies = makeDependencies({
      recoverUnhealthyWorker: async () => {
        calls.push('recover');
        return true;
      },
      spawnDaemon: () => {
        calls.push('spawn');
        return 4242;
      },
    });

    const result = await startWorkerWithDependencies(39180, 'C:\\plugin\\worker-service.cjs', dependencies);

    expect(result).toBe('ready');
    expect(calls).toEqual(['recover', 'spawn']);
  });

  it('does not spawn when recovery cannot release the occupied port', async () => {
    let spawnCount = 0;
    const dependencies = makeDependencies({
      recoverUnhealthyWorker: async () => false,
      spawnDaemon: () => {
        spawnCount += 1;
        return 4242;
      },
    });

    const result = await startWorkerWithDependencies(39180, 'C:\\plugin\\worker-service.cjs', dependencies);

    expect(result).toBe('dead');
    expect(spawnCount).toBe(0);
  });
});
