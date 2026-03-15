import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createProcessRegistry, isPidAlive } from '../../src/supervisor/process-registry.js';

function makeTempDir(): string {
  return path.join(tmpdir(), `claude-mem-supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

describe('supervisor ProcessRegistry', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists entries and prunes dead processes on initialize', () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });
    const registryPath = path.join(tempDir, 'supervisor.json');

    writeFileSync(registryPath, JSON.stringify({
      processes: {
        alive: {
          pid: process.pid,
          type: 'worker',
          startedAt: '2026-03-15T00:00:00.000Z'
        },
        dead: {
          pid: 2147483647,
          type: 'mcp',
          startedAt: '2026-03-15T00:00:01.000Z'
        }
      }
    }));

    const registry = createProcessRegistry(registryPath);
    registry.initialize();

    const records = registry.getAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('alive');
    expect(existsSync(registryPath)).toBe(true);
  });

  it('filters records by session id', () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

    registry.register('sdk:1', {
      pid: process.pid,
      type: 'sdk',
      sessionId: 42,
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('sdk:2', {
      pid: process.pid,
      type: 'sdk',
      sessionId: 'other',
      startedAt: '2026-03-15T00:00:01.000Z'
    });

    const records = registry.getBySession(42);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('sdk:1');
  });

  it('treats current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reapSession unregisters dead processes for the given session', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

    // Register two processes for session 99 (both dead PIDs)
    registry.register('sdk:99:50001', {
      pid: 2147483640,
      type: 'sdk',
      sessionId: 99,
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('mcp:99:50002', {
      pid: 2147483641,
      type: 'mcp',
      sessionId: 99,
      startedAt: '2026-03-15T00:00:01.000Z'
    });

    // Register a process for a different session (should survive)
    registry.register('sdk:100:50003', {
      pid: process.pid,
      type: 'sdk',
      sessionId: 100,
      startedAt: '2026-03-15T00:00:02.000Z'
    });

    const reaped = await registry.reapSession(99);
    expect(reaped).toBe(2);

    // Session 99 processes should be gone
    expect(registry.getBySession(99)).toHaveLength(0);

    // Session 100 process should still exist
    expect(registry.getBySession(100)).toHaveLength(1);
  });

  it('reapSession returns 0 when no processes match the session', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

    registry.register('sdk:1', {
      pid: process.pid,
      type: 'sdk',
      sessionId: 42,
      startedAt: '2026-03-15T00:00:00.000Z'
    });

    const reaped = await registry.reapSession(999);
    expect(reaped).toBe(0);

    // Original process should still exist
    expect(registry.getAll()).toHaveLength(1);
  });
});
