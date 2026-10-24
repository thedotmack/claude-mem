import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  findOrphanedToolUseSessions,
  getOrphanedToolUseRows,
  type ToolUseRow,
} from '../../src/services/sqlite/tool-uses.js';
import {
  runOrphanRecoveryScan,
  OrphanReplayMarkerStore,
  resetOrphanRecoveryForTesting,
  ORPHAN_RECOVERY_MARKER_FILENAME,
} from '../../src/services/worker/QuotaOrphanRecovery.js';
import { recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { logger } from '../../src/utils/logger.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

/**
 * Recovery for observation work orphaned by a quota-cooldown restart (#4580).
 *
 * While the breaker withholds the generator, PostToolUse events still land in
 * the RAM-only SessionMessageBuffer; a worker restart disposes that buffer and
 * the tool_uses rows stay observation_id NULL forever. These tests pin the
 * bounded startup/cooldown-end scan that re-feeds those rows through the SAME
 * ingest shapes (queueObservation with the original tool_use_id, so the late
 * link in ResponseProcessor closes the loop onto the SAME durable rows), the
 * persisted one-shot marker that keeps the old pending-queue retry storm from
 * coming back, and the pacing gate shared with resumePendingSessions.
 */

const HOUR = 60 * 60_000;

/** A fake ActiveSession body — only identity matters to the scan. */
function liveSession(sessionDbId: number): { sessionDbId: number } {
  return { sessionDbId };
}

interface QueuedCall {
  sessionDbId: number;
  toolUseId?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

/** Fake SessionManager surface the scan touches, recording queueObservation. */
function fakeSessionManager(live: number[] = []) {
  const queued: QueuedCall[] = [];
  const liveSet = new Set(live);
  return {
    queued,
    kicks: [] as Array<{ sessionDbId: number; source: string }>,
    getSession: (sessionDbId: number) => (liveSet.has(sessionDbId) ? liveSession(sessionDbId) : null),
    queueObservation: (sessionDbId: number, data: QueuedCall) => {
      queued.push({ sessionDbId, ...data });
    },
  };
}

function scanDeps(db: Database, manager = fakeSessionManager(), opts: { failKicksFor?: number[] } = {}) {
  return {
    db,
    sessionManager: manager,
    ensureGeneratorRunning: async (sessionDbId: number, source: string) => {
      if (opts.failKicksFor?.includes(sessionDbId)) throw new Error('provider refused');
      manager.kicks.push({ sessionDbId, source });
    },
  };
}

/** Insert an orphan-shaped tool_use row (observation_id stays NULL forever). */
function seedOrphan(
  store: SessionStore,
  overrides: {
    toolUseId?: string;
    contentSessionId?: string;
    sessionDbId?: number | null;
    createdAtEpoch?: number;
    toolName?: string;
    memorySessionId?: string | null;
  } = {},
): void {
  store.upsertToolUse({
    toolUseId: overrides.toolUseId ?? `toolu_${Math.random().toString(36).slice(2, 8)}`,
    contentSessionId: overrides.contentSessionId ?? 'content-orphan',
    sessionDbId: overrides.sessionDbId !== undefined ? overrides.sessionDbId : 101,
    project: 'proj',
    platformSource: 'claude',
    toolName: overrides.toolName ?? 'Bash',
    toolInput: '{"command":"ls"}',
    toolResponse: '{"ok":true}',
    cwd: '/workspace/proj',
    promptNumber: 2,
    createdAtEpoch: overrides.createdAtEpoch ?? Date.now() - 2 * HOUR,
    ...(overrides.memorySessionId !== undefined ? { memorySessionId: overrides.memorySessionId } : {}),
  });
}

describe('findOrphanedToolUseSessions (query)', () => {
  let store: SessionStore | undefined;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('finds sessions whose every tool use is unlinked, older than the grace window', () => {
    seedOrphan(store!, { contentSessionId: 'cs-a', sessionDbId: 201 });
    const orphans = findOrphanedToolUseSessions(store!.db, {
      cutoffEpoch: Date.now() - HOUR,
      limit: 10,
    });
    expect(orphans.length).toBe(1);
    expect(orphans[0].content_session_id).toBe('cs-a');
    expect(orphans[0].session_db_id).toBe(201);
    expect(orphans[0].orphan_count).toBe(1);
  });

  it('skips sessions still inside the grace window (live work, not orphans)', () => {
    seedOrphan(store!, { contentSessionId: 'cs-fresh', createdAtEpoch: Date.now() - 5 * 60_000 });
    const orphans = findOrphanedToolUseSessions(store!.db, {
      cutoffEpoch: Date.now() - HOUR,
      limit: 10,
    });
    expect(orphans).toEqual([]);
  });

  it('skips sessions that already produced at least one observation', () => {
    seedOrphan(store!, { contentSessionId: 'cs-partial', toolUseId: 'toolu_old' });
    // The generator ran for this session: one row got linked (observation_id set).
    const db = store!.db;
    db.prepare("UPDATE tool_uses SET observation_id = 77, memory_session_id = 'mem-1' WHERE tool_use_id = 'toolu_old'").run();
    seedOrphan(store!, { contentSessionId: 'cs-partial', toolUseId: 'toolu_unlinked' });
    const orphans = findOrphanedToolUseSessions(db, { cutoffEpoch: Date.now() - HOUR, limit: 10 });
    expect(orphans).toEqual([]);
  });

  it('skips rows without a session_db_id (no RAM session key to re-feed through)', () => {
    seedOrphan(store!, { contentSessionId: 'cs-nodb', sessionDbId: null });
    const orphans = findOrphanedToolUseSessions(store!.db, {
      cutoffEpoch: Date.now() - HOUR,
      limit: 10,
    });
    expect(orphans).toEqual([]);
  });

  it('orders oldest-first and caps the round at the limit', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      seedOrphan(store!, { contentSessionId: `cs-cap-${i}`, sessionDbId: 300 + i, createdAtEpoch: now - (i + 1) * HOUR });
    }
    const orphans = findOrphanedToolUseSessions(store!.db, { cutoffEpoch: now - HOUR, limit: 3 });
    expect(orphans.map(o => o.content_session_id)).toEqual(['cs-cap-4', 'cs-cap-3', 'cs-cap-2']);
  });
});

