import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  describe('isPidAlive', () => {
    it('treats current process as alive', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('treats an impossibly high PID as dead', () => {
      expect(isPidAlive(2147483647)).toBe(false);
    });

    it('treats negative PID as dead', () => {
      expect(isPidAlive(-1)).toBe(false);
    });

    it('treats non-integer PID as dead', () => {
      expect(isPidAlive(3.14)).toBe(false);
    });
  });

  describe('persistence', () => {
    it('persists entries to disk and reloads them on initialize', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      mkdirSync(tempDir, { recursive: true });
      const registryPath = path.join(tempDir, 'supervisor.json');

      // Create a registry, register an entry, and let it persist
      const registry1 = createProcessRegistry(registryPath);
      registry1.register('worker:1', {
        pid: process.pid,
        type: 'worker',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      // Verify file exists on disk
      expect(existsSync(registryPath)).toBe(true);
      const diskData = JSON.parse(readFileSync(registryPath, 'utf-8'));
      expect(diskData.processes['worker:1']).toBeDefined();

      // Create a second registry from the same path — it should load the persisted entry
      const registry2 = createProcessRegistry(registryPath);
      registry2.initialize();
      const records = registry2.getAll();
      expect(records).toHaveLength(1);
      expect(records[0]?.id).toBe('worker:1');
      expect(records[0]?.pid).toBe(process.pid);
    });

    it('prunes dead processes on initialize', () => {
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

    it('handles corrupted registry file gracefully', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      mkdirSync(tempDir, { recursive: true });
      const registryPath = path.join(tempDir, 'supervisor.json');

      writeFileSync(registryPath, '{ not valid json!!!');

      const registry = createProcessRegistry(registryPath);
      registry.initialize();

      // Should recover with an empty registry
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  describe('register and unregister', () => {
    it('register adds an entry retrievable by getAll', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      expect(registry.getAll()).toHaveLength(0);

      registry.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      const records = registry.getAll();
      expect(records).toHaveLength(1);
      expect(records[0]?.id).toBe('sdk:1');
      expect(records[0]?.type).toBe('sdk');
    });

    it('unregister removes an entry', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      registry.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:00.000Z'
      });
      expect(registry.getAll()).toHaveLength(1);

      registry.unregister('sdk:1');
      expect(registry.getAll()).toHaveLength(0);
    });

    it('unregister is a no-op for unknown IDs', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      registry.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      registry.unregister('nonexistent');
      expect(registry.getAll()).toHaveLength(1);
    });
  });

  describe('getAll', () => {
    it('returns records sorted by startedAt ascending', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      registry.register('newest', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:02.000Z'
      });
      registry.register('oldest', {
        pid: process.pid,
        type: 'worker',
        startedAt: '2026-03-15T00:00:00.000Z'
      });
      registry.register('middle', {
        pid: process.pid,
        type: 'mcp',
        startedAt: '2026-03-15T00:00:01.000Z'
      });

      const records = registry.getAll();
      expect(records).toHaveLength(3);
      expect(records[0]?.id).toBe('oldest');
      expect(records[1]?.id).toBe('middle');
      expect(records[2]?.id).toBe('newest');
    });

    it('returns empty array when no entries exist', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('getBySession', () => {
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

    it('returns empty array when no processes match the session', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      registry.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        sessionId: 42,
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      expect(registry.getBySession(999)).toHaveLength(0);
    });

    it('matches string and numeric session IDs by string comparison', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      registry.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        sessionId: '42',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      // Querying with number should find string "42"
      expect(registry.getBySession(42)).toHaveLength(1);
    });
  });

  describe('pruneDeadEntries', () => {
    it('removes entries with dead PIDs and preserves live ones', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'supervisor.json');
      const registry = createProcessRegistry(registryPath);

      registry.register('alive', {
        pid: process.pid,
        type: 'worker',
        startedAt: '2026-03-15T00:00:00.000Z'
      });
      registry.register('dead', {
        pid: 2147483647,
        type: 'mcp',
        startedAt: '2026-03-15T00:00:01.000Z'
      });

      const removed = registry.pruneDeadEntries();
      expect(removed).toBe(1);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getAll()[0]?.id).toBe('alive');
    });

    it('returns 0 when all entries are alive', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

      registry.register('alive', {
        pid: process.pid,
        type: 'worker',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      const removed = registry.pruneDeadEntries();
      expect(removed).toBe(0);
      expect(registry.getAll()).toHaveLength(1);
    });

    it('persists changes to disk after pruning', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'supervisor.json');
      const registry = createProcessRegistry(registryPath);

      registry.register('dead', {
        pid: 2147483647,
        type: 'mcp',
        startedAt: '2026-03-15T00:00:01.000Z'
      });

      registry.pruneDeadEntries();

      const diskData = JSON.parse(readFileSync(registryPath, 'utf-8'));
      expect(Object.keys(diskData.processes)).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'supervisor.json');
      const registry = createProcessRegistry(registryPath);

      registry.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:00.000Z'
      });
      registry.register('sdk:2', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:01.000Z'
      });

      expect(registry.getAll()).toHaveLength(2);

      registry.clear();
      expect(registry.getAll()).toHaveLength(0);

      // Verify persisted to disk
      const diskData = JSON.parse(readFileSync(registryPath, 'utf-8'));
      expect(Object.keys(diskData.processes)).toHaveLength(0);
    });
  });

  describe('createProcessRegistry', () => {
    it('creates an isolated instance with a custom path', () => {
      const tempDir1 = makeTempDir();
      const tempDir2 = makeTempDir();
      tempDirs.push(tempDir1, tempDir2);

      const registry1 = createProcessRegistry(path.join(tempDir1, 'supervisor.json'));
      const registry2 = createProcessRegistry(path.join(tempDir2, 'supervisor.json'));

      registry1.register('sdk:1', {
        pid: process.pid,
        type: 'sdk',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      // registry2 should be independent
      expect(registry1.getAll()).toHaveLength(1);
      expect(registry2.getAll()).toHaveLength(0);
    });
  });

  describe('reapSession', () => {
    it('unregisters dead processes for the given session', async () => {
      const tempDir = makeTempDir();
      tempDirs.push(tempDir);
      const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));

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

      expect(registry.getBySession(99)).toHaveLength(0);
      expect(registry.getBySession(100)).toHaveLength(1);
    });

    it('returns 0 when no processes match the session', async () => {
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

      expect(registry.getAll()).toHaveLength(1);
    });
  });
});
