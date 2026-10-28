// POST /api/memory/ingest writes observations and nudges Chroma — the same
// class of write as /api/memory/save, so it gets the same origin guard: a
// browser page on another localhost port must not be able to trigger a full
// project-tree ingestion, while Origin-less clients (the npx CLI, curl) keep
// the loopback-trust model.
import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { MemoryIngestRoutes } from '../../../../src/services/worker/http/routes/MemoryIngestRoutes.js';

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

function captureIngestHandler(routes: MemoryIngestRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/memory/ingest') {
        handler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

function stubDbManager() {
  const getSessionStore = mock(() => {
    throw new Error('the ingest must not reach the store');
  });
  return {
    dbManager: {
      getSessionStore,
      getCloudSync: () => null,
      getChromaSync: () => null,
    } as any,
    getSessionStore,
  };
}

describe('POST /api/memory/ingest origin guard', () => {
  it('rejects an ingest from a different localhost origin before touching the store', () => {
    const { dbManager, getSessionStore } = stubDbManager();
    const routes = new MemoryIngestRoutes(dbManager);
    const handler = captureIngestHandler(routes);

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: { source: '/any/tree' },
      headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
    } as unknown as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('origin'),
    }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  it('lets an Origin-less ingest past the guard (it fails later on its own validation)', () => {
    const { dbManager, getSessionStore } = stubDbManager();
    const routes = new MemoryIngestRoutes(dbManager);
    const handler = captureIngestHandler(routes);

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: {},
      headers: {},
    } as unknown as Request, res as Response);

    // The guard passed: the handler answered with its own 400
    // ("source is required"), not the guard's 403.
    expect(statusSpy).not.toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('source'),
    }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  it('lets a same-port browser ingest past the guard', () => {
    const { dbManager, getSessionStore } = stubDbManager();
    const routes = new MemoryIngestRoutes(dbManager);
    const handler = captureIngestHandler(routes);

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: {},
      headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
    } as unknown as Request, res as Response);

    expect(statusSpy).not.toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('source'),
    }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });
});