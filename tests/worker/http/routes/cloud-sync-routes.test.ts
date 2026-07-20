
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

async function invoke(
  handler: (req: Request, res: Response) => void,
  req: Partial<Request>,
  res: Partial<Response>,
  jsonSpy: ReturnType<typeof mock>,
): Promise<void> {
  handler(req as Request, res as Response);
  for (let index = 0; index < 100 && jsonSpy.mock.calls.length === 0; index++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
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

  it('performs the authenticated Hub probe even when pending counts are zero', async () => {
    const status: CloudSyncStatus = {
      configured: true,
      deviceId: 'device-fixture',
      pending: { observations: 0, summaries: 0, prompts: 0, mutations: 0, tombstones: 0 },
      quarantine: { count: 0, latestReason: null },
      lastFlushAt: 1751990400000,
      lastError: null,
      hub: {
        checkedAt: 1751990400100,
        reachable: true,
        epoch: '10',
        headSeq: '20',
        projectedSeq: '20',
        error: null,
      },
    };
    const probe = mock(async () => status);
    const mockDbManager = {
      getCloudSync: () => ({ statusWithHubProbe: probe }),
    };
    const handler = buildHandler(new CloudSyncRoutes(mockDbManager as any));

    const { req, res, jsonSpy, statusSpy } = createMockReqRes();
    await invoke(handler, req, res, jsonSpy);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith(status);
    expect(statusSpy).not.toHaveBeenCalled(); // implicit 200
  });

  it('returns {configured: false} with 200 (not 500) when no service exists', async () => {
    const mockDbManager = {
      getCloudSync: () => null,
    };
    const handler = buildHandler(new CloudSyncRoutes(mockDbManager as any));

    const { req, res, jsonSpy, statusSpy } = createMockReqRes();
    await invoke(handler, req, res, jsonSpy);

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith({ configured: false });
    expect(statusSpy).not.toHaveBeenCalled(); // no error status set
  });

  it('surfaces Hub probe failure and never leaks the sync token', async () => {
    const mockDbManager = {
      getCloudSync: () => ({
        statusWithHubProbe: async () => ({
          configured: true,
          deviceId: 'device-fixture',
          pending: { observations: 0, summaries: 0, prompts: 0, mutations: 0, tombstones: 0 },
          quarantine: { count: 0, latestReason: null },
          lastFlushAt: null,
          lastError: null,
          hub: {
            checkedAt: 1751990400100,
            reachable: false,
            epoch: null,
            headSeq: null,
            projectedSeq: null,
            error: 'sync hub status 401: denied',
          },
        }),
      }),
    };
    const handler = buildHandler(new CloudSyncRoutes(mockDbManager as any));

    const { req, res, jsonSpy } = createMockReqRes();
    await invoke(handler, req, res, jsonSpy);

    const payload = (jsonSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(payload.hub).toMatchObject({ reachable: false, error: 'sync hub status 401: denied' });
    const keys = Object.keys(payload).map(k => k.toLowerCase());
    expect(keys.some(k => k.includes('token'))).toBe(false);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('token');
  });
});
