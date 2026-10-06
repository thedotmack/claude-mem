import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { WorkerService } from '../../src/services/worker-service.js';
import { logger } from '../../src/utils/logger.js';

afterEach(() => mock.restore());

function fixture() {
  // Exercise broadcastProcessingStatus without constructing providers, opening
  // a database, installing signal handlers, or starting an HTTP server.
  const worker = Object.create(WorkerService.prototype) as any;
  const status = { queueDepth: 3, activeSessions: 1 };
  const broadcast = mock((_event: unknown) => {});
  Object.assign(worker, {
    sessionManager: {
      getTotalQueueDepth: () => status.queueDepth,
      getTotalActiveWork: async () => status.queueDepth,
      getActiveSessionCount: () => status.activeSessions,
    },
    sseBroadcaster: { broadcast },
  });
  const info = spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});
  const broadcastProcessingStatus = async (): Promise<void> => {
    worker.broadcastProcessingStatus();
    // Let a deferred implementation finish before the assertions read it.
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { status, broadcast, info, broadcastProcessingStatus };
}

describe('WorkerService.broadcastProcessingStatus (#4087)', () => {
  it('sends one processing_status frame per queue-depth change, not one per claim or reset', async () => {
    const { status, broadcast, info, broadcastProcessingStatus } = fixture();

    // A batch cycling through claim and reset calls this on every buffer
    // mutation while the reported depth stays the same.
    for (let call = 0; call < 50; call++) await broadcastProcessingStatus();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'processing_status', isProcessing: true, queueDepth: 3 });

    // The frame carries no session count, so a session starting alone is not news.
    status.activeSessions = 2;
    await broadcastProcessingStatus();
    expect(broadcast).toHaveBeenCalledTimes(1);

    status.queueDepth = 0;
    await broadcastProcessingStatus();
    await broadcastProcessingStatus();
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'processing_status', isProcessing: false, queueDepth: 0 });

    status.queueDepth = 3;
    await broadcastProcessingStatus();
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'processing_status', isProcessing: true, queueDepth: 3 });

    const statusLinesAtInfo = info.mock.calls.filter(([, message]) => message === 'Broadcasting processing status');
    expect(statusLinesAtInfo).toHaveLength(0);
  });
});
