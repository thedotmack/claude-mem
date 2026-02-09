/**
 * Tests for session cleanup helper functionality
 *
 * Mock Justification (~19% mock code):
 * - Session fixtures: Required to create valid ActiveSession objects with
 *   all required fields - tests the actual cleanup logic
 * - Worker mocks: Verify broadcast notification calls - the actual
 *   cleanupProcessedMessages logic is tested against real session mutation
 *
 * What's NOT mocked: Session state mutation, null/undefined handling
 */
import { describe, it, expect, mock } from 'bun:test';

// Import directly from specific files to avoid worker-service import chain
import { cleanupProcessedMessages } from '../../../src/services/worker/agents/SessionCleanupHelper.js';
import type { WorkerRef } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';

describe('SessionCleanupHelper', () => {
  // Helper to create a minimal mock session
  function createMockSession(
    overrides: Partial<ActiveSession> = {}
  ): ActiveSession {
    return {
      sessionDbId: 1,
      contentSessionId: 'content-session-123',
      memorySessionId: 'memory-session-456',
      project: 'test-project',
      userPrompt: 'Test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 5,
      startTime: Date.now(),
      cumulativeInputTokens: 100,
      cumulativeOutputTokens: 50,
      earliestPendingTimestamp: Date.now() - 10000, // 10 seconds ago
      conversationHistory: [],
      currentProvider: 'claude',
      processingMessageIds: [],  // CLAIM-CONFIRM pattern: track message IDs being processed
      ...overrides,
    };
  }

  // Helper to create mock worker
  function createMockWorker() {
    const broadcastProcessingStatusMock = mock(() => {});
    const worker: WorkerRef = {
      sseBroadcaster: {
        broadcast: mock(() => {}),
      },
      broadcastProcessingStatus: broadcastProcessingStatusMock,
    };
    return { worker, broadcastProcessingStatusMock };
  }

  describe('cleanupProcessedMessages', () => {
    it('should reset session.earliestPendingTimestamp to null', () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });
      const { worker } = createMockWorker();

      expect(session.earliestPendingTimestamp).toBe(1700000000000);

      cleanupProcessedMessages(session, worker);

      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should reset earliestPendingTimestamp even when already null', () => {
      const session = createMockSession({
        earliestPendingTimestamp: null,
      });
      const { worker } = createMockWorker();

      cleanupProcessedMessages(session, worker);

      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should call worker.broadcastProcessingStatus() if available', () => {
      const session = createMockSession();
      const { worker, broadcastProcessingStatusMock } = createMockWorker();

      cleanupProcessedMessages(session, worker);

      expect(broadcastProcessingStatusMock).toHaveBeenCalledTimes(1);
    });

    it('should handle missing worker gracefully (no crash)', () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });

      // Should not throw
      expect(() => {
        cleanupProcessedMessages(session, undefined);
      }).not.toThrow();

      // Should still reset timestamp
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should handle worker without broadcastProcessingStatus', () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });
      const worker: WorkerRef = {
        sseBroadcaster: {
          broadcast: mock(() => {}),
        },
        // No broadcastProcessingStatus
      };

      // Should not throw
      expect(() => {
        cleanupProcessedMessages(session, worker);
      }).not.toThrow();

      // Should still reset timestamp
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should handle empty worker object', () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });
      const worker: WorkerRef = {};

      // Should not throw
      expect(() => {
        cleanupProcessedMessages(session, worker);
      }).not.toThrow();

      // Should still reset timestamp
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should handle worker with null broadcastProcessingStatus', () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });
      const worker: WorkerRef = {
        broadcastProcessingStatus: undefined,
      };

      // Should not throw
      expect(() => {
        cleanupProcessedMessages(session, worker);
      }).not.toThrow();

      // Should still reset timestamp
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should not modify other session properties', () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
        lastPromptNumber: 10,
        cumulativeInputTokens: 500,
        cumulativeOutputTokens: 250,
        project: 'my-project',
      });
      const { worker } = createMockWorker();

      cleanupProcessedMessages(session, worker);

      // Only earliestPendingTimestamp should change
      expect(session.earliestPendingTimestamp).toBeNull();
      expect(session.lastPromptNumber).toBe(10);
      expect(session.cumulativeInputTokens).toBe(500);
      expect(session.cumulativeOutputTokens).toBe(250);
      expect(session.project).toBe('my-project');
    });
  });
});
