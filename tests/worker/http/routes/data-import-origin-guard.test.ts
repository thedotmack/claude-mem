import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

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

function captureImportHandler(routes: DataRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/import') {
        handler = handlers[handlers.length - 1];
      }
    }),
    delete: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

const emptyImport = { sessions: [], summaries: [], observations: [], prompts: [] };

describe('POST /api/import origin guard', () => {
  it('rejects an import from a different localhost origin before touching the store', () => {
    const getSessionStore = mock(() => {
      throw new Error('the import must not reach the store');
    });
    const routes = new DataRoutes(
      null as any,
      { getSessionStore } as any,
      null as any,
      null as any,
      null as any,
      0,
    );
    const handler = captureImportHandler(routes);

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: emptyImport,
      headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
    } as unknown as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('origin'),
    }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  it('allows an Origin-less import and a same-port browser import', () => {
    const store = {};
    const getSessionStore = mock(() => store);
    const routes = new DataRoutes(
      null as any,
      { getSessionStore, getChromaSync: mock(() => null) } as any,
      null as any,
      null as any,
      null as any,
      0,
    );
    const handler = captureImportHandler(routes);

    const originless = createMockRes();
    handler({ body: emptyImport, headers: {} } as unknown as Request, originless.res as Response);
    expect(getSessionStore).toHaveBeenCalledTimes(1);
    expect(originless.statusSpy).not.toHaveBeenCalled();
    expect(originless.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    const samePort = createMockRes();
    handler({
      body: emptyImport,
      headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
    } as unknown as Request, samePort.res as Response);
    expect(getSessionStore).toHaveBeenCalledTimes(2);
    expect(samePort.statusSpy).not.toHaveBeenCalled();
    expect(samePort.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
