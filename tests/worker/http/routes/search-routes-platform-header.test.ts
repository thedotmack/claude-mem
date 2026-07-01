import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';

type Handler = (req: Request, res: Response) => void;

function captureGetHandlers(routes: SearchRoutes): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const app = {
    use: mock(() => {}),
    get: mock((path: string, handler: Handler) => {
      handlers.set(path, handler);
    }),
    post: mock(() => {}),
  };

  routes.setupRoutes(app as any);
  return handlers;
}

function makeResponse(): { res: Response; json: ReturnType<typeof mock>; status: ReturnType<typeof mock> } {
  const json = mock(() => {});
  const res = {
    headersSent: false,
    locals: {},
    json,
    status: mock((code: number) => {
      (res as any).statusCode = code;
      return res;
    }),
  } as any;
  return { res: res as Response, json, status: res.status };
}

function makeRequest(input: {
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Request {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    path: input.path,
    query: input.query ?? {},
    body: {},
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function callHandler(handlers: Map<string, Handler>, path: string, req: Request, res: Response): void {
  const handler = handlers.get(path);
  if (!handler) throw new Error(`Handler not registered for ${path}`);
  handler(req, res);
}

describe('SearchRoutes platform-source headers', () => {
  it('forwards x-platform-source into representative search and timeline route options', async () => {
    const search = mock(async () => ({ route: 'search' }));
    const timeline = mock(async () => ({ route: 'timeline' }));
    const searchObservations = mock(async () => ({ route: 'observations' }));
    const searchSessions = mock(async () => ({ route: 'sessions' }));
    const searchUserPrompts = mock(async () => ({ route: 'prompts' }));
    const decisions = mock(async () => ({ route: 'decisions' }));
    const changes = mock(async () => ({ route: 'changes' }));
    const howItWorks = mock(async () => ({ route: 'how-it-works' }));
    const getRecentContext = mock(async () => ({ route: 'recent-context' }));
    const getContextTimeline = mock(async () => ({ route: 'context-timeline' }));
    const getTimelineByQuery = mock(async () => ({ route: 'timeline-by-query' }));
    const findByConcept = mock(async () => ({ results: { observations: [], sessions: [], prompts: [] } }));
    const findByFile = mock(async () => ({ observations: [], sessions: [], usedChroma: false }));
    const findByType = mock(async () => ({ results: { observations: [], sessions: [], prompts: [] } }));

    const routes = new SearchRoutes({
      search,
      timeline,
      searchObservations,
      searchSessions,
      searchUserPrompts,
      decisions,
      changes,
      howItWorks,
      getRecentContext,
      getContextTimeline,
      getTimelineByQuery,
      getOrchestrator: () => ({ findByConcept, findByFile, findByType }),
      getFormatter: () => ({}),
    } as any);
    const handlers = captureGetHandlers(routes);

    const directRoutes: Array<[string, ReturnType<typeof mock>, Record<string, unknown>]> = [
      ['/api/search', search, { query: 'needle' }],
      ['/api/timeline', timeline, { query: 'needle' }],
      ['/api/search/observations', searchObservations, { query: 'needle' }],
      ['/api/search/sessions', searchSessions, { query: 'needle' }],
      ['/api/search/prompts', searchUserPrompts, { query: 'needle' }],
      ['/api/decisions', decisions, { project: 'worktree' }],
      ['/api/changes', changes, { project: 'worktree' }],
      ['/api/how-it-works', howItWorks, { project: 'worktree' }],
      ['/api/context/recent', getRecentContext, { project: 'worktree', limit: '3' }],
      ['/api/context/timeline', getContextTimeline, { anchor: '42' }],
      ['/api/timeline/by-query', getTimelineByQuery, { query: 'needle' }],
    ];

    for (const [path, targetMock, query] of directRoutes) {
      const response = makeResponse();
      callHandler(handlers, path, makeRequest({
        path,
        query,
        headers: { 'x-platform-source': 'Cursor' },
      }), response.res);
      await flushAsyncHandlers();

      expect(targetMock).toHaveBeenCalledWith(
        expect.objectContaining({ ...query, platformSource: 'cursor' }),
        ...(path === '/api/search' ? [expect.any(Object)] : [])
      );
    }

    const byFileResponse = makeResponse();
    callHandler(handlers, '/api/search/by-file', makeRequest({
      path: '/api/search/by-file',
      query: { filePath: 'src/search.ts' },
      headers: { 'x-platform-source': 'Cursor' },
    }), byFileResponse.res);
    await flushAsyncHandlers();

    expect(findByFile).toHaveBeenCalledWith(
      'src/search.ts',
      expect.objectContaining({ filePath: 'src/search.ts', platformSource: 'cursor' })
    );

    const byConceptResponse = makeResponse();
    callHandler(handlers, '/api/search/by-concept', makeRequest({
      path: '/api/search/by-concept',
      query: { concept: 'auth' },
      headers: { 'x-platform-source': 'Cursor' },
    }), byConceptResponse.res);
    await flushAsyncHandlers();

    expect(findByConcept).toHaveBeenCalledWith(
      'auth',
      expect.objectContaining({ concept: 'auth', platformSource: 'cursor' })
    );

    const byTypeResponse = makeResponse();
    callHandler(handlers, '/api/search/by-type', makeRequest({
      path: '/api/search/by-type',
      query: { type: 'decision' },
      headers: { 'x-platform-source': 'Cursor' },
    }), byTypeResponse.res);
    await flushAsyncHandlers();

    expect(findByType).toHaveBeenCalledWith(
      'decision',
      expect.objectContaining({ type: 'decision', platformSource: 'cursor' })
    );
  });

  it('keeps query platform source precedence over platform-source headers', async () => {
    const search = mock(async () => ({ route: 'search' }));
    const routes = new SearchRoutes({ search } as any);
    const handlers = captureGetHandlers(routes);
    const response = makeResponse();

    callHandler(handlers, '/api/search', makeRequest({
      path: '/api/search',
      query: { query: 'needle', platform_source: 'Codex' },
      headers: { 'x-claude-mem-platform-source': 'cursor' },
    }), response.res);
    await flushAsyncHandlers();

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'needle',
        platform_source: 'Codex',
        platformSource: 'codex',
      }),
      expect.any(Object)
    );
  });

  it('uses header and query platform source to scope rendered recent context rows', async () => {
    const db = new Database(':memory:');
    const store = new SessionStore(db);
    const search = new SessionSearch(db);
    const project = 'recent-route-platform-scope';

    try {
      const claudeSessionDbId = store.createSDKSession('recent-claude-content', project, 'CLAUDE_RECENT_PROMPT', undefined, 'claude');
      store.ensureMemorySessionIdRegistered(claudeSessionDbId, 'recent-claude-memory');
      store.storeObservation('recent-claude-memory', project, {
        type: 'discovery',
        title: 'CLAUDE_RECENT_OBS',
        subtitle: null,
        facts: [],
        narrative: 'claude-only recent context',
        concepts: [],
        files_read: [],
        files_modified: [],
      }, 1);

      const cursorSessionDbId = store.createSDKSession('recent-cursor-content', project, 'CURSOR_RECENT_PROMPT', undefined, 'cursor');
      store.ensureMemorySessionIdRegistered(cursorSessionDbId, 'recent-cursor-memory');
      store.storeObservation('recent-cursor-memory', project, {
        type: 'discovery',
        title: 'CURSOR_RECENT_OBS',
        subtitle: null,
        facts: [],
        narrative: 'cursor-only recent context',
        concepts: [],
        files_read: [],
        files_modified: [],
      }, 1);

      const routes = new SearchRoutes(new SearchManager(
        search,
        store,
        null,
        new FormattingService(),
        new TimelineService(),
      ));
      const handlers = captureGetHandlers(routes);

      const requests = [
        makeRequest({
          path: '/api/context/recent',
          query: { project, limit: '10' },
          headers: { 'x-platform-source': 'Cursor' },
        }),
        makeRequest({
          path: '/api/context/recent',
          query: { project, limit: '10', platform_source: 'Cursor' },
        }),
      ];

      for (const req of requests) {
        const response = makeResponse();
        callHandler(handlers, '/api/context/recent', req, response.res);
        await flushAsyncHandlers();

        const payload = response.json.mock.calls[0][0] as any;
        const text = payload.content[0].text as string;
        expect(text).toContain('CURSOR_RECENT_PROMPT');
        expect(text).toContain('CURSOR_RECENT_OBS');
        expect(text).not.toContain('CLAUDE_RECENT_PROMPT');
        expect(text).not.toContain('CLAUDE_RECENT_OBS');
      }
    } finally {
      store.close();
    }
  });
});
