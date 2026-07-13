
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { CloudSyncRoutes } from '../../../../src/services/worker/http/routes/CloudSyncRoutes.js';
import type { CloudSyncStatus } from '../../../../src/services/sync/CloudSync.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(): { req: Partial<Request>; res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { path: '/api/sync/status', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function buildHandler(routes: CloudSyncRoutes): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock((path: string, h: (req: Request, res: Response) => void) => {
      if (path === '/api/sync/status') handler = h;
    }),
    post: mock(() => {}),
    delete: mock(() => {}),
    use: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  expect(handler).toBeDefined();
  return handler!;
}

describe('CloudSyncRoutes — GET /api/sync/status', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('returns the service status with pending counts when cloud sync is configured', () => {
    const status: CloudSyncStatus = {
      configured: true,
      deviceId: 'device-fixture',
      pending: { observations: 3, summaries: 2, prompts: 1 },
      lastFlushAt: 1751990400000,
      lastError: null,
    };
    const mockDbManager = {
      getCloudSync: () => ({ status: () => status }),
    };
    const handler = buildHandler(new CloudSyncRoutes(mockDbManager as any));

    const { req, res, jsonSpy, statusSpy } = createMockReqRes();
    handler(req as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith(status);
    expect(statusSpy).not.toHaveBeenCalled(); // implicit 200
  });

  it('returns {configured: false} with 200 (not 500) when no service exists', () => {
    const mockDbManager = {
      getCloudSync: () => null,
    };
    const handler = buildHandler(new CloudSyncRoutes(mockDbManager as any));

    const { req, res, jsonSpy, statusSpy } = createMockReqRes();
    handler(req as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith({ configured: false });
    expect(statusSpy).not.toHaveBeenCalled(); // no error status set
  });

  it('never leaks the sync token in the response payload', () => {
    const mockDbManager = {
      getCloudSync: () => ({
        status: () => ({
          configured: true,
          deviceId: 'device-fixture',
          pending: { observations: 0, summaries: 0, prompts: 0 },
          lastFlushAt: null,
          lastError: null,
        }),
      }),
    };
    const handler = buildHandler(new CloudSyncRoutes(mockDbManager as any));

    const { req, res, jsonSpy } = createMockReqRes();
    handler(req as Request, res as Response);

    const payload = (jsonSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const keys = Object.keys(payload).map(k => k.toLowerCase());
    expect(keys.some(k => k.includes('token'))).toBe(false);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('token');
  });
});
