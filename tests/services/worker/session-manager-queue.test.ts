import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager, _resetBullmqFoldWarned } from '../../../src/services/worker/SessionManager.js';
import { _resetDedupFoldConfigCache } from '../../../src/services/worker/dedup-fold.js';
import { logger } from '../../../src/utils/logger.js';

describe('SessionManager queue integration', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
    _resetBullmqFoldWarned();
    db = new ClaudeMemDatabase(':memory:').db;
    store = new SessionStore(db);

    const dbManager = {
      getSessionStore: () => store,
      getSessionById: (sessionDbId: number) => {
        const session = store.getSessionById(sessionDbId);
        if (!session) {
          throw new Error(`Session ${sessionDbId} not found`);
        }
        return session;
      },
    } as unknown as DatabaseManager;

    manager = new SessionManager(dbManager);
  });

  afterEach(async () => {
    await manager.shutdownAll();
    db.close();
  });

  test('confirmClaimedMessages only deletes claimed rows and preserves newly queued work', async () => {
    const sessionDbId = store.createSDKSession(
      'content-ack-invariant',
      'test-project',
      'Test prompt'
    );
    manager.initializeSession(sessionDbId);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'FirstTool',
      tool_input: { step: 1 },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'tool-a',
    });

    const iterator = manager.getMessageIterator(sessionDbId);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?._persistentId).toBeGreaterThan(0);

    await manager.queueObservation(sessionDbId, {
      tool_name: 'SecondTool',
      tool_input: { step: 2 },
      tool_response: { ok: true },
      prompt_number: 1,
      toolUseId: 'tool-b',
    });

    expect(await manager.confirmClaimedMessages(sessionDbId)).toBe(1);
    await iterator.return?.();

    const rows = db.prepare(`
      SELECT tool_use_id, status
      FROM pending_messages
      WHERE session_db_id = ?
      ORDER BY id ASC
    `).all(sessionDbId) as Array<{ tool_use_id: string; status: string }>;

    expect(rows).toEqual([{ tool_use_id: 'tool-b', status: 'pending' }]);
    expect(await manager.getTotalQueueDepth()).toBe(1);
  });

  test('queueObservation folds onto an existing candidate and skips enqueue', async () => {
    const sessionDbId = store.createSDKSession(
      'content-fold-true',
      'test-project',
      'Test prompt'
    );
    manager.initializeSession(sessionDbId);

    const previousEnabled = process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED = 'true';
    _resetDedupFoldConfigCache();

    let bumpCalls: Array<number> = [];
    let enqueueCalls = 0;
    const mockQueue = {
      enqueue: async () => {
        enqueueCalls += 1;
        return 1;
      },
      createIterator: () => { throw new Error('not used'); },
      confirmProcessed: async () => 0,
      clearPendingForSession: async () => 0,
      resetProcessingToPending: async () => 0,
      getPendingCount: async () => 0,
      getTotalQueueDepth: async () => 0,
      close: async () => {},
      peekPendingTypes: async () => [],
      findFoldCandidate: () => ({ id: 42, createdAtEpoch: Date.now() - 1000 }),
      bumpFoldCount: (rowId: number) => {
        bumpCalls.push(rowId);
        return { newCount: 5 };
      },
    };

    (manager as any).queueEngine = mockQueue;
    (manager as any).queueEngineName = 'sqlite';

    try {
      const result = await manager.queueObservation(sessionDbId, {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { ok: true },
        prompt_number: 1,
        toolUseId: 'fold-target',
        cwd: '/repo',
      });

      expect(result).toEqual({ folded: true });
      expect(bumpCalls).toEqual([42]);
      expect(enqueueCalls).toBe(0);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED;
      } else {
        process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED = previousEnabled;
      }
      _resetDedupFoldConfigCache();
    }
  });

  test('queueObservation warns once when fold is enabled but engine lacks fold methods', async () => {
    const sessionDbId = store.createSDKSession(
      'content-fold-warn-once',
      'test-project',
      'Test prompt'
    );
    manager.initializeSession(sessionDbId);

    const previousEnabled = process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED = 'true';
    _resetDedupFoldConfigCache();

    const originalWarn = logger.warn.bind(logger);
    const warnCalls: Array<Array<unknown>> = [];
    logger.warn = ((...args: Array<unknown>) => {
      warnCalls.push(args);
    }) as typeof logger.warn;

    const mockQueue = {
      enqueue: async () => 1,
      createIterator: () => { throw new Error('not used'); },
      confirmProcessed: async () => 0,
      clearPendingForSession: async () => 0,
      resetProcessingToPending: async () => 0,
      getPendingCount: async () => 0,
      getTotalQueueDepth: async () => 0,
      close: async () => {},
      peekPendingTypes: async () => [],
    };

    (manager as any).queueEngine = mockQueue;
    (manager as any).queueEngineName = 'bullmq';

    try {
      await manager.queueObservation(sessionDbId, {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { ok: true },
        prompt_number: 1,
        toolUseId: 'warn-1',
        cwd: '/repo',
      });

      const dedupWarns = warnCalls.filter((args) => args[0] === 'DEDUP');
      expect(dedupWarns.length).toBe(1);

      await manager.queueObservation(sessionDbId, {
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
        tool_response: { ok: true },
        prompt_number: 1,
        toolUseId: 'warn-2',
        cwd: '/repo',
      });

      const dedupWarnsAfter = warnCalls.filter((args) => args[0] === 'DEDUP');
      expect(dedupWarnsAfter.length).toBe(1);
    } finally {
      logger.warn = originalWarn;
      if (previousEnabled === undefined) {
        delete process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED;
      } else {
        process.env.CLAUDE_MEM_DEDUP_FOLD_ENABLED = previousEnabled;
      }
      _resetDedupFoldConfigCache();
      _resetBullmqFoldWarned();
    }
  });

  test('initializeQueueEngine does not require the database before sqlite mode is used', async () => {
    const previous = process.env.CLAUDE_MEM_QUEUE_ENGINE;
    process.env.CLAUDE_MEM_QUEUE_ENGINE = 'sqlite';
    try {
      const earlyManager = new SessionManager({
        getSessionStore: () => {
          throw new Error('Database not initialized');
        },
      } as unknown as DatabaseManager);

      await expect(earlyManager.initializeQueueEngine()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_MEM_QUEUE_ENGINE;
      } else {
        process.env.CLAUDE_MEM_QUEUE_ENGINE = previous;
      }
    }
  });
});