describe('getOrphanedToolUseRows (re-feed source)', () => {
  let store: SessionStore | undefined;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('returns the session unlinked rows in original capture order with payload intact', () => {
    const base = Date.now() - 2 * HOUR;
    seedOrphan(store!, { contentSessionId: 'cs-order', toolUseId: 'toolu_2', createdAtEpoch: base + 2000 });
    seedOrphan(store!, { contentSessionId: 'cs-order', toolUseId: 'toolu_1', createdAtEpoch: base + 1000 });
    const rows: ToolUseRow[] = getOrphanedToolUseRows(store!.db, 'cs-order');
    expect(rows.map(r => r.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
    expect(rows[0].tool_input).toBe('{"command":"ls"}');
    expect(rows[0].tool_response).toBe('{"ok":true}');
    expect(rows[0].session_db_id).toBe(101);
  });
});

describe('runOrphanRecoveryScan (re-feed + marker)', () => {
  let store: SessionStore | undefined;
  let markerDir: string;
  let markerPath: string;
  let infoLines: string[];
  let warnLines: string[];
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    markerDir = mkdtempSync(join(tmpdir(), 'orphan-recovery-'));
    markerPath = join(markerDir, ORPHAN_RECOVERY_MARKER_FILENAME);
    resetOrphanRecoveryForTesting(markerPath);
    infoLines = [];
    warnLines = [];
    spies = [
      spyOn(logger, 'info').mockImplementation((_c: string, message: string) => { infoLines.push(message); }),
      spyOn(logger, 'warn').mockImplementation((_c: string, message: string) => { warnLines.push(message); }),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    resetOrphanRecoveryForTesting();
    store?.close();
    store = undefined;
  });

  it('re-feeds orphaned sessions oldest-first through queueObservation and kicks the generator', async () => {
    const now = Date.now();
    seedOrphan(store!, { contentSessionId: 'cs-1', sessionDbId: 401, toolUseId: 'toolu_a', createdAtEpoch: now - 3 * HOUR });
    seedOrphan(store!, { contentSessionId: 'cs-2', sessionDbId: 402, toolUseId: 'toolu_b', createdAtEpoch: now - 2 * HOUR });
    const manager = fakeSessionManager();
    const result = await runOrphanRecoveryScan(scanDeps(store!.db, manager), { source: 'test-startup' });

    expect(result.scheduled).toBe(2);
    expect(result.candidates).toBe(2);
    expect(manager.queued.map(q => q.toolUseId)).toEqual(['toolu_a', 'toolu_b']);
    expect(manager.queued[0].tool_name).toBe('Bash');
    expect(manager.queued[0].tool_input).toBe('{"command":"ls"}');
    expect(manager.kicks).toEqual([
      { sessionDbId: 401, source: 'orphan-recovery:test-startup' },
      { sessionDbId: 402, source: 'orphan-recovery:test-startup' },
    ]);
  });

  it('drops explicit-memory-write rows the way ingest does (echo must not buy an observation)', async () => {
    // ingestObservation records a save_memory's tool I/O in tool_uses and then
    // skips its observation (the `explicit_memory_write` skip): the note is
    // already durable. Recovery must not override that skip on re-feed.
    const now = Date.now();
    seedOrphan(store!, { contentSessionId: 'cs-mixed', sessionDbId: 451, toolUseId: 'toolu_save', toolName: 'save_memory', createdAtEpoch: now - 3 * HOUR });
    seedOrphan(store!, { contentSessionId: 'cs-mixed', sessionDbId: 451, toolUseId: 'toolu_bash', toolName: 'Bash', createdAtEpoch: now - 2 * HOUR });
    const manager = fakeSessionManager();
    const result = await runOrphanRecoveryScan(scanDeps(store!.db, manager), { source: 'test' });

    expect(result.scheduled).toBe(1);
    expect(manager.queued.map(q => q.toolUseId)).toEqual(['toolu_bash']);
    expect(manager.kicks).toEqual([{ sessionDbId: 451, source: 'orphan-recovery:test' }]);
  });

  it('skips a session whose every row is an explicit-memory echo, and marks it so it stops occupying slots', async () => {
    seedOrphan(store!, { contentSessionId: 'cs-echo', sessionDbId: 452, toolUseId: 'toolu_echo', toolName: 'save_memory' });
    const manager = fakeSessionManager();
    const marker = new OrphanReplayMarkerStore(markerPath);
    const first = await runOrphanRecoveryScan(scanDeps(store!.db, manager), { source: 'test', marker });

    expect(first.scheduled).toBe(0);
    expect(first.skippedExplicitMemoryOnly).toBe(1);
    expect(manager.queued).toEqual([]);
    expect(manager.kicks).toEqual([]);

    // The rows stay unlinked forever, so without the marker this session would
    // re-occupy a candidate slot on every later round.
    const second = await runOrphanRecoveryScan(scanDeps(store!.db, manager), { source: 'test', marker });
    expect(second.scheduled).toBe(0);
    expect(second.skippedExplicitMemoryOnly).toBe(0);
    expect(second.skippedAlreadyScheduled).toBe(1);
  });

  it('is idempotent in-process: the second scan re-feeds nothing (one-shot marker)', async () => {
    seedOrphan(store!, { contentSessionId: 'cs-once', sessionDbId: 401, toolUseId: 'toolu_x' });
    const manager = fakeSessionManager();
    const deps = scanDeps(store!.db, manager);
    await runOrphanRecoveryScan(deps, { source: 'test', marker: new OrphanReplayMarkerStore(markerPath) });
    const second = await runOrphanRecoveryScan(deps, { source: 'test', marker: new OrphanReplayMarkerStore(markerPath) });

    expect(second.scheduled).toBe(0);
    expect(second.skippedAlreadyScheduled).toBe(1);
    expect(manager.queued.length).toBe(1);
    expect(manager.kicks.length).toBe(1);
  });

  it('persists the marker, so a restarted worker does not replay the same session again', async () => {
    seedOrphan(store!, { contentSessionId: 'cs-restart', sessionDbId: 403, toolUseId: 'toolu_r' });
    await runOrphanRecoveryScan(scanDeps(store!.db), {
      source: 'test',
      marker: new OrphanReplayMarkerStore(markerPath),
    });

    // Simulate the successor process: a fresh store over the same file.
    const successor = new OrphanReplayMarkerStore(markerPath);
    expect(successor.has('cs-restart')).toBe(true);
    const after = await runOrphanRecoveryScan(scanDeps(store!.db), {
      source: 'test-after-restart',
      marker: successor,
    });
    expect(after.scheduled).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf-8')).toContain('cs-restart');
  });

  it('skips sessions still live in this process (the normal machinery owns them)', async () => {
    seedOrphan(store!, { contentSessionId: 'cs-live', sessionDbId: 404, toolUseId: 'toolu_l' });
    const manager = fakeSessionManager([404]);
    const result = await runOrphanRecoveryScan(scanDeps(store!.db, manager), { source: 'test' });
    expect(result.scheduled).toBe(0);
    expect(result.skippedLive).toBe(1);
    expect(manager.queued).toEqual([]);
  });

  it('isolates a failed generator kick: the round continues with the next session', async () => {
    const now = Date.now();
    seedOrphan(store!, { contentSessionId: 'cs-k1', sessionDbId: 501, toolUseId: 'toolu_k1', createdAtEpoch: now - 3 * HOUR });
    seedOrphan(store!, { contentSessionId: 'cs-k2', sessionDbId: 502, toolUseId: 'toolu_k2', createdAtEpoch: now - 2 * HOUR });
    const manager = fakeSessionManager();
    const result = await runOrphanRecoveryScan(scanDeps(store!.db, manager, { failKicksFor: [501] }), { source: 'test' });

    expect(result.scheduled).toBe(2);
    expect(manager.queued.length).toBe(2);
    expect(warnLines.some(line => line.startsWith('Orphan recovery kick failed'))).toBe(true);
  });

  it('caps a round at maxSessions (bounded, the rest wait for the next tick)', async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      seedOrphan(store!, { contentSessionId: `cs-cap-${i}`, sessionDbId: 600 + i, toolUseId: `toolu_c${i}`, createdAtEpoch: now - (i + 1) * HOUR });
    }
    const manager = fakeSessionManager();
    const result = await runOrphanRecoveryScan(scanDeps(store!.db, manager), { source: 'test', maxSessions: 2 });
    expect(result.scheduled).toBe(2);
    // Oldest first: cs-cap-3 (4h) and cs-cap-2 (3h) beat the newer two.
    expect(manager.queued.map(q => q.sessionDbId)).toEqual([603, 602]);
  });
});

