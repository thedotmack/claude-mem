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

  it('removes child records, socket files, and pid file', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const pidFilePath = path.join(tempDir, 'worker.pid');
    const socketPath = path.join(tempDir, 'worker.sock');

    writeFileSync(pidFilePath, JSON.stringify({
      pid: process.pid,
      port: 37777,
      startedAt: new Date().toISOString()
    }));
    writeFileSync(socketPath, '');

    const registry = createProcessRegistry(registryPath);
    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-03-15T00:00:00.000Z',
      socketPath
    });
    registry.register('dead-child', {
      pid: 2147483647,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:01.000Z'
    });

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      dataDir: tempDir,
      pidFilePath
    });

    const persisted = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(Object.keys(persisted.processes)).toHaveLength(0);
    expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow();
    expect(() => readFileSync(socketPath, 'utf-8')).toThrow();
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
        dataDir: tempDir,
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
});
