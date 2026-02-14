import { describe, expect, it, mock } from 'bun:test';
import { ViewerRoutes } from '../../src/services/worker/http/routes/ViewerRoutes.js';

describe('ViewerRoutes SSE stream', () => {
  it('sends initial events only to the newly connected client', () => {
    const addClient = mock(() => {});
    const sendToClient = mock(() => {});
    const broadcast = mock(() => {});

    const sseBroadcaster = {
      addClient,
      sendToClient,
      broadcast,
    } as any;

    const dbManager = {
      getSessionStore: () => ({
        getAllProjects: () => ['openclaw', 'openclaw-main'],
      }),
    } as any;

    const sessionManager = {
      isAnySessionProcessing: () => true,
      getTotalActiveWork: () => 3,
    } as any;

    const routes = new ViewerRoutes(sseBroadcaster, dbManager, sessionManager);

    const req = { path: '/stream' } as any;
    const setHeader = mock(() => {});
    const flushHeaders = mock(() => {});
    const res = {
      headersSent: false,
      setHeader,
      flushHeaders,
    } as any;

    (routes as any).handleSSEStream(req, res);

    expect(addClient).toHaveBeenCalledTimes(1);
    expect(addClient).toHaveBeenCalledWith(res);
    expect(sendToClient).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledTimes(0);
    expect(setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(flushHeaders).toHaveBeenCalledTimes(1);

    const firstEvent = sendToClient.mock.calls[0]?.[1];
    const secondEvent = sendToClient.mock.calls[1]?.[1];
    expect(firstEvent.type).toBe('initial_load');
    expect(firstEvent.projects).toEqual(['openclaw', 'openclaw-main']);
    expect(secondEvent.type).toBe('processing_status');
    expect(secondEvent.isProcessing).toBe(true);
    expect(secondEvent.queueDepth).toBe(3);
  });
});
