import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { SessionEventBroadcaster } from '../../src/services/worker/events/SessionEventBroadcaster.js';

/**
 * Tests for SessionCompletionHandler graceful deferred completion.
 *
 * When session-complete is called while pending messages exist (e.g. in-flight
 * summarize), deletion is deferred to let the generator finish processing.
 * This prevents the Stop hook from needing to poll (which blocked the CLI).
 * See: https://github.com/thedotmack/claude-mem/issues/1601
 */

function createMockSessionManager(opts: {
  pendingCount?: (id: number) => number;
  getSession?: (id: number) => any;
} = {}) {
  const pendingCountFn = opts.pendingCount ?? (() => 0);
  const getSessionFn = opts.getSession ?? ((id: number) => ({ sessionDbId: id, startTime: Date.now() }));

  return {
    deleteSession: mock(async (_id: number) => {}),
    getSession: mock((id: number) => getSessionFn(id)),
    getPendingMessageStore: () => ({
      getPendingCount: mock((id: number) => pendingCountFn(id)),
      markAllSessionMessagesAbandoned: mock((_id: number) => 0),
    }),
  } as unknown as SessionManager;
}

function createMockBroadcaster() {
  return {
    broadcastSessionCompleted: mock((_id: number) => {}),
  } as unknown as SessionEventBroadcaster;
}

describe('SessionCompletionHandler', () => {
  let handler: SessionCompletionHandler;
  let sessionManager: SessionManager;
  let broadcaster: SessionEventBroadcaster;

  it('should delete session immediately when queue is empty', async () => {
    sessionManager = createMockSessionManager({ pendingCount: () => 0 });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    await handler.completeByDbId(1);

    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcastSessionCompleted).toHaveBeenCalledTimes(1);
  });

  it('should not delete immediately when queue has pending work', async () => {
    sessionManager = createMockSessionManager({ pendingCount: () => 1 });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    const start = Date.now();
    await handler.completeByDbId(1);
    const elapsed = Date.now() - start;

    // Returns immediately (not blocking) but has NOT deleted yet
    expect(elapsed).toBeLessThan(100);
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(0);
  });

  it('should delete after queue drains', async () => {
    let callCount = 0;
    sessionManager = createMockSessionManager({
      pendingCount: () => {
        callCount++;
        // First call (in completeByDbId): pending. Subsequent (poll): drained.
        return callCount <= 1 ? 1 : 0;
      },
    });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    await handler.completeByDbId(1);

    // Wait for deferred poll to detect drain (~500ms poll interval)
    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcastSessionCompleted).toHaveBeenCalledTimes(1);
  });

  it('should handle 4 concurrent completions without blocking', async () => {
    sessionManager = createMockSessionManager({ pendingCount: () => 1 });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    const start = Date.now();
    await Promise.all([
      handler.completeByDbId(1),
      handler.completeByDbId(2),
      handler.completeByDbId(3),
      handler.completeByDbId(4),
    ]);
    const elapsed = Date.now() - start;

    // All 4 return in <100ms (deferred, not blocking)
    expect(elapsed).toBeLessThan(100);
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(0);
  });

  it('should not delete if session removed by another path during deferral', async () => {
    let checkCount = 0;
    sessionManager = createMockSessionManager({
      pendingCount: () => 1,
      getSession: () => {
        checkCount++;
        // Session exists on first check, gone on subsequent polls
        return checkCount <= 1 ? { sessionDbId: 1, startTime: Date.now() } : null;
      },
    });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    await handler.completeByDbId(1);

    // Wait for poll to detect missing session
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Should NOT have called deleteSession — session already gone
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(0);
  });
});
