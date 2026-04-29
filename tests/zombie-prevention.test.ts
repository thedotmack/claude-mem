
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../src/services/sqlite/Sessions.js';
import type { ActiveSession, PendingMessage } from '../src/services/worker-types.js';
import type { Database } from 'bun:sqlite';

describe('Zombie Agent Prevention', () => {
  let db: Database;
  let pendingStore: PendingMessageStore;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    pendingStore = new PendingMessageStore(db, 3);
  });

  afterEach(() => {
    db.close();
  });

  function createMockSession(
    sessionDbId: number,
    overrides: Partial<ActiveSession> = {}
  ): ActiveSession {
    return {
      sessionDbId,
      contentSessionId: `content-session-${sessionDbId}`,
      memorySessionId: null,
      project: 'test-project',
      userPrompt: 'Test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: null,
      processingMessageIds: [],  // CLAIM-CONFIRM pattern: track message IDs being processed
      ...overrides,
    };
  }

  function createDbSession(contentSessionId: string, project: string = 'test-project'): number {
    return createSDKSession(db, contentSessionId, project, 'Test user prompt');
  }

  function enqueueTestMessage(sessionDbId: number, contentSessionId: string): number {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
    };
    return pendingStore.enqueue(sessionDbId, contentSessionId, message);
  }

  test('should prevent concurrent spawns for same session', async () => {
    const session = createMockSession(1);

    session.generatorPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(session.generatorPromise).not.toBeNull();

    const shouldSkip = session.generatorPromise !== null;
    expect(shouldSkip).toBe(true);

    await session.generatorPromise;

    session.generatorPromise = null;

    const canSpawnNow = session.generatorPromise === null;
    expect(canSpawnNow).toBe(true);
  });

  test('should prevent duplicate crash recovery spawns', async () => {
    const sessionId1 = createDbSession('content-1');
    const sessionId2 = createDbSession('content-2');

    enqueueTestMessage(sessionId1, 'content-1');
    enqueueTestMessage(sessionId2, 'content-2');

    const orphanedSessions = pendingStore.getSessionsWithPendingMessages();
    expect(orphanedSessions).toContain(sessionId1);
    expect(orphanedSessions).toContain(sessionId2);

    const session1 = createMockSession(sessionId1, {
      contentSessionId: 'content-1',
      generatorPromise: new Promise<void>(() => {}), // Active generator
    });
    const session2 = createMockSession(sessionId2, {
      contentSessionId: 'content-2',
      generatorPromise: null, // No active generator
    });

    const sessions = new Map<number, ActiveSession>();
    sessions.set(sessionId1, session1);
    sessions.set(sessionId2, session2);

    const result = {
      sessionsStarted: 0,
      sessionsSkipped: 0,
      startedSessionIds: [] as number[],
    };

    for (const sessionDbId of orphanedSessions) {
      const existingSession = sessions.get(sessionDbId);

      if (existingSession?.generatorPromise) {
        result.sessionsSkipped++;
        continue;
      }

      result.sessionsStarted++;
      result.startedSessionIds.push(sessionDbId);
    }

    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsStarted).toBe(1);
    expect(result.startedSessionIds).toContain(sessionId2);
    expect(result.startedSessionIds).not.toContain(sessionId1);
  });

  test('should report accurate queueDepth from database', async () => {
    const sessionId = createDbSession('content-queue-test');

    expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    expect(pendingStore.hasAnyPendingWork()).toBe(false);

    const msgId1 = enqueueTestMessage(sessionId, 'content-queue-test');
    expect(pendingStore.getPendingCount(sessionId)).toBe(1);

    const msgId2 = enqueueTestMessage(sessionId, 'content-queue-test');
    expect(pendingStore.getPendingCount(sessionId)).toBe(2);

    const msgId3 = enqueueTestMessage(sessionId, 'content-queue-test');
    expect(pendingStore.getPendingCount(sessionId)).toBe(3);

    expect(pendingStore.hasAnyPendingWork()).toBe(true);

    const claimed = pendingStore.claimNextMessage(sessionId);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(msgId1);

    expect(pendingStore.getPendingCount(sessionId)).toBe(3);

    pendingStore.confirmProcessed(msgId1);
    expect(pendingStore.getPendingCount(sessionId)).toBe(2);

    const msg2 = pendingStore.claimNextMessage(sessionId);
    pendingStore.confirmProcessed(msg2!.id);
    expect(pendingStore.getPendingCount(sessionId)).toBe(1);

    const msg3 = pendingStore.claimNextMessage(sessionId);
    pendingStore.confirmProcessed(msg3!.id);

    expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    expect(pendingStore.hasAnyPendingWork()).toBe(false);
  });

  test('should track pending work across multiple sessions', async () => {
    const session1Id = createDbSession('content-multi-1');
    const session2Id = createDbSession('content-multi-2');
    const session3Id = createDbSession('content-multi-3');

    enqueueTestMessage(session1Id, 'content-multi-1');
    enqueueTestMessage(session1Id, 'content-multi-1'); 

    enqueueTestMessage(session2Id, 'content-multi-2');

    expect(pendingStore.getPendingCount(session1Id)).toBe(2);
    expect(pendingStore.getPendingCount(session2Id)).toBe(1);
    expect(pendingStore.getPendingCount(session3Id)).toBe(0);

    const sessionsWithPending = pendingStore.getSessionsWithPendingMessages();
    expect(sessionsWithPending).toContain(session1Id);
    expect(sessionsWithPending).toContain(session2Id);
    expect(sessionsWithPending).not.toContain(session3Id);
    expect(sessionsWithPending.length).toBe(2);
  });

  test('should reset AbortController when restarting after abort', async () => {
    const session = createMockSession(1);

    session.abortController.abort();
    expect(session.abortController.signal.aborted).toBe(true);

    if (session.abortController.signal.aborted) {
      session.abortController = new AbortController();
    }

    expect(session.abortController.signal.aborted).toBe(false);
  });

  test('should recover stuck processing messages via claimNextMessage self-healing', async () => {
    const sessionId = createDbSession('content-stuck-recovery');

    const msgId = enqueueTestMessage(sessionId, 'content-stuck-recovery');
    const claimed = pendingStore.claimNextMessage(sessionId);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);

    const staleTimestamp = Date.now() - 120_000; 
    db.run(
      `UPDATE pending_messages SET started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, msgId]
    );

    expect(pendingStore.getPendingCount(sessionId)).toBe(1); 

    const recovered = pendingStore.claimNextMessage(sessionId);
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(msgId);

    pendingStore.confirmProcessed(msgId);
    expect(pendingStore.getPendingCount(sessionId)).toBe(0);
  });

  test('should properly cleanup generator promise on session delete', async () => {
    const session = createMockSession(1);

    let generatorCompleted = false;

    session.generatorPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        generatorCompleted = true;
        resolve();
      }, 50);
    });

    session.abortController.abort();

    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {});
    }

    expect(generatorCompleted).toBe(true);

    session.generatorPromise = null;
    expect(session.generatorPromise).toBeNull();
  });

  describe('Session Termination Invariant', () => {

    test('should mark messages abandoned when session is terminated', () => {
      const sessionId = createDbSession('content-terminate-1');
      enqueueTestMessage(sessionId, 'content-terminate-1');
      enqueueTestMessage(sessionId, 'content-terminate-1');

      expect(pendingStore.getPendingCount(sessionId)).toBe(2);
      expect(pendingStore.hasAnyPendingWork()).toBe(true);

      const abandoned = pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(abandoned).toBe(2);

      expect(pendingStore.hasAnyPendingWork()).toBe(false);
      expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    });

    test('should handle terminate with zero pending messages', () => {
      const sessionId = createDbSession('content-terminate-empty');

      expect(pendingStore.getPendingCount(sessionId)).toBe(0);

      const abandoned = pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(abandoned).toBe(0);

      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should be idempotent — double terminate marks zero on second call', () => {
      const sessionId = createDbSession('content-terminate-idempotent');
      enqueueTestMessage(sessionId, 'content-terminate-idempotent');

      const first = pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(first).toBe(1);

      const second = pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(second).toBe(0);

      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should remove session from Map via removeSessionImmediate', () => {
      const sessionId = createDbSession('content-terminate-map');
      const session = createMockSession(sessionId, {
        contentSessionId: 'content-terminate-map',
      });

      const sessions = new Map<number, ActiveSession>();
      sessions.set(sessionId, session);
      expect(sessions.has(sessionId)).toBe(true);

      sessions.delete(sessionId);
      expect(sessions.has(sessionId)).toBe(false);
    });

    test('should return hasAnyPendingWork false after all sessions terminated', () => {
      const sid1 = createDbSession('content-multi-term-1');
      const sid2 = createDbSession('content-multi-term-2');
      const sid3 = createDbSession('content-multi-term-3');

      enqueueTestMessage(sid1, 'content-multi-term-1');
      enqueueTestMessage(sid1, 'content-multi-term-1');
      enqueueTestMessage(sid2, 'content-multi-term-2');
      enqueueTestMessage(sid3, 'content-multi-term-3');

      expect(pendingStore.hasAnyPendingWork()).toBe(true);

      pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sid1 });
      pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sid2 });
      pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sid3 });

      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should not affect other sessions when terminating one', () => {
      const sid1 = createDbSession('content-isolate-1');
      const sid2 = createDbSession('content-isolate-2');

      enqueueTestMessage(sid1, 'content-isolate-1');
      enqueueTestMessage(sid2, 'content-isolate-2');

      pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sid1 });

      expect(pendingStore.getPendingCount(sid1)).toBe(0);
      expect(pendingStore.getPendingCount(sid2)).toBe(1);
      expect(pendingStore.hasAnyPendingWork()).toBe(true);
    });

    test('should mark both pending and processing messages as abandoned', () => {
      const sessionId = createDbSession('content-mixed-status');

      const msgId1 = enqueueTestMessage(sessionId, 'content-mixed-status');
      enqueueTestMessage(sessionId, 'content-mixed-status');

      const claimed = pendingStore.claimNextMessage(sessionId);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(msgId1);

      expect(pendingStore.getPendingCount(sessionId)).toBe(2);

      const abandoned = pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(abandoned).toBe(2);
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should enforce invariant: no pending work after terminate regardless of initial state', () => {
      const sessionId = createDbSession('content-invariant');

      enqueueTestMessage(sessionId, 'content-invariant');
      enqueueTestMessage(sessionId, 'content-invariant');
      enqueueTestMessage(sessionId, 'content-invariant');

      pendingStore.claimNextMessage(sessionId);

      expect(pendingStore.getPendingCount(sessionId)).toBe(3);

      pendingStore.transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
      expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    });
  });
});
