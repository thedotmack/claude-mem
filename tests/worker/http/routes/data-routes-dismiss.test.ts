// Write-gate for the reversible dismiss endpoints. The dismiss/undismiss WRITE
// is gated behind CLAUDE_MEM_ALLOW_DISMISS (default off) and returns a clear 403
// when disabled without ever touching the store. When enabled it verifies the
// observation exists (404 otherwise) and calls the store write. The read-side
// filter is unconditional and is covered by tests/services/sqlite/observation-dismiss.test.ts.

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(params: Record<string, string>, body: any = {}): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { params, body, path: '/test', query: {}, get: () => undefined } as unknown as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureVerb(mockApp: any, verb: 'post' | 'delete', targetPath: string): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  mockApp[verb] = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    handler = rest[rest.length - 1];
  });
  return (req: Request, res: Response): void => handler!(req, res);
}

describe('DataRoutes — dismiss write gate (CLAUDE_MEM_ALLOW_DISMISS)', () => {
  let routes: DataRoutes;
  let mockGetObservationById: ReturnType<typeof mock>;
  let mockDismiss: ReturnType<typeof mock>;
  let mockUndismiss: ReturnType<typeof mock>;
  let prevSetting: string | undefined;

  beforeEach(() => {
    prevSetting = process.env.CLAUDE_MEM_ALLOW_DISMISS;

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

    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: mockGetObservationById,
        dismissObservation: mockDismiss,
        undismissObservation: mockUndismiss,
      }),
    };

    routes = new DataRoutes(
      {} as any, // paginationHelper
      mockDbManager as any,
      {} as any, // sessionManager
      {} as any, // sseBroadcaster
      {} as any, // workerService
      Date.now(),
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
    if (prevSetting === undefined) {
      delete process.env.CLAUDE_MEM_ALLOW_DISMISS;
    } else {
      process.env.CLAUDE_MEM_ALLOW_DISMISS = prevSetting;
    }
  });

  function dismissHandler(): (req: Request, res: Response) => void {
    const mockApp: any = { get: mock(() => {}), post: mock(() => {}), delete: mock(() => {}), use: mock(() => {}) };
    const handler = captureVerb(mockApp, 'post', '/api/observations/:id/dismiss');
    routes.setupRoutes(mockApp as any);
    return handler;
  }

  function undismissHandler(): (req: Request, res: Response) => void {
    const mockApp: any = { get: mock(() => {}), post: mock(() => {}), delete: mock(() => {}), use: mock(() => {}) };
    const handler = captureVerb(mockApp, 'delete', '/api/observations/:id/dismiss');
    routes.setupRoutes(mockApp as any);
    return handler;
  }

  it('registers POST and DELETE dismiss routes', () => {
    const postPaths: string[] = [];
    const deletePaths: string[] = [];
    const mockApp: any = {
      get: mock(() => {}),
      use: mock(() => {}),
      post: mock((path: string) => { postPaths.push(path); }),
      delete: mock((path: string) => { deletePaths.push(path); }),
    };
    routes.setupRoutes(mockApp as any);
    expect(postPaths).toContain('/api/observations/:id/dismiss');
    expect(deletePaths).toContain('/api/observations/:id/dismiss');
  });

  it('POST dismiss is a no-op returning 403 when the setting is off', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'false';
    const handler = dismissHandler();
    const { req, res, statusSpy } = createMockReqRes({ id: '7' }, { reason: 'noise' });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockGetObservationById).not.toHaveBeenCalled();
  });

  it('POST dismiss writes (with reason) when the setting is on', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    const handler = dismissHandler();
    const { req, res, jsonSpy } = createMockReqRes({ id: '7' }, { reason: 'noise' });
    handler(req as Request, res as Response);

    expect(mockDismiss).toHaveBeenCalledWith(7, 'noise');
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 7, dismissed: true }));
  });

  it('POST dismiss returns 404 for a missing observation when enabled', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    mockGetObservationById = mock(() => null);
    const handler = dismissHandler();
    const { req, res, statusSpy } = createMockReqRes({ id: '7' });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('DELETE undismiss is a no-op returning 403 when the setting is off', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'false';
    const handler = undismissHandler();
    const { req, res, statusSpy } = createMockReqRes({ id: '7' });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(mockUndismiss).not.toHaveBeenCalled();
  });

  it('DELETE undismiss writes when the setting is on', () => {
    process.env.CLAUDE_MEM_ALLOW_DISMISS = 'true';
    const handler = undismissHandler();
    const { req, res, jsonSpy } = createMockReqRes({ id: '7' });
    handler(req as Request, res as Response);

    expect(mockUndismiss).toHaveBeenCalledWith(7);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, id: 7, dismissed: false }));
  });
});