describe('SessionRoutes.scanOrphanedSessions (pacing)', () => {
  let store: SessionStore | undefined;
  let savedEnv: Record<string, string | undefined>;
  let spies: Array<ReturnType<typeof spyOn>>;

  const ENV_KEYS = ['CLAUDE_MEM_PROVIDER', 'CLAUDE_MEM_TIER_ROUTING_ENABLED'] as const;

  function buildRoutes(manager: ReturnType<typeof fakeSessionManager>) {
    const routes = new SessionRoutes(
      manager as any,
      { getConnection: () => store!.db } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {} as any,
      {} as any,
      { finalizeSession: async () => {} } as any,
    );
    return routes;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_PROVIDER = 'claude';
    process.env.CLAUDE_MEM_TIER_ROUTING_ENABLED = 'false';
    resetQuotaCooldownsForTesting();
    resetOrphanRecoveryForTesting();
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetQuotaCooldownsForTesting();
    resetOrphanRecoveryForTesting();
    store?.close();
    store = undefined;
  });

  it('re-feeds orphaned work once the cooldown window has elapsed', async () => {
    // The breaker is still on the books (probe phase) but withholds nothing.
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day', Date.now() - 31 * 60_000);
    seedOrphan(store!, { contentSessionId: 'cs-past', sessionDbId: 701, toolUseId: 'toolu_p' });
    const manager = fakeSessionManager();
    const routes = buildRoutes(manager);
    const kick = spyOn(routes as any, 'ensureGeneratorRunning').mockImplementation(async () => {});

    const scheduled = await routes.scanOrphanedSessions('startup');
    expect(scheduled).toBe(1);
    expect(manager.queued.map(q => q.toolUseId)).toEqual(['toolu_p']);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('re-feeds nothing while the cooldown actively withholds requests', async () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    seedOrphan(store!, { contentSessionId: 'cs-held', sessionDbId: 702, toolUseId: 'toolu_h' });
    const manager = fakeSessionManager();
    const routes = buildRoutes(manager);

    const scheduled = await routes.scanOrphanedSessions('periodic-resume');
    expect(scheduled).toBe(0);
    expect(manager.queued).toEqual([]);
  });
});
