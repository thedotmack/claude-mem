import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createProcessRegistry } from '../../src/supervisor/process-registry.js';
import { removeOwnedPidFile, runShutdownCascade } from '../../src/supervisor/shutdown.js';

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

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath: path.join(tempDir, 'worker.pid')
    });

    const persisted = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(Object.keys(persisted.processes)).toHaveLength(0);
  });

  // Phase 5 (worker-restart plan): the dying worker's shutdown cascade runs
  // AFTER the restart successor has written its own PID file. Blind deletion
  // here clobbered the successor's file and made `worker status` report a
  // healthy worker as not running.
  it('old-worker cleanup spares the successor\'s PID file (owner guard)', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const pidFilePath = path.join(tempDir, 'worker.pid');

    // A successor (NOT this process) already owns the PID file.
    const successorContent = JSON.stringify({
      pid: 99999847,
      port: 37777,
      startedAt: new Date().toISOString()
    });
    writeFileSync(pidFilePath, successorContent);

    const registry = createProcessRegistry(registryPath);
    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-03-15T00:00:00.000Z'
    });

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath
    });

    // The successor's file must survive the old worker's dying breath, byte
    // for byte.
    expect(existsSync(pidFilePath)).toBe(true);
    expect(readFileSync(pidFilePath, 'utf-8')).toBe(successorContent);
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

    expect(registry.getAll()).toHaveLength(0);
  });
});

describe('removeOwnedPidFile (owner guard, Phase 5)', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makePidFilePath(): string {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });
    return path.join(tempDir, 'worker.pid');
  }

  it('deletes the file when the recorded pid is the current process', () => {
    const pidFilePath = makePidFilePath();
    writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() }));

    removeOwnedPidFile(pidFilePath, process.pid);

    expect(existsSync(pidFilePath)).toBe(false);
  });

  it('leaves the file when the recorded pid belongs to another process', () => {
    const pidFilePath = makePidFilePath();
    writeFileSync(pidFilePath, JSON.stringify({ pid: 99999847, port: 37777, startedAt: new Date().toISOString() }));

    removeOwnedPidFile(pidFilePath, process.pid);

    expect(existsSync(pidFilePath)).toBe(true);
  });

  it('leaves a corrupt file in place (ownership cannot be proven)', () => {
    const pidFilePath = makePidFilePath();
    writeFileSync(pidFilePath, 'not valid json {{{');

    removeOwnedPidFile(pidFilePath, process.pid);

    expect(existsSync(pidFilePath)).toBe(true);
  });

  it('leaves a pid-less JSON file in place (no recorded owner)', () => {
    const pidFilePath = makePidFilePath();
    writeFileSync(pidFilePath, JSON.stringify({ port: 37777 }));

    removeOwnedPidFile(pidFilePath, process.pid);

    expect(existsSync(pidFilePath)).toBe(true);
  });

  it('does not throw when the file is missing', () => {
    const pidFilePath = makePidFilePath();

    expect(() => removeOwnedPidFile(pidFilePath, process.pid)).not.toThrow();
    expect(existsSync(pidFilePath)).toBe(false);
  });
});

