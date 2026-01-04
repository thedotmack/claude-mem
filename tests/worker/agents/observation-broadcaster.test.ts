import { describe, it, expect, mock } from 'bun:test';

// Import directly from specific files to avoid worker-service import chain
import {
  broadcastObservation,
  broadcastSummary,
} from '../../../src/services/worker/agents/ObservationBroadcaster.js';
import type {
  WorkerRef,
  ObservationSSEPayload,
  SummarySSEPayload,
} from '../../../src/services/worker/agents/types.js';

describe('ObservationBroadcaster', () => {
  // Helper to create mock worker with broadcaster
  function createMockWorker() {
    const broadcastMock = mock(() => {});
    const worker: WorkerRef = {
      sseBroadcaster: {
        broadcast: broadcastMock,
      },
      broadcastProcessingStatus: mock(() => {}),
    };
    return { worker, broadcastMock };
  }

  // Helper to create test observation payload
  function createTestObservationPayload(): ObservationSSEPayload {
    return {
      id: 1,
      memory_session_id: 'mem-session-123',
      session_id: 'content-session-456',
      type: 'discovery',
      title: 'Found important pattern',
      subtitle: 'In auth module',
      text: null,
      narrative: 'Discovered a reusable authentication pattern.',
      facts: JSON.stringify(['Pattern uses JWT', 'Supports refresh tokens']),
      concepts: JSON.stringify(['authentication', 'JWT']),
      files_read: JSON.stringify(['src/auth.ts']),
      files_modified: JSON.stringify([]),
      project: 'test-project',
      prompt_number: 5,
      created_at_epoch: Date.now(),
    };
  }

  // Helper to create test summary payload
  function createTestSummaryPayload(): SummarySSEPayload {
    return {
      id: 1,
      session_id: 'content-session-456',
      request: 'Implement user authentication',
      investigated: 'Reviewed existing auth patterns',
      learned: 'JWT with refresh tokens is best',
      completed: 'Basic auth flow implemented',
      next_steps: 'Add rate limiting',
      notes: null,
      project: 'test-project',
      prompt_number: 5,
      created_at_epoch: Date.now(),
    };
  }

  describe('broadcastObservation', () => {
    it('should call worker.sseBroadcaster.broadcast with correct payload', () => {
      const { worker, broadcastMock } = createMockWorker();
      const payload = createTestObservationPayload();

      broadcastObservation(worker, payload);

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith({
        type: 'new_observation',
        observation: payload,
      });
    });

    it('should handle undefined worker gracefully (no crash)', () => {
      const payload = createTestObservationPayload();

      // Should not throw
      expect(() => {
        broadcastObservation(undefined, payload);
      }).not.toThrow();
    });

    it('should handle missing sseBroadcaster gracefully', () => {
      const worker: WorkerRef = {};
      const payload = createTestObservationPayload();

      // Should not throw
      expect(() => {
        broadcastObservation(worker, payload);
      }).not.toThrow();
    });

    it('should handle worker with undefined sseBroadcaster', () => {
      const worker: WorkerRef = {
        sseBroadcaster: undefined,
        broadcastProcessingStatus: mock(() => {}),
      };
      const payload = createTestObservationPayload();

      // Should not throw
      expect(() => {
        broadcastObservation(worker, payload);
      }).not.toThrow();
    });

    it('should broadcast observation with all fields correctly', () => {
      const { worker, broadcastMock } = createMockWorker();
      const payload: ObservationSSEPayload = {
        id: 42,
        memory_session_id: null, // Test null case
        session_id: 'session-xyz',
        type: 'bugfix',
        title: 'Fixed null pointer',
        subtitle: null,
        text: null,
        narrative: 'Resolved NPE in user service.',
        facts: JSON.stringify(['Added null check']),
        concepts: JSON.stringify(['error-handling']),
        files_read: JSON.stringify(['src/user.ts']),
        files_modified: JSON.stringify(['src/user.ts']),
        project: 'my-app',
        prompt_number: 10,
        created_at_epoch: 1700000000000,
      };

      broadcastObservation(worker, payload);

      const call = broadcastMock.mock.calls[0][0];
      expect(call.type).toBe('new_observation');
      expect(call.observation.id).toBe(42);
      expect(call.observation.memory_session_id).toBeNull();
      expect(call.observation.type).toBe('bugfix');
      expect(call.observation.title).toBe('Fixed null pointer');
    });
  });

  describe('broadcastSummary', () => {
    it('should call worker.sseBroadcaster.broadcast with correct payload', () => {
      const { worker, broadcastMock } = createMockWorker();
      const payload = createTestSummaryPayload();

      broadcastSummary(worker, payload);

      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith({
        type: 'new_summary',
        summary: payload,
      });
    });

    it('should handle undefined worker gracefully (no crash)', () => {
      const payload = createTestSummaryPayload();

      // Should not throw
      expect(() => {
        broadcastSummary(undefined, payload);
      }).not.toThrow();
    });

    it('should handle missing sseBroadcaster gracefully', () => {
      const worker: WorkerRef = {};
      const payload = createTestSummaryPayload();

      // Should not throw
      expect(() => {
        broadcastSummary(worker, payload);
      }).not.toThrow();
    });

    it('should handle worker with undefined sseBroadcaster', () => {
      const worker: WorkerRef = {
        sseBroadcaster: undefined,
      };
      const payload = createTestSummaryPayload();

      // Should not throw
      expect(() => {
        broadcastSummary(worker, payload);
      }).not.toThrow();
    });

    it('should broadcast summary with all fields correctly', () => {
      const { worker, broadcastMock } = createMockWorker();
      const payload: SummarySSEPayload = {
        id: 99,
        session_id: 'session-abc',
        request: 'Build login form',
        investigated: 'Looked at existing forms',
        learned: 'React Hook Form is good',
        completed: 'Form is ready',
        next_steps: 'Add validation',
        notes: 'Some additional notes here',
        project: 'frontend-app',
        prompt_number: 3,
        created_at_epoch: 1700000001000,
      };

      broadcastSummary(worker, payload);

      const call = broadcastMock.mock.calls[0][0];
      expect(call.type).toBe('new_summary');
      expect(call.summary.id).toBe(99);
      expect(call.summary.request).toBe('Build login form');
      expect(call.summary.notes).toBe('Some additional notes here');
    });

    it('should broadcast summary with null optional fields', () => {
      const { worker, broadcastMock } = createMockWorker();
      const payload: SummarySSEPayload = {
        id: 50,
        session_id: 'session-def',
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        project: 'empty-project',
        prompt_number: 1,
        created_at_epoch: 1700000002000,
      };

      broadcastSummary(worker, payload);

      const call = broadcastMock.mock.calls[0][0];
      expect(call.type).toBe('new_summary');
      expect(call.summary.request).toBeNull();
      expect(call.summary.notes).toBeNull();
    });
  });
});
