import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

// Mock worker-service to avoid import chain
mock.module('../../../src/services/worker-service.js', () => ({}));
mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { SessionEventBroadcaster } from '../../../src/services/worker/events/SessionEventBroadcaster.js';
import type { SSEBroadcaster } from '../../../src/services/worker/SSEBroadcaster.js';
import type { WorkerService } from '../../../src/services/worker-service.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('SessionEventBroadcaster', () => {
  let mockBroadcast: ReturnType<typeof mock>;
  let mockBroadcastProcessingStatus: ReturnType<typeof mock>;
  let broadcaster: SessionEventBroadcaster;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    mockBroadcast = mock(() => {});
    mockBroadcastProcessingStatus = mock(() => {});

    const mockSSEBroadcaster = {
      broadcast: mockBroadcast,
    } as unknown as SSEBroadcaster;

    const mockWorkerService = {
      broadcastProcessingStatus: mockBroadcastProcessingStatus,
    } as unknown as WorkerService;

    broadcaster = new SessionEventBroadcaster(mockSSEBroadcaster, mockWorkerService);
  });

  describe('broadcastThoughtStored', () => {
    it('broadcasts thought_stored event with correct fields', () => {
      broadcaster.broadcastThoughtStored({
        id: 42,
        project: 'test-project',
        thinking_text: 'This is a short thought.',
        created_at_epoch: 1700000000,
      });

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      const call = mockBroadcast.mock.calls[0][0];
      expect(call.type).toBe('thought_stored');
      expect(call.thought.id).toBe(42);
      expect(call.thought.project).toBe('test-project');
      expect(call.thought.thinking_text_preview).toBe('This is a short thought.');
      expect(call.thought.created_at_epoch).toBe(1700000000);
    });

    it('truncates thinking_text_preview to 200 characters', () => {
      const longText = 'A'.repeat(500);

      broadcaster.broadcastThoughtStored({
        id: 1,
        project: 'test-project',
        thinking_text: longText,
        created_at_epoch: 1700000000,
      });

      const call = mockBroadcast.mock.calls[0][0];
      expect(call.thought.thinking_text_preview).toHaveLength(200);
      expect(call.thought.thinking_text_preview).toBe('A'.repeat(200));
    });

    it('does not call broadcastProcessingStatus', () => {
      broadcaster.broadcastThoughtStored({
        id: 1,
        project: 'test-project',
        thinking_text: 'Some thought',
        created_at_epoch: 1700000000,
      });

      expect(mockBroadcastProcessingStatus).not.toHaveBeenCalled();
    });
  });

  describe('broadcastNewPrompt', () => {
    it('broadcasts new_prompt and updates processing status', () => {
      broadcaster.broadcastNewPrompt({
        id: 1,
        content_session_id: 'cs-1',
        project: 'test-project',
        prompt_number: 1,
        prompt_text: 'hello',
        created_at_epoch: 1700000000,
      });

      expect(mockBroadcast).toHaveBeenCalledTimes(2); // new_prompt + processing_status
      expect(mockBroadcast.mock.calls[0][0].type).toBe('new_prompt');
      expect(mockBroadcast.mock.calls[1][0].type).toBe('processing_status');
      expect(mockBroadcastProcessingStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('broadcastSessionCompleted', () => {
    it('broadcasts session_completed event', () => {
      broadcaster.broadcastSessionCompleted(99);

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(mockBroadcast.mock.calls[0][0].type).toBe('session_completed');
      expect(mockBroadcast.mock.calls[0][0].sessionDbId).toBe(99);
      expect(mockBroadcastProcessingStatus).toHaveBeenCalledTimes(1);
    });
  });
});
