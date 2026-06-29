import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

type Method = 'get' | 'post';

function captureRoute(routes: DataRoutes, method: Method, targetPath: string): (req: Request, res: Response) => void {
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
    get: method === 'get' ? register : mock(() => {}),
    post: method === 'post' ? register : mock(() => {}),
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

function insertPrompt(
  store: SessionStore,
  sessionDbId: number,
  contentSessionId: string,
  promptText: string,
  createdAtEpoch: number
): number {
  const result = store.db.prepare(`
    INSERT INTO user_prompts
    (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionDbId, contentSessionId, 1, promptText, new Date(createdAtEpoch).toISOString(), createdAtEpoch);
  return Number(result.lastInsertRowid);
}

describe('DataRoutes platform-scoped hydration', () => {
  let store: SessionStore;
  let routes: DataRoutes;
  const project = 'data-route-platform-scope';
  const contentSessionId = 'shared-data-route-raw-id';
  const filePath = 'src/shared-platform-file.ts';

  beforeEach(() => {
    store = new SessionStore(':memory:');
    routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now(),
    );
  });

  afterEach(() => {
    store.close();
  });

  function seedPlatformRows(): {
    claudeObservationId: number;
    cursorObservationId: number;
    claudeSummaryId: number;
    claudePromptId: number;
  } {
    const baseEpoch = Date.UTC(2024, 2, 1, 0, 0, 0);
    const claudeSessionDbId = store.createSDKSession(contentSessionId, project, 'claude prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(claudeSessionDbId, 'claude-data-route-memory');
    const cursorSessionDbId = store.createSDKSession(contentSessionId, project, 'cursor prompt', undefined, 'cursor');
    store.ensureMemorySessionIdRegistered(cursorSessionDbId, 'cursor-data-route-memory');

    const claudeObservation = store.storeObservation(
      'claude-data-route-memory',
      project,
      {
        type: 'discovery',
        title: 'CLAUDE_ROUTE_OBS',
        subtitle: null,
        facts: [],
        narrative: 'claude route observation',
        concepts: [],
        files_read: [filePath],
        files_modified: [],
      },
      1,
      0,
      baseEpoch
    );
    const cursorObservation = store.storeObservation(
      'cursor-data-route-memory',
      project,
      {
        type: 'discovery',
        title: 'CURSOR_ROUTE_OBS',
        subtitle: null,
        facts: [],
        narrative: 'cursor route observation',
        concepts: [],
        files_read: [filePath],
        files_modified: [],
      },
      1,
      0,
      baseEpoch + 1_000
    );
    const claudeSummary = store.storeSummary(
      'claude-data-route-memory',
      project,
      {
        request: 'CLAUDE_ROUTE_SUMMARY',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
      baseEpoch
    );
    store.storeSummary(
      'cursor-data-route-memory',
      project,
      {
        request: 'CURSOR_ROUTE_SUMMARY',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
      baseEpoch + 1_000
    );
    const claudePromptId = insertPrompt(store, claudeSessionDbId, contentSessionId, 'CLAUDE_ROUTE_PROMPT', baseEpoch);
    insertPrompt(store, cursorSessionDbId, contentSessionId, 'CURSOR_ROUTE_PROMPT', baseEpoch + 1_000);

    return {
      claudeObservationId: claudeObservation.id,
      cursorObservationId: cursorObservation.id,
      claudeSummaryId: claudeSummary.id,
      claudePromptId,
    };
  }

  it('scopes batch observations, summaries, prompts, and by-file results by platform', () => {
    const ids = seedPlatformRows();

    const batchHandler = captureRoute(routes, 'post', '/api/observations/batch');
    const batchResponse = makeResponse();
    batchHandler(makeRequest({
      body: {
        ids: [ids.claudeObservationId, ids.cursorObservationId],
        platform_source: 'cursor',
      },
    }), batchResponse.res);
    expect(batchResponse.json).toHaveBeenCalledWith([
      expect.objectContaining({ id: ids.cursorObservationId, title: 'CURSOR_ROUTE_OBS' }),
    ]);

    const sessionHandler = captureRoute(routes, 'get', '/api/session/:id');
    const sessionResponse = makeResponse();
    sessionHandler(makeRequest({
      params: { id: String(ids.claudeSummaryId) },
      query: { platformSource: 'cursor' },
    }), sessionResponse.res);
    expect(sessionResponse.status).toHaveBeenCalledWith(404);

    const promptHandler = captureRoute(routes, 'get', '/api/prompt/:id');
    const promptResponse = makeResponse();
    promptHandler(makeRequest({
      params: { id: String(ids.claudePromptId) },
      query: { platform_source: 'cursor' },
    }), promptResponse.res);
    expect(promptResponse.status).toHaveBeenCalledWith(404);

    const byFileHandler = captureRoute(routes, 'get', '/api/observations/by-file');
    const byFileResponse = makeResponse();
    byFileHandler(makeRequest({
      query: { path: filePath, projects: project },
      headers: { 'x-platform-source': 'cursor' },
    }), byFileResponse.res);
    expect(byFileResponse.json).toHaveBeenCalledWith({
      observations: [
        expect.objectContaining({ id: ids.cursorObservationId, title: 'CURSOR_ROUTE_OBS' }),
      ],
      count: 1,
    });
  });

  it('scopes single observation lookup by requested platform', () => {
    const ids = seedPlatformRows();
    const handler = captureRoute(routes, 'get', '/api/observation/:id');

    const mismatchResponse = makeResponse();
    handler(makeRequest({
      params: { id: String(ids.claudeObservationId) },
      query: { platformSource: 'cursor' },
    }), mismatchResponse.res);
    expect(mismatchResponse.status).toHaveBeenCalledWith(404);

    const matchResponse = makeResponse();
    handler(makeRequest({
      params: { id: String(ids.cursorObservationId) },
      headers: { 'x-claude-mem-platform-source': 'cursor' },
    }), matchResponse.res);
    expect(matchResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: ids.cursorObservationId, title: 'CURSOR_ROUTE_OBS' })
    );
  });
});
