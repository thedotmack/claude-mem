import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(params: Record<string, string>, body: any = {}): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const res = {
    headersSent: false,
    json: jsonSpy,
    status: mock(() => res),
  } as any;
  return {
    req: { params, body, path: '/test', query: {}, get: () => undefined } as unknown as Partial<Request>,
    res: res as Partial<Response>,
    jsonSpy,
    statusSpy: res.status,
  };
}

function captureVerb(mockApp: any, verb: 'post' | 'delete', targetPath: string): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  mockApp[verb] = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    handler = rest[rest.length - 1];
  });
  return (req: Request, res: Response): void => {
    if (!handler) throw new Error(`Handler not registered for ${verb.toUpperCase()} ${targetPath}`);
    handler(req, res);
  };
}

describe('DataRoutes observation dismiss gate', () => {
  let routes: DataRoutes;
  let mockGetObservationById: ReturnType<typeof mock>;
  let mockDismiss: ReturnType<typeof mock>;
  let mockUndismiss: ReturnType<typeof mock>;
  let previousSetting: string | undefined;

  beforeEach(() => {
    previousSetting = process.env.CLAUDE_MEM_ALLOW_DISMISS;
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockGetObservationById = mock(() => ({ id: 7 }));
    mockDismiss = mock(() => {});
    mockUndismiss = mock(() => {});

    routes = new DataRoutes(
      {} as any,
      {
        getSessionStore: () => ({
          getObservationById: mockGetObservationById,
          dismissObservation: mockDismiss,
          undismissObservation: mockUndismiss,
        }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    if (previousSetting === undefined) {
      delete process.env.CLAUDE_MEM_ALLOW_DISMISS;
    } else {
      process.env.CLAUDE_MEM_ALLOW_DISMISS = previousSetting;
    }
  });

  function makeApp(): any {
    return { get: mock(() => {}), post: mock(() => {}), delete: mock(() => {}) };
  }

  function dismissHandler(): (req: Request, res: Response) => void {
    const app = makeApp();
    const handler = captureVerb(app, 'post', '/api/observations/:id/dismiss');
    routes.setupRoutes(app as any);
    return handler;
  }

  function undismissHandler(): (req: Request, res: Response) => void {
    const app = makeApp();
    const handler = captureVerb(app, 'delete', '/api/observations/:id/dismiss');
    routes.setupRoutes(app as any);
    return handler;
  }

  it('registers POST and DELETE dismiss routes', () => {
    const postPaths: string[] = [];
    const deletePaths: string[] = [];
    const app = {
      get: mock(() => {}),
      post: mock((path: string) => { postPaths.push(path); }),
      delete: mock((path: string) => { deletePaths.push(path); }),
    };

    routes.setupRoutes(app as any);

    expect(postPaths).toContain('/api/observations/:id/dismiss');
    expect(deletePaths).toContain('/api/observations/:id/dismiss');
  });

  it('POST returns 403 and does not read or write when disabled', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'false';
    const { req, res, statusSpy } = createMockReqRes({ id: '7' }, { reason: 'noise' });

    dismissHandler()(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(mockGetObservationById).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('POST writes a dismiss with reason when enabled', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    const { req, res, jsonSpy } = createMockReqRes({ id: '7' }, { reason: 'noise' });

    dismissHandler()(req as Request, res as Response);

    expect(mockDismiss).toHaveBeenCalledWith(7, 'noise');
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 7, dismissed: true }));
  });

  it('POST returns 404 for a missing observation when enabled', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    mockGetObservationById = mock(() => null);
    const { req, res, statusSpy } = createMockReqRes({ id: '7' });

    dismissHandler()(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('DELETE returns 403 and does not read or write when disabled', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'false';
    const { req, res, statusSpy } = createMockReqRes({ id: '7' });

    undismissHandler()(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(mockGetObservationById).not.toHaveBeenCalled();
    expect(mockUndismiss).not.toHaveBeenCalled();
  });

  it('DELETE writes an undismiss when enabled', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    const { req, res, jsonSpy } = createMockReqRes({ id: '7' });

    undismissHandler()(req as Request, res as Response);

    expect(mockUndismiss).toHaveBeenCalledWith(7);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 7, dismissed: false }));
  });

  it('DELETE returns 404 without writing when observation lookup is scoped out', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    mockGetObservationById = mock(() => null);
    const { req, res, statusSpy } = createMockReqRes({ id: '7' });

    undismissHandler()(req as Request, res as Response);

    expect(mockGetObservationById).toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(mockUndismiss).not.toHaveBeenCalled();
  });
});
