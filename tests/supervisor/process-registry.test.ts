import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import {
  createProcessRegistry,
  isPidAlive,
  normalizeSpawnSdkArgs,
  normalizeSpawnSdkCwd,
  spawnSdkProcess,
  getProcessRegistry,
  waitForSlot,
  getParkedSlotWaiterCount,
  isSessionParkedForSlot,
  type SlotReservation,
} from '../../src/supervisor/process-registry.js';
import { guardSharedProcessRegistrySingleton } from './process-registry-singleton-guard.js';

const TEST_SESSION_ID = process.pid;
const SDK_CWD_PROBE = 'console.log(process.cwd())';
const EXPECTED_SDK_CWD = path.join(OBSERVER_SESSIONS_DIR, String(TEST_SESSION_ID));
const PARENT_PATH = '..';
const DIRECTORY_COLLISION = 'directory collision';

function assertIsolatedObserverSessionsDir(): void {
  const relativePath = path.relative(tmpdir(), OBSERVER_SESSIONS_DIR);
  if (relativePath === PARENT_PATH || relativePath.startsWith(`${PARENT_PATH}${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to mutate non-test observer directory: ${OBSERVER_SESSIONS_DIR}`);
  }
}

// Registered at true file top level (outside every describe below), NOT
// nested inside describe('waitForSlot / parked waiters (#2756)', ...): bun
// (like Jest/Mocha) runs afterEach hooks inner-scope-first, outer-scope-last
// (LIFO), regardless of source order — so an outer-scope guard is
// guaranteed to run its "after" check only once that describe's own local
// `afterEach` cleanup (nested one level in) has already finished, no matter
// where within the describe that local afterEach is declared. Its
// beforeEach half runs outer-first (before any nested describe's own
// beforeEach or test body), which is exactly what a "before" check needs.
guardSharedProcessRegistrySingleton('process-registry.test.ts');

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

      const registry1 = createProcessRegistry(registryPath);
      registry1.register('worker:1', {
        pid: process.pid,
        type: 'worker',
        startedAt: '2026-03-15T00:00:00.000Z'
      });

      expect(existsSync(registryPath)).toBe(true);
      const diskData = JSON.parse(readFileSync(registryPath, 'utf-8'));
      expect(diskData.processes['worker:1']).toBeDefined();

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

      expect(registry1.getAll()).toHaveLength(1);
      expect(registry2.getAll()).toHaveLength(0);
    });
  });

  describe('normalizeSpawnSdkArgs', () => {
    it('appends explicit extra args after SDK args', () => {
      expect(normalizeSpawnSdkArgs(['--print', 'json'], ['--no-session-persistence'])).toEqual([
        '--print',
        'json',
        '--no-session-persistence',
      ]);
    });

    it('strips empty placeholder flags before appending extra args', () => {
      expect(normalizeSpawnSdkArgs([
        '--append-system-prompt',
        '',
        '--resume',
        'session-123',
      ], ['--no-session-persistence'])).toEqual([
        '--resume',
        'session-123',
        '--no-session-persistence',
      ]);
    });
  });

  describe('normalizeSpawnSdkCwd', () => {
    it('jails SDK subprocess cwd to the observer sessions directory (#3357)', () => {
      expect(normalizeSpawnSdkCwd(TEST_SESSION_ID)).toBe(EXPECTED_SDK_CWD);
    });

    it('applies the observer sessions cwd to direct SDK spawns', async () => {
      assertIsolatedObserverSessionsDir();
      tempDirs.push(EXPECTED_SDK_CWD);
      const projectDir = makeTempDir();
      tempDirs.push(projectDir);
      mkdirSync(projectDir, { recursive: true });

      const result = spawnSdkProcess(TEST_SESSION_ID, {
        command: process.execPath,
        args: ['--eval', SDK_CWD_PROBE],
        cwd: projectDir,
      });

      expect(result).not.toBeNull();
      try {
        const output = await new Response(result!.process.stdout).text();
        expect(output.trim()).toBe(realpathSync(EXPECTED_SDK_CWD));
      } finally {
        try { result!.process.kill('SIGKILL'); } catch { /* already exited */ }
        await new Promise<void>((resolve) => {
          if (result!.process.exitCode !== null) {
            resolve();
            return;
          }
          result!.process.once('exit', () => resolve());
        });
      }
    });

    it('returns null when the observer session directory cannot be created', () => {
      assertIsolatedObserverSessionsDir();
      mkdirSync(OBSERVER_SESSIONS_DIR, { recursive: true });
      tempDirs.push(EXPECTED_SDK_CWD);
      writeFileSync(EXPECTED_SDK_CWD, DIRECTORY_COLLISION);

      expect(spawnSdkProcess(TEST_SESSION_ID, {
        command: process.execPath,
        args: ['--eval', SDK_CWD_PROBE],
      })).toBeNull();
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

/**
 * #2756 — these tests exercise waitForSlot/getParkedSlotWaiterCount/
 * isSessionParkedForSlot against the REAL module singleton (getProcessRegistry()),
 * because waitForSlot is hardcoded to that singleton rather than accepting an
 * injected registry. This is safe re: data isolation: tests/preload.ts pins
 * CLAUDE_MEM_DATA_DIR to a fresh temp dir for the whole `bun test` run before
 * any module loads. It is NOT the only file touching this singleton's
 * in-memory state, though — tests/worker/http/routes/
 * session-routes-provider-switch.test.ts and tests/worker/http/routes/
 * data-routes-processing-status.test.ts both register real 'sdk'-typed
 * entries and drive real waitForSlot/slotWaiters against this exact same
 * process-global module, so a leak here can affect those files (and vice
 * versa) within the same `bun test` process — see
 * process-registry-singleton-guard.ts for the mechanism and the isolation
 * guard installed above (at file top level, on purpose — see its comment).
 * Every fake 'sdk' entry registered below is still unregistered in
 * afterEach on top of that guard.
 */
describe('waitForSlot / parked waiters (#2756)', () => {
  const registry = getProcessRegistry();
  const registeredIds: string[] = [];
  // waitForSlot resolves to a SlotReservation (#3287, upstream since this
  // fork's base) rather than void — every reservation granted below is
  // captured here and released in afterEach so the reservedSlots counter it
  // holds doesn't leak into getActiveSdkCount() for a later test in this
  // file, or for another file sharing this singleton in the same `bun test`
  // process (the guard above only checks parked waiters and registry 'sdk'
  // entries, not reservedSlots).
  const grantedReservations: SlotReservation[] = [];

  function registerFakeSdk(sessionId: string | number): string {
    const id = `sdk:test-${sessionId}:${Math.random().toString(36).slice(2)}`;
    // pid=process.pid is always alive per isPidAlive, so pruneDeadEntries()
    // never removes these out from under a test.
    registry.register(id, {
      pid: process.pid,
      type: 'sdk',
      sessionId,
      startedAt: new Date().toISOString(),
    });
    registeredIds.push(id);
    return id;
  }

  afterEach(() => {
    while (grantedReservations.length > 0) {
      grantedReservations.pop()!.release();
    }
    while (registeredIds.length > 0) {
      const id = registeredIds.pop();
      if (id) registry.unregister(id);
    }
  });

  it('parked waiter is released by a settings raise, without waiting the real recheck interval', async () => {
    registerFakeSdk('occupant-1');
    registerFakeSdk('occupant-2');

    let currentMax = 2;
    const parkedPromise = waitForSlot(() => currentMax, undefined, 'sess-settings-raise');

    // The Promise executor runs synchronously before any await, so the push
    // onto slotWaiters is already visible here.
    expect(isSessionParkedForSlot('sess-settings-raise')).toBe(true);
    expect(getParkedSlotWaiterCount()).toBe(1);

    // Raise the limit — this alone must NOT release the waiter (nothing has
    // poked the queue yet); the (a) fix is that the NEXT recheck observes it.
    currentMax = 3;
    expect(isSessionParkedForSlot('sess-settings-raise')).toBe(true);

    // Poke a recheck deterministically, without waiting the real 5s
    // SLOT_RECHECK_INTERVAL_MS: register+unregister a throwaway 3rd 'sdk'
    // entry. unregister() calls notifySlotAvailable() synchronously, and by
    // then the throwaway is already removed, so the recheck sees count=2 < 3.
    const throwawayId = registerFakeSdk('throwaway');
    registry.unregister(throwawayId);

    grantedReservations.push(await parkedPromise);

    expect(isSessionParkedForSlot('sess-settings-raise')).toBe(false);
    expect(getParkedSlotWaiterCount()).toBe(0);
  });

  it('releases parked waiters in FIFO order as slots free up one at a time', async () => {
    const occupantA = registerFakeSdk('occ-a');
    const occupantB = registerFakeSdk('occ-b');
    const currentMax = 2;

    const resolvedOrder: string[] = [];
    const waiterFirst = waitForSlot(() => currentMax, undefined, 'sess-first').then((reservation) => {
      grantedReservations.push(reservation);
      resolvedOrder.push('first');
    });
    const waiterSecond = waitForSlot(() => currentMax, undefined, 'sess-second').then((reservation) => {
      grantedReservations.push(reservation);
      resolvedOrder.push('second');
    });

    expect(isSessionParkedForSlot('sess-first')).toBe(true);
    expect(isSessionParkedForSlot('sess-second')).toBe(true);
    expect(getParkedSlotWaiterCount()).toBe(2);

    // Free exactly one slot: only the FRONT waiter (first) should resolve —
    // the second waiter's own recheck hasn't been poked yet.
    registry.unregister(occupantA);
    await waiterFirst;

    expect(resolvedOrder).toEqual(['first']);
    expect(isSessionParkedForSlot('sess-first')).toBe(false);
    expect(isSessionParkedForSlot('sess-second')).toBe(true);
    expect(getParkedSlotWaiterCount()).toBe(1);

    // Free the second slot: the remaining waiter (second) resolves.
    registry.unregister(occupantB);
    await waiterSecond;

    expect(resolvedOrder).toEqual(['first', 'second']);
    expect(getParkedSlotWaiterCount()).toBe(0);
  });

  it('rejects immediately when the hard cap is already exceeded, without parking', async () => {
    for (let i = 0; i < 10; i++) {
      registerFakeSdk(`hardcap-${i}`);
    }

    await expect(waitForSlot(1, undefined, 'sess-hardcap')).rejects.toThrow(/Hard cap exceeded/);
    expect(isSessionParkedForSlot('sess-hardcap')).toBe(false);
    expect(getParkedSlotWaiterCount()).toBe(0);
  });

  it('resolves immediately (no parking) when the active count is already under the limit', async () => {
    registerFakeSdk('solo-occupant');

    grantedReservations.push(await waitForSlot(() => 5, undefined, 'sess-not-parked'));

    expect(isSessionParkedForSlot('sess-not-parked')).toBe(false);
    expect(getParkedSlotWaiterCount()).toBe(0);
  });
});
