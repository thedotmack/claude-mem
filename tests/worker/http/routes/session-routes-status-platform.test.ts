import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { setIngestContext } from '../../../../src/services/worker/http/shared.js';

type Method = 'get' | 'post';

function captureRoute(routes: SessionRoutes, method: Method, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const register = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  const app = {
    post: method === 'post' ? register : mock(() => {}),
    get: method === 'get' ? register : mock(() => {}),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error(`Handler not registered for ${method.toUpperCase()} ${targetPath}`);

  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler!(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

function makeResponse(): { res: Response; json: ReturnType<typeof mock>; status: ReturnType<typeof mock> } {
  const json = mock(() => {});
  const res = {
    headersSent: false,
    json,
    status: mock((code: number) => {
      (res as any).statusCode = code;
      return res;
    }),
  } as any;
  return { res: res as Response, json, status: res.status };
}

function makeRequest(input: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}): Request {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    path: '/test',
    body: input.body ?? {},
    query: input.query ?? {},
    params: input.params ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function platformSourcesFor(store: SessionStore, contentSessionId: string): string[] {
  const rows = store.db.prepare(`
    SELECT platform_source
    FROM sdk_sessions
    WHERE content_session_id = ?
    ORDER BY platform_source
  `).all(contentSessionId) as Array<{ platform_source: string }>;
  return rows.map(row => row.platform_source);
}

function buildRoutes(store: SessionStore, overrides: Record<string, unknown> = {}) {
  const queueObservation = mock(() => Promise.resolve());
  const queueSummarize = mock(() => Promise.resolve());
  const initializeSession = mock(() => undefined);
  const getSession = mock(() => undefined);
  const getPendingCount = mock(() => 0);
  const ensureGeneratorRunning = mock(() => Promise.resolve());
  const sessionManager = {
    queueObservation,
    queueSummarize,
    initializeSession,
    getSession,
    getMessageBuffer: () => ({ getPendingCount }),
    ...overrides,
  } as any;
  const dbManager = {
    getSessionStore: () => store,
    getChromaSync: () => null,
  } as any;
  const eventBroadcaster = {
    broadcastObservationQueued: mock(() => {}),
    broadcastSummarizeQueued: mock(() => {}),
    broadcastNewPrompt: mock(() => {}),
    broadcastSessionStarted: mock(() => {}),
  } as any;

  setIngestContext({
    sessionManager,
    dbManager,
    eventBroadcaster,
    ensureGeneratorRunning,
  });

  const routes = new SessionRoutes(
    sessionManager,
    dbManager,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    eventBroadcaster,
    {} as any,
    {} as any,
  );

  return { routes, queueObservation, queueSummarize, initializeSession, getSession, getPendingCount };
}

describe('SessionRoutes status platform scoping', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('uses platformSource instead of defaulting to Claude for overlapping raw ids', () => {
    const contentSessionId = 'shared-status-raw-id';
    store.createSDKSession(contentSessionId, 'claude-project', 'prompt', undefined, 'claude');

    const { routes, getSession } = buildRoutes(store);
    const handler = captureRoute(routes, 'get', '/api/sessions/status');
    const response = makeResponse();

    handler(makeRequest({
      query: { contentSessionId, platformSource: 'cursor' },
    }), response.res);

    const rows = store.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY platform_source
    `).all(contentSessionId) as Array<{ id: number; platform_source: string }>;
    const cursorRow = rows.find(row => row.platform_source === 'cursor');

    expect(rows.map(row => row.platform_source)).toEqual(['claude', 'cursor']);
    expect(cursorRow).toBeDefined();
    expect(getSession).toHaveBeenCalledWith(cursorRow!.id);
    expect(response.json).toHaveBeenCalledWith({ status: 'not_found', queueLength: 0 });
  });

  it('uses body platform_source for observation ingestion', async () => {
    const contentSessionId = 'shared-observation-raw-id';
    store.createSDKSession(contentSessionId, 'claude-project', 'prompt', undefined, 'claude');
    const { routes, queueObservation } = buildRoutes(store);
    const handler = captureRoute(routes, 'post', '/api/sessions/observations');
    const response = makeResponse();

    handler(makeRequest({
      body: {
        contentSessionId,
        tool_name: 'Bash',
        tool_input: { command: 'true' },
        tool_response: { output: 'ok' },
        platform_source: 'cursor',
      },
    }), response.res);
    await flushAsyncHandlers();

    expect(platformSourcesFor(store, contentSessionId)).toEqual(['claude', 'cursor']);
    const cursorRow = store.db.prepare(`
      SELECT id FROM sdk_sessions
      WHERE content_session_id = ? AND platform_source = 'cursor'
    `).get(contentSessionId) as { id: number } | undefined;
    expect(cursorRow).toBeDefined();
    expect(queueObservation).toHaveBeenCalledWith(
      cursorRow!.id,
      expect.objectContaining({ tool_name: 'Bash' })
    );
    expect(response.json).toHaveBeenCalledWith({ status: 'queued' });
  });

  it('uses query platform_source for summarize', async () => {
    const contentSessionId = 'shared-summarize-raw-id';
    store.createSDKSession(contentSessionId, 'claude-project', 'prompt', undefined, 'claude');
    const { routes, queueSummarize } = buildRoutes(store);
    const handler = captureRoute(routes, 'post', '/api/sessions/summarize');
    const response = makeResponse();

    handler(makeRequest({
      query: { platform_source: 'cursor' },
      body: {
        contentSessionId,
        last_assistant_message: 'assistant text',
      },
    }), response.res);
    await flushAsyncHandlers();

    expect(platformSourcesFor(store, contentSessionId)).toEqual(['claude', 'cursor']);
    const cursorRow = store.db.prepare(`
      SELECT id FROM sdk_sessions
      WHERE content_session_id = ? AND platform_source = 'cursor'
    `).get(contentSessionId) as { id: number } | undefined;
    expect(cursorRow).toBeDefined();
    expect(queueSummarize).toHaveBeenCalledWith(cursorRow!.id, 'assistant text');
    expect(response.json).toHaveBeenCalledWith({ status: 'queued' });
  });

  it('uses platform headers for session init', async () => {
    const contentSessionId = 'shared-init-raw-id';
    store.createSDKSession(contentSessionId, 'claude-project', 'prompt', undefined, 'claude');
    const { routes, initializeSession } = buildRoutes(store);
    const handler = captureRoute(routes, 'post', '/api/sessions/init');
    const response = makeResponse();

    handler(makeRequest({
      headers: { 'x-platform-source': 'cursor' },
      body: {
        contentSessionId,
        project: 'cursor-project',
        prompt: 'cursor prompt',
      },
    }), response.res);
    await flushAsyncHandlers();

    expect(platformSourcesFor(store, contentSessionId)).toEqual(['claude', 'cursor']);
    expect(initializeSession).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      skipped: false,
      status: 'initialized',
    }));
  });
});
