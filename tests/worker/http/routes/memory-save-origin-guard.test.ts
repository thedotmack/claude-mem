import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';

function createMockRes(): {
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureMemorySaveHandler(routes: MemoryRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/memory/save') {
        handler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

function stubDbManager() {
  const getSessionStore = mock(() => ({
    getOrCreateManualSession: () => 42,
    storeObservation: () => ({ id: 7, mergedIntoExisting: false, createdAtEpoch: 123 }),
  }));
  return {
    dbManager: {
      getSessionStore,
      getCloudSync: () => null,
      getChromaSync: () => null,
    } as any,
    getSessionStore,
  };
}

describe('POST /api/memory/save origin guard', () => {
  it('rejects a save from a different localhost origin before touching the store', () => {
    const { dbManager, getSessionStore } = stubDbManager();
    getSessionStore.mockImplementation(() => {
      throw new Error('the save must not reach the store');
    });
    const routes = new MemoryRoutes(dbManager, 'default-project');
    const handler = captureMemorySaveHandler(routes);

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: { text: 'a note a page should not be able to plant' },
      headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
    } as unknown as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('origin'),
    }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  it('allows an Origin-less save and a same-port browser save', () => {
    const { dbManager, getSessionStore } = stubDbManager();
    const routes = new MemoryRoutes(dbManager, 'default-project');
    const handler = captureMemorySaveHandler(routes);

    const originless = createMockRes();
    handler({
      body: { text: 'remember the deploy checklist' },
      headers: {},
    } as unknown as Request, originless.res as Response);
    expect(getSessionStore).toHaveBeenCalledTimes(1);
    expect(originless.statusSpy).not.toHaveBeenCalled();
    expect(originless.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 7 }));

    const samePort = createMockRes();
    handler({
      body: { text: 'remember the rollback steps' },
      headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
    } as unknown as Request, samePort.res as Response);
    expect(getSessionStore).toHaveBeenCalledTimes(2);
    expect(samePort.statusSpy).not.toHaveBeenCalled();
    expect(samePort.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 7 }));
  });
});
