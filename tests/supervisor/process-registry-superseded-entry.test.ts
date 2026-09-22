// A registry id can be reused while the process holding it is still running:
// chroma always registers under the fixed `chroma-mcp`, so each new worker
// generation registers over the last one. `register()` used to be a bare
// `Map.set`, which dropped the running process's record — and nothing
// signals a pid that is not in the map, because `runShutdownCascade` walks
// `getAll()` and `pruneDeadEntries` only visits entries. The process went
// unreachable by every reaper at once (#3301).
//
// A displaced but live record is now re-keyed instead, so it stays reapable.
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { createProcessRegistry } from '../../src/supervisor/process-registry.js';

// Same fixtures the sibling suite uses: this process is alive by definition,
// and 2147483647 is above every platform's pid ceiling, so it never is.
const LIVE_PID = process.pid;
const DEAD_PID = 2147483647;

const tempDirs: string[] = [];

function makeRegistry() {
  const dir = path.join(tmpdir(), `claude-mem-superseded-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  const registryPath = path.join(dir, 'supervisor.json');
  return { registry: createProcessRegistry(registryPath), registryPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProcessRegistry keeps a superseded live process reapable (#3301)', () => {
  it('re-keys the running process instead of dropping it', () => {
    const { registry } = makeRegistry();

    registry.register('chroma-mcp', { pid: LIVE_PID, type: 'mcp', startedAt: '2026-03-15T00:00:00.000Z' });
    registry.register('chroma-mcp', { pid: DEAD_PID, type: 'mcp', startedAt: '2026-03-15T00:00:05.000Z' });

    const records = registry.getAll();
    expect(records).toHaveLength(2);

    const superseded = records.find(record => record.pid === LIVE_PID);
    expect(superseded).toBeDefined();
    expect(superseded!.id).not.toBe('chroma-mcp');
    expect(superseded!.type).toBe('mcp');
    expect(superseded!.startedAt).toBe('2026-03-15T00:00:00.000Z');

    // The id itself still resolves to the generation that claimed it.
    expect(records.find(record => record.id === 'chroma-mcp')?.pid).toBe(DEAD_PID);
  });

  it('replaces a record whose process has already exited', () => {
    const { registry } = makeRegistry();

    registry.register('chroma-mcp', { pid: DEAD_PID, type: 'mcp', startedAt: '2026-03-15T00:00:00.000Z' });
    registry.register('chroma-mcp', { pid: LIVE_PID, type: 'mcp', startedAt: '2026-03-15T00:00:05.000Z' });

    // Nothing to keep: the old pid is gone, so this must not grow the registry.
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0]?.pid).toBe(LIVE_PID);
  });

  it('re-registering the same pid updates in place', () => {
    const { registry } = makeRegistry();

    registry.register('worker:1', { pid: LIVE_PID, type: 'worker', startedAt: '2026-03-15T00:00:00.000Z' });
    registry.register('worker:1', { pid: LIVE_PID, type: 'worker', startedAt: '2026-03-15T00:00:05.000Z', pgid: 99 });

    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0]?.pgid).toBe(99);
  });

  it('records one survivor however many times it is displaced', () => {
    const { registry } = makeRegistry();

    // The same live process loses the id three times over. Keyed by pid, so
    // the registry records it once rather than growing a row per generation.
    for (const pid of [DEAD_PID, DEAD_PID - 1, DEAD_PID - 2]) {
      registry.register('chroma-mcp', { pid: LIVE_PID, type: 'mcp', startedAt: '2026-03-15T00:00:00.000Z' });
      registry.register('chroma-mcp', { pid, type: 'mcp', startedAt: '2026-03-15T00:00:05.000Z' });
    }

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getAll().filter(record => record.pid === LIVE_PID)).toHaveLength(1);
    expect(registry.getAll().find(record => record.id === 'chroma-mcp')?.pid).toBe(DEAD_PID - 2);
  });

  it('the running process keeps its ChildProcess handle under the new id', () => {
    const { registry } = makeRegistry();
    const handle = { pid: LIVE_PID } as unknown as Parameters<typeof registry.register>[2];

    registry.register('chroma-mcp', { pid: LIVE_PID, type: 'mcp', startedAt: '2026-03-15T00:00:00.000Z' }, handle);
    registry.register('chroma-mcp', { pid: DEAD_PID, type: 'mcp', startedAt: '2026-03-15T00:00:05.000Z' });

    const supersededId = registry.getAll().find(record => record.pid === LIVE_PID)!.id;
    expect(registry.getRuntimeProcess(supersededId)).toBe(handle);
    // The id the new generation claimed must not still answer with the old
    // generation's handle.
    expect(registry.getRuntimeProcess('chroma-mcp')).toBeUndefined();
  });

  it('the retained record is pruned once its process exits', () => {
    const { registry } = makeRegistry();

    registry.register('chroma-mcp', { pid: LIVE_PID, type: 'mcp', startedAt: '2026-03-15T00:00:00.000Z' });
    registry.register('chroma-mcp', { pid: DEAD_PID, type: 'mcp', startedAt: '2026-03-15T00:00:05.000Z' });
    expect(registry.getAll()).toHaveLength(2);

    // Nothing leaks: the survivor is a normal entry, so the normal sweep
    // takes it. Both ids here are dead from the sweep's point of view except
    // the retained one, which is this process.
    expect(registry.pruneDeadEntries()).toBe(1);
    expect(registry.getAll().map(record => record.pid)).toEqual([LIVE_PID]);
  });

  it('persists the retained record, so a restart can still reap it', () => {
    const { registry, registryPath } = makeRegistry();

    registry.register('chroma-mcp', { pid: LIVE_PID, type: 'mcp', startedAt: '2026-03-15T00:00:00.000Z' });
    registry.register('chroma-mcp', { pid: DEAD_PID, type: 'mcp', startedAt: '2026-03-15T00:00:05.000Z' });

    const persisted = JSON.parse(readFileSync(registryPath, 'utf-8')) as { processes: Record<string, { pid: number }> };
    expect(Object.values(persisted.processes).map(entry => entry.pid).sort()).toEqual([LIVE_PID, DEAD_PID].sort());

    // A fresh supervisor reads it back and reaches the survivor.
    const reloaded = createProcessRegistry(registryPath);
    expect(reloaded.getAll().some(record => record.pid === LIVE_PID)).toBe(true);
  });
});
