import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';

describe('SessionManager queue integration', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(() => {
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
