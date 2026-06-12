import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { logger } from '../../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function captureGetHandler(mockApp: any, targetPath: string): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  mockApp.get = mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
    if (path === targetPath) handler = routeHandler;
  });

  return (req: Request, res: Response): void => {
    handler!(req, res);
  };
}

function createMockReqRes(query: Record<string, string>): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { query, path: '/api/sessions/status' } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function countSessions(store: SessionStore, contentSessionId: string): number {
  const row = store.db.prepare(`
    SELECT COUNT(*) as count FROM sdk_sessions WHERE content_session_id = ?
  `).get(contentSessionId) as { count: number };
  return row.count;
}

describe('SessionRoutes — GET /api/sessions/status', () => {
  let store: SessionStore;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    store.db.close();
    mock.restore();
  });

  function buildHandler(): (req: Request, res: Response) => void {
    const sessionManager = {
      getSession: mock(() => undefined),
      getMessageBuffer: mock(() => ({
        getPendingCount: mock(() => 0),
      })),
    };
    const dbManager = {
      getSessionStore: () => store,
    };
    const routes = new SessionRoutes(
      sessionManager as any,
      dbManager as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const mockApp: any = {
      post: mock(() => {}),
      get: mock(() => {}),
    };
    const handler = captureGetHandler(mockApp, '/api/sessions/status');
    routes.setupRoutes(mockApp as any);
    return handler;
  }

  it('does not create a default claude session row for an unknown contentSessionId', () => {
    const contentSessionId = 'status-before-codex-init';
    const handler = buildHandler();
    const { req, res, jsonSpy } = createMockReqRes({ contentSessionId });

    handler(req as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledWith({ status: 'not_found', queueLength: 0 });
    expect(countSessions(store, contentSessionId)).toBe(0);

    const sessionDbId = store.createSDKSession(contentSessionId, 'project', 'prompt', undefined, 'codex');
    const session = store.getSessionById(sessionDbId);
    expect(session?.platform_source).toBe('codex');
  });
});
