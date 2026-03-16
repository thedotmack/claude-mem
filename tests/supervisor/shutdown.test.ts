import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createProcessRegistry } from '../../src/supervisor/process-registry.js';
import { runShutdownCascade } from '../../src/supervisor/shutdown.js';

function makeTempDir(): string {
  return path.join(tmpdir(), `claude-mem-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

describe('supervisor shutdown cascade', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('removes child records and pid file', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const pidFilePath = path.join(tempDir, 'worker.pid');

    writeFileSync(pidFilePath, JSON.stringify({
      pid: process.pid,
      port: 37777,
      startedAt: new Date().toISOString()
    }));

    const registry = createProcessRegistry(registryPath);
    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('dead-child', {
      pid: 2147483647,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:01.000Z'
    });

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath
    });

    const persisted = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(Object.keys(persisted.processes)).toHaveLength(0);
    expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow();
  });

  it('terminates tracked children in reverse spawn order', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));
    registry.register('oldest', {
      pid: 41001,
      type: 'sdk',
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('middle', {
      pid: 41002,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:01.000Z'
    });
    registry.register('newest', {
      pid: 41003,
      type: 'chroma',
      startedAt: '2026-03-15T00:00:02.000Z'
    });

    const originalKill = process.kill;
    const alive = new Set([41001, 41002, 41003]);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      const normalizedSignal = signal ?? 'SIGTERM';
      if (normalizedSignal === 0) {
        if (!alive.has(pid)) {
          const error = new Error(`kill ESRCH ${pid}`) as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }

      calls.push({ pid, signal: normalizedSignal });
      alive.delete(pid);
      return true;
    }) as typeof process.kill;

    try {
      await runShutdownCascade({
        registry,
        currentPid: process.pid,
          pidFilePath: path.join(tempDir, 'worker.pid')
      });
    } finally {
      process.kill = originalKill;
    }

    expect(calls).toEqual([
      { pid: 41003, signal: 'SIGTERM' },
      { pid: 41002, signal: 'SIGTERM' },
      { pid: 41001, signal: 'SIGTERM' }
    ]);
  });

  it('handles already-dead processes gracefully without throwing', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const registry = createProcessRegistry(registryPath);

    // Register processes with PIDs that are definitely dead
    registry.register('dead:1', {
      pid: 2147483640,
      type: 'sdk',
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('dead:2', {
      pid: 2147483641,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:01.000Z'
    });

    // Should not throw
    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath: path.join(tempDir, 'worker.pid')
    });

    // All entries should be unregistered
    const persisted = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(Object.keys(persisted.processes)).toHaveLength(0);
  });

  it('unregisters all children from registry after cascade', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const registry = createProcessRegistry(registryPath);

    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('child:1', {
      pid: 2147483640,
      type: 'sdk',
      startedAt: '2026-03-15T00:00:01.000Z'
    });
    registry.register('child:2', {
      pid: 2147483641,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:02.000Z'
    });

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath: path.join(tempDir, 'worker.pid')
    });

    // All records (including the current process one) should be removed
    expect(registry.getAll()).toHaveLength(0);
  });
});

