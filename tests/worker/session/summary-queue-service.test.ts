/**
 * Tests for SummaryQueueService
 *
 * Mock Justification (~40% mock code):
 * - SessionManager mock: Avoid the full worker-service import chain; we only need
 *   to verify queueSummarize is called with correct arguments.
 * - SessionEventBroadcaster mock: Verify broadcast side-effects without spinning
 *   up SSE infrastructure.
 *
 * What's NOT mocked: SummaryQueueService itself — its logic is exercised directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SummaryQueueService } from '../../../src/services/worker/session/SummaryQueueService.js';
import type { SummaryQueueDeps } from '../../../src/services/worker/session/SummaryQueueService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(): { deps: SummaryQueueDeps; queueSummarizeMock: ReturnType<typeof vi.fn>; broadcastMock: ReturnType<typeof vi.fn> } {
  const queueSummarizeMock = vi.fn();
  const broadcastMock = vi.fn();

  const deps: SummaryQueueDeps = {
    sessionManager: {
      queueSummarize: queueSummarizeMock,
    } as unknown as SummaryQueueDeps['sessionManager'],
    eventBroadcaster: {
      broadcastSummarizeQueued: broadcastMock,
    } as unknown as SummaryQueueDeps['eventBroadcaster'],
  };

  return { deps, queueSummarizeMock, broadcastMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SummaryQueueService', () => {
  let service: SummaryQueueService;
  let queueSummarizeMock: ReturnType<typeof vi.fn>;
  let broadcastMock: ReturnType<typeof vi.fn>;
  let deps: SummaryQueueDeps;

  beforeEach(() => {
    const mocks = createMockDeps();
    deps = mocks.deps;
    queueSummarizeMock = mocks.queueSummarizeMock;
    broadcastMock = mocks.broadcastMock;
    service = new SummaryQueueService(deps);
  });

  // ─── Success cases ─────────────────────────────────────────────────────────

  describe('queueSummary — success cases', () => {
    it('calls sessionManager.queueSummarize with the correct sessionDbId', () => {
      service.queueSummary(42);

      expect(queueSummarizeMock).toHaveBeenCalledTimes(1);
      expect(queueSummarizeMock).toHaveBeenCalledWith(42, undefined);
    });

    it('calls eventBroadcaster.broadcastSummarizeQueued after successful queue', () => {
      service.queueSummary(42);

      expect(broadcastMock).toHaveBeenCalledTimes(1);
    });

    it('returns true on success', () => {
      const result = service.queueSummary(42);

      expect(result).toBe(true);
    });

    it('passes lastAssistantMessage through to queueSummarize when provided', () => {
      const message = 'The assistant said something useful.';
      service.queueSummary(7, message);

      expect(queueSummarizeMock).toHaveBeenCalledWith(7, message);
    });

    it('passes undefined to queueSummarize when lastAssistantMessage is omitted', () => {
      service.queueSummary(99);

      expect(queueSummarizeMock).toHaveBeenCalledWith(99, undefined);
    });
  });

  // ─── Failure: queueSummarize throws ───────────────────────────────────────

  describe('queueSummary — queueSummarize throws', () => {
    it('returns false when queueSummarize throws', () => {
      queueSummarizeMock.mockImplementation(() => { throw new Error('DB error'); });

      const result = service.queueSummary(42);

      expect(result).toBe(false);
    });

    it('does not call broadcastSummarizeQueued when queueSummarize throws', () => {
      queueSummarizeMock.mockImplementation(() => { throw new Error('DB error'); });

      service.queueSummary(42);

      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it('does not throw to the caller when queueSummarize throws', () => {
      queueSummarizeMock.mockImplementation(() => { throw new Error('DB error'); });

      expect(() => service.queueSummary(42)).not.toThrow();
    });
  });

  // ─── Failure: broadcastSummarizeQueued throws ──────────────────────────────

  describe('queueSummary — broadcastSummarizeQueued throws', () => {
    it('returns true even when broadcastSummarizeQueued throws (summary is still queued)', () => {
      broadcastMock.mockImplementation(() => { throw new Error('SSE error'); });

      const result = service.queueSummary(42);

      expect(result).toBe(true);
    });

    it('still calls queueSummarize before the broadcast failure', () => {
      broadcastMock.mockImplementation(() => { throw new Error('SSE error'); });

      service.queueSummary(42);

      expect(queueSummarizeMock).toHaveBeenCalledTimes(1);
    });

    it('does not throw to the caller when broadcastSummarizeQueued throws', () => {
      broadcastMock.mockImplementation(() => { throw new Error('SSE error'); });

      expect(() => service.queueSummary(42)).not.toThrow();
    });
  });
});
