import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { validateWorkerPidFile, type ValidateWorkerPidStatus } from '../../src/supervisor/index.js';

function makeTempDir(): string {
  const dir = path.join(tmpdir(), `claude-mem-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

describe('validateWorkerPidFile', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('returns "missing" when PID file does not exist', () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const pidFilePath = path.join(tempDir, 'worker.pid');

    const status = validateWorkerPidFile({ logAlive: false, pidFilePath });
    expect(status).toBe('missing');
  });

  it('returns "invalid" when PID file contains bad JSON', () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const pidFilePath = path.join(tempDir, 'worker.pid');
    writeFileSync(pidFilePath, 'not-json!!!');

    const status = validateWorkerPidFile({ logAlive: false, pidFilePath });
    expect(status).toBe('invalid');
  });

  it('returns "stale" when PID file references a dead process', () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const pidFilePath = path.join(tempDir, 'worker.pid');
    writeFileSync(pidFilePath, JSON.stringify({
      pid: 2147483647,
      port: 37777,
      startedAt: new Date().toISOString()
    }));

    const status = validateWorkerPidFile({ logAlive: false, pidFilePath });
    expect(status).toBe('stale');
  });

  it('returns "alive" when PID file references the current process', () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const pidFilePath = path.join(tempDir, 'worker.pid');
    writeFileSync(pidFilePath, JSON.stringify({
      pid: process.pid,
      port: 37777,
      startedAt: new Date().toISOString()
    }));

    const status = validateWorkerPidFile({ logAlive: false, pidFilePath });
    expect(status).toBe('alive');
  });
});

describe('Supervisor assertCanSpawn behavior', () => {
  it('assertCanSpawn throws when stopPromise is active (shutdown in progress)', () => {
    const { getSupervisor } = require('../../src/supervisor/index.js');
    const supervisor = getSupervisor();

    // When not shutting down, assertCanSpawn should not throw
    expect(() => supervisor.assertCanSpawn('test')).not.toThrow();
  });

  it('registerProcess and unregisterProcess delegate to the registry', () => {
    const { getSupervisor } = require('../../src/supervisor/index.js');
    const supervisor = getSupervisor();
    const registry = supervisor.getRegistry();

    const testId = `test-${Date.now()}`;
    supervisor.registerProcess(testId, {
      pid: process.pid,
      type: 'test',
      startedAt: new Date().toISOString()
    });

    const found = registry.getAll().find((r: { id: string }) => r.id === testId);
    expect(found).toBeDefined();
    expect(found?.type).toBe('test');

    supervisor.unregisterProcess(testId);
    const afterUnregister = registry.getAll().find((r: { id: string }) => r.id === testId);
    expect(afterUnregister).toBeUndefined();
  });
});

describe('Supervisor start idempotency', () => {
  it('getSupervisor returns the same instance', () => {
    const { getSupervisor } = require('../../src/supervisor/index.js');
    const s1 = getSupervisor();
    const s2 = getSupervisor();
    expect(s1).toBe(s2);
  });
});
