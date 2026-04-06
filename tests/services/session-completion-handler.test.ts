import { describe, it, expect, mock } from 'bun:test';
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

  const pendingStore = {
    getPendingCount: mock((id: number) => pendingCountFn(id)),
    markAllSessionMessagesAbandoned: mock((_id: number) => 0),
  };

  return {
    deleteSession: mock(async (_id: number) => {}),
    getSession: mock((id: number) => getSessionFn(id)),
    getPendingMessageStore: () => pendingStore,
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

    const result = await handler.completeByDbId(1);

    expect(result).toEqual({ deferred: false });
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcastSessionCompleted).toHaveBeenCalledTimes(1);
  });

  it('should defer when queue has pending work', async () => {
    sessionManager = createMockSessionManager({ pendingCount: () => 1 });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    const result = await handler.completeByDbId(1);

    expect(result).toEqual({ deferred: true });
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

    const result = await handler.completeByDbId(1);
    expect(result).toEqual({ deferred: true });

    // Wait for deferred poll to detect drain (~500ms poll interval)
    await new Promise(resolve => setTimeout(resolve, 700));

    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(1);
    expect(broadcaster.broadcastSessionCompleted).toHaveBeenCalledTimes(1);
  });

  it('should defer all 4 concurrent completions', async () => {
    sessionManager = createMockSessionManager({ pendingCount: () => 1 });
    broadcaster = createMockBroadcaster();
    handler = new SessionCompletionHandler(sessionManager, broadcaster);

    const results = await Promise.all([
      handler.completeByDbId(1),
      handler.completeByDbId(2),
      handler.completeByDbId(3),
      handler.completeByDbId(4),
    ]);

    expect(results).toEqual([
      { deferred: true },
      { deferred: true },
      { deferred: true },
      { deferred: true },
    ]);
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(0);
  });

  it('should drain orphaned messages when session removed during deferral', async () => {
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

    const result = await handler.completeByDbId(1);
    expect(result).toEqual({ deferred: true });

    // Wait for 2 poll ticks: first sees session, second sees it gone
    await new Promise(resolve => setTimeout(resolve, 1200));

    // Should NOT have called deleteSession — session already gone
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(0);
    // Should have drained orphaned messages defensively
    expect(sessionManager.getPendingMessageStore().markAllSessionMessagesAbandoned)
      .toHaveBeenCalledWith(1);
  });
});
