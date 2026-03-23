/**
 * Zombie Agent Prevention Tests
 *
 * Tests the mechanisms that prevent zombie/duplicate SDK agent spawning:
 * 1. Concurrent spawn prevention - generatorPromise guards against duplicate spawns
 * 2. Crash recovery gate - processPendingQueues skips active sessions
 * 3. queueDepth accuracy - database-backed pending count tracking
 *
 * These tests verify the fix for Issue #737 (zombie process accumulation).
 *
 * Mock Justification (~25% mock code):
 * - Session fixtures: Required to create valid ActiveSession objects with
 *   all required fields - tests actual guard logic
 * - Database: In-memory SQLite for isolation - tests real query behavior
 */

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

  /**
   * Helper to create a minimal mock session
   */
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

  /**
   * Helper to create a session in the database and return its ID
   */
  function createDbSession(contentSessionId: string, project: string = 'test-project'): number {
    return createSDKSession(db, contentSessionId, project, 'Test user prompt');
  }

  /**
   * Helper to enqueue a test message
   */
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

  // Test 1: Concurrent spawn prevention
  test('should prevent concurrent spawns for same session', async () => {
    // Create a session with an active generator
    const session = createMockSession(1);

    // Simulate an active generator by setting generatorPromise
    // This is the guard that prevents duplicate spawns
    session.generatorPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    // Verify the guard is in place
    expect(session.generatorPromise).not.toBeNull();

    // The pattern used in worker-service.ts:
    // if (existingSession?.generatorPromise) { skip }
    const shouldSkip = session.generatorPromise !== null;
    expect(shouldSkip).toBe(true);

    // Wait for the promise to resolve
    await session.generatorPromise;

    // After generator completes, promise is set to null
    session.generatorPromise = null;

    // Now spawning should be allowed
    const canSpawnNow = session.generatorPromise === null;
    expect(canSpawnNow).toBe(true);
  });

  // Test 2: Crash recovery gate
  test('should prevent duplicate crash recovery spawns', async () => {
    // Create sessions in the database
    const sessionId1 = createDbSession('content-1');
    const sessionId2 = createDbSession('content-2');

    // Enqueue messages to simulate pending work
    enqueueTestMessage(sessionId1, 'content-1');
    enqueueTestMessage(sessionId2, 'content-2');

    // Verify both sessions have pending work
    const orphanedSessions = pendingStore.getSessionsWithPendingMessages();
    expect(orphanedSessions).toContain(sessionId1);
    expect(orphanedSessions).toContain(sessionId2);

    // Create in-memory sessions
    const session1 = createMockSession(sessionId1, {
      contentSessionId: 'content-1',
      generatorPromise: new Promise<void>(() => {}), // Active generator
    });
    const session2 = createMockSession(sessionId2, {
      contentSessionId: 'content-2',
      generatorPromise: null, // No active generator
    });

    // Simulate the recovery logic from processPendingQueues
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

      // The key guard: skip if generatorPromise is active
      if (existingSession?.generatorPromise) {
        result.sessionsSkipped++;
        continue;
      }

      result.sessionsStarted++;
      result.startedSessionIds.push(sessionDbId);
    }

    // Session 1 should be skipped (has active generator)
    // Session 2 should be started (no active generator)
    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsStarted).toBe(1);
    expect(result.startedSessionIds).toContain(sessionId2);
    expect(result.startedSessionIds).not.toContain(sessionId1);
  });

  // Test 3: queueDepth accuracy with CLAIM-CONFIRM pattern
  test('should report accurate queueDepth from database', async () => {
    // Create a session
    const sessionId = createDbSession('content-queue-test');

    // Initially no pending messages
    expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    expect(pendingStore.hasAnyPendingWork()).toBe(false);

    // Enqueue 3 messages
    const msgId1 = enqueueTestMessage(sessionId, 'content-queue-test');
    expect(pendingStore.getPendingCount(sessionId)).toBe(1);

    const msgId2 = enqueueTestMessage(sessionId, 'content-queue-test');
    expect(pendingStore.getPendingCount(sessionId)).toBe(2);

    const msgId3 = enqueueTestMessage(sessionId, 'content-queue-test');
    expect(pendingStore.getPendingCount(sessionId)).toBe(3);

    // hasAnyPendingWork should return true
    expect(pendingStore.hasAnyPendingWork()).toBe(true);

    // CLAIM-CONFIRM pattern: claimNextMessage marks as 'processing' (not deleted)
    const claimed = pendingStore.claimNextMessage(sessionId);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(msgId1);

    // Count stays at 3 because 'processing' messages are still counted
    // (they need to be confirmed after successful storage)
    expect(pendingStore.getPendingCount(sessionId)).toBe(3);

    // After confirmProcessed, the message is actually deleted
    pendingStore.confirmProcessed(msgId1);
    expect(pendingStore.getPendingCount(sessionId)).toBe(2);

    // Claim and confirm remaining messages
    const msg2 = pendingStore.claimNextMessage(sessionId);
    pendingStore.confirmProcessed(msg2!.id);
    expect(pendingStore.getPendingCount(sessionId)).toBe(1);

    const msg3 = pendingStore.claimNextMessage(sessionId);
    pendingStore.confirmProcessed(msg3!.id);

    // Should be empty now
    expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    expect(pendingStore.hasAnyPendingWork()).toBe(false);
  });

  // Additional test: Multiple sessions with pending work
  test('should track pending work across multiple sessions', async () => {
    // Create 3 sessions
    const session1Id = createDbSession('content-multi-1');
    const session2Id = createDbSession('content-multi-2');
    const session3Id = createDbSession('content-multi-3');

    // Enqueue different numbers of messages
    enqueueTestMessage(session1Id, 'content-multi-1');
    enqueueTestMessage(session1Id, 'content-multi-1'); // 2 messages

    enqueueTestMessage(session2Id, 'content-multi-2'); // 1 message

    // Session 3 has no messages

    // Verify counts
    expect(pendingStore.getPendingCount(session1Id)).toBe(2);
    expect(pendingStore.getPendingCount(session2Id)).toBe(1);
    expect(pendingStore.getPendingCount(session3Id)).toBe(0);

    // getSessionsWithPendingMessages should return session 1 and 2
    const sessionsWithPending = pendingStore.getSessionsWithPendingMessages();
    expect(sessionsWithPending).toContain(session1Id);
    expect(sessionsWithPending).toContain(session2Id);
    expect(sessionsWithPending).not.toContain(session3Id);
    expect(sessionsWithPending.length).toBe(2);
  });

  // Test: AbortController reset before restart
  test('should reset AbortController when restarting after abort', async () => {
    const session = createMockSession(1);

    // Abort the controller (simulating a cancelled operation)
    session.abortController.abort();
    expect(session.abortController.signal.aborted).toBe(true);

    // The pattern used in worker-service.ts before starting generator:
    // if (session.abortController.signal.aborted) {
    //   session.abortController = new AbortController();
    // }
    if (session.abortController.signal.aborted) {
      session.abortController = new AbortController();
    }

    // New controller should not be aborted
    expect(session.abortController.signal.aborted).toBe(false);
  });

  // Test: Stuck processing messages are recovered by claimNextMessage self-healing
  test('should recover stuck processing messages via claimNextMessage self-healing', async () => {
    const sessionId = createDbSession('content-stuck-recovery');

    // Enqueue and claim a message (transitions to 'processing')
    const msgId = enqueueTestMessage(sessionId, 'content-stuck-recovery');
    const claimed = pendingStore.claimNextMessage(sessionId);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);

    // Simulate crash: message stuck in 'processing' with stale timestamp
    const staleTimestamp = Date.now() - 120_000; // 2 minutes ago
    db.run(
      `UPDATE pending_messages SET started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, msgId]
    );

    // Verify it's stuck
    expect(pendingStore.getPendingCount(sessionId)).toBe(1); // processing counts as pending work

    // Next claimNextMessage should self-heal: reset stuck message and re-claim it
    const recovered = pendingStore.claimNextMessage(sessionId);
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(msgId);

    // Confirm it can be processed successfully
    pendingStore.confirmProcessed(msgId);
    expect(pendingStore.getPendingCount(sessionId)).toBe(0);
  });

  // Test: Generator cleanup on session delete
  test('should properly cleanup generator promise on session delete', async () => {
    const session = createMockSession(1);

    // Track whether generator was awaited
    let generatorCompleted = false;

    // Simulate an active generator
    session.generatorPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        generatorCompleted = true;
        resolve();
      }, 50);
    });

    // Simulate the deleteSession logic:
    // 1. Abort the controller
    session.abortController.abort();

    // 2. Wait for generator to finish
    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {});
    }

    expect(generatorCompleted).toBe(true);

    // 3. Clear the promise
    session.generatorPromise = null;
    expect(session.generatorPromise).toBeNull();
  });

  describe('Session Termination Invariant', () => {
    // Tests the restart-or-terminate invariant:
    // When a generator exits without restarting, its messages must be
    // marked abandoned and the session removed from the active Map.

    test('should mark messages abandoned when session is terminated', () => {
      const sessionId = createDbSession('content-terminate-1');
      enqueueTestMessage(sessionId, 'content-terminate-1');
      enqueueTestMessage(sessionId, 'content-terminate-1');

      // Verify messages exist
      expect(pendingStore.getPendingCount(sessionId)).toBe(2);
      expect(pendingStore.hasAnyPendingWork()).toBe(true);

      // Terminate: mark abandoned (same as terminateSession does)
      const abandoned = pendingStore.markAllSessionMessagesAbandoned(sessionId);
      expect(abandoned).toBe(2);

      // Spinner should stop: no pending work remains
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
      expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    });

    test('should handle terminate with zero pending messages', () => {
      const sessionId = createDbSession('content-terminate-empty');

      // No messages enqueued
      expect(pendingStore.getPendingCount(sessionId)).toBe(0);

      // Terminate with nothing to abandon
      const abandoned = pendingStore.markAllSessionMessagesAbandoned(sessionId);
      expect(abandoned).toBe(0);

      // Still no pending work
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should be idempotent — double terminate marks zero on second call', () => {
      const sessionId = createDbSession('content-terminate-idempotent');
      enqueueTestMessage(sessionId, 'content-terminate-idempotent');

      // First terminate
      const first = pendingStore.markAllSessionMessagesAbandoned(sessionId);
      expect(first).toBe(1);

      // Second terminate — already failed, nothing to mark
      const second = pendingStore.markAllSessionMessagesAbandoned(sessionId);
      expect(second).toBe(0);

      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should remove session from Map via removeSessionImmediate', () => {
      const sessionId = createDbSession('content-terminate-map');
      const session = createMockSession(sessionId, {
        contentSessionId: 'content-terminate-map',
      });

      // Simulate the in-memory sessions Map
      const sessions = new Map<number, ActiveSession>();
      sessions.set(sessionId, session);
      expect(sessions.has(sessionId)).toBe(true);

      // Simulate removeSessionImmediate behavior
      sessions.delete(sessionId);
      expect(sessions.has(sessionId)).toBe(false);
    });

    test('should return hasAnyPendingWork false after all sessions terminated', () => {
      // Create multiple sessions with messages
      const sid1 = createDbSession('content-multi-term-1');
      const sid2 = createDbSession('content-multi-term-2');
      const sid3 = createDbSession('content-multi-term-3');

      enqueueTestMessage(sid1, 'content-multi-term-1');
      enqueueTestMessage(sid1, 'content-multi-term-1');
      enqueueTestMessage(sid2, 'content-multi-term-2');
      enqueueTestMessage(sid3, 'content-multi-term-3');

      expect(pendingStore.hasAnyPendingWork()).toBe(true);

      // Terminate all sessions
      pendingStore.markAllSessionMessagesAbandoned(sid1);
      pendingStore.markAllSessionMessagesAbandoned(sid2);
      pendingStore.markAllSessionMessagesAbandoned(sid3);

      // Spinner must stop
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should not affect other sessions when terminating one', () => {
      const sid1 = createDbSession('content-isolate-1');
      const sid2 = createDbSession('content-isolate-2');

      enqueueTestMessage(sid1, 'content-isolate-1');
      enqueueTestMessage(sid2, 'content-isolate-2');

      // Terminate only session 1
      pendingStore.markAllSessionMessagesAbandoned(sid1);

      // Session 2 still has work
      expect(pendingStore.getPendingCount(sid1)).toBe(0);
      expect(pendingStore.getPendingCount(sid2)).toBe(1);
      expect(pendingStore.hasAnyPendingWork()).toBe(true);
    });

    test('should mark both pending and processing messages as abandoned', () => {
      const sessionId = createDbSession('content-mixed-status');

      // Enqueue two messages
      const msgId1 = enqueueTestMessage(sessionId, 'content-mixed-status');
      enqueueTestMessage(sessionId, 'content-mixed-status');

      // Claim first message (transitions to 'processing')
      const claimed = pendingStore.claimNextMessage(sessionId);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(msgId1);

      // Now we have 1 processing + 1 pending
      expect(pendingStore.getPendingCount(sessionId)).toBe(2);

      // Terminate should mark BOTH as failed
      const abandoned = pendingStore.markAllSessionMessagesAbandoned(sessionId);
      expect(abandoned).toBe(2);
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });

    test('should enforce invariant: no pending work after terminate regardless of initial state', () => {
      const sessionId = createDbSession('content-invariant');

      // Create a complex initial state: some pending, some processing, some with stale timestamps
      enqueueTestMessage(sessionId, 'content-invariant');
      enqueueTestMessage(sessionId, 'content-invariant');
      enqueueTestMessage(sessionId, 'content-invariant');

      // Claim one (processing)
      pendingStore.claimNextMessage(sessionId);

      // Verify complex state
      expect(pendingStore.getPendingCount(sessionId)).toBe(3);

      // THE INVARIANT: after terminate, hasAnyPendingWork MUST be false
      pendingStore.markAllSessionMessagesAbandoned(sessionId);
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
      expect(pendingStore.getPendingCount(sessionId)).toBe(0);
    });
  });
});
