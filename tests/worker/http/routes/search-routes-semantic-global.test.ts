import { describe, it, expect, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

type SemanticHandler = (req: Request, res: Response) => void;

function captureSemanticHandler(routes: SearchRoutes): SemanticHandler {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: SemanticHandler | undefined;
  const app = {
    use: mock(() => {}),
    get: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path !== '/api/context/semantic') return;
      if (rest.length === 1) {
        handler = rest[0];
      } else {
        middleware = rest[0];
        handler = rest[1];
      }
    }),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error('Failed to capture /api/context/semantic handler');

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

function makeResponse(): { res: Response; json: ReturnType<typeof mock> } {
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
  return { res: res as Response, json };
}

function makeRequest(body: Record<string, unknown>): Request {
  return {
    path: '/api/context/semantic',
    body,
    query: {},
    get: () => undefined,
  } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

const LONG_QUERY = 'Find relevant cross project semantic context memories for this prompt';
const PROJECT = 'kit';

interface SearchManagerStubOptions {
  mainObservations?: any[];
  globalObservations?: any[];
  facts?: any[];
  searchCalls?: Array<Record<string, unknown>>;
}

function makeRoutes(options: SearchManagerStubOptions): { routes: SearchRoutes; searchCalls: Array<Record<string, unknown>> } {
  const searchCalls = options.searchCalls ?? [];
  const search = mock(async (args: Record<string, unknown>) => {
    searchCalls.push(args);
    return {
      observations: args.project ? (options.mainObservations ?? []) : (options.globalObservations ?? []),
    };
  });
  const searchFacts = mock(() => options.facts ?? []);
  const routes = new SearchRoutes({
    search,
    getSessionSearch: () => ({ searchFacts }),
  } as any);
  return { routes, searchCalls };
}

async function runSemantic(routes: SearchRoutes, body: Record<string, unknown>): Promise<any> {
  const handler = captureSemanticHandler(routes);
  const response = makeResponse();
  handler(makeRequest({ q: LONG_QUERY, project: PROJECT, ...body }), response.res);
  await flushAsyncHandlers();
  return (response.json as any).mock.calls[0][0];
}

describe('/api/context/semantic cross-project (globalLimit)', () => {
  it('does not run the global search when globalLimit is absent (default off)', async () => {
    const { routes, searchCalls } = makeRoutes({
      mainObservations: [{ id: 1, title: 'LOCAL', narrative: 'local', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT }],
    });

    const body = await runSemantic(routes, { limit: 5 });

    expect(searchCalls.length).toBe(1);
    expect(body.context).toContain('LOCAL');
    expect(body.globalContext).toBeUndefined();
    expect(body.globalCount).toBeUndefined();
  });

  it('does not run the global search when globalLimit is 0', async () => {
    const { routes, searchCalls } = makeRoutes({
      mainObservations: [{ id: 1, title: 'LOCAL', narrative: 'local', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT }],
    });

    const body = await runSemantic(routes, { limit: 5, globalLimit: 0 });

    expect(searchCalls.length).toBe(1);
    expect(body.globalContext).toBeUndefined();
  });

  it('runs a second search without the project filter and renders other-project hits in a separate section', async () => {
    const { routes, searchCalls } = makeRoutes({
      mainObservations: [{ id: 1, title: 'LOCAL_OBS', narrative: 'local hit', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT }],
      globalObservations: [
        { id: 1, title: 'LOCAL_OBS', narrative: 'same row again', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT },
        { id: 2, title: 'SAME_PROJECT_OTHER_ROW', narrative: 'still current project', created_at: '2026-06-02T00:00:00.000Z', project: PROJECT },
        { id: 3, title: 'PALANTIR_OBS', narrative: 'palantir knowledge', created_at: '2026-06-03T00:00:00.000Z', project: 'search' },
      ],
    });

    const body = await runSemantic(routes, { limit: 5, globalLimit: 3 });

    expect(searchCalls.length).toBe(2);
    expect(searchCalls[0].project).toBe(PROJECT);
    expect(searchCalls[1].project).toBeUndefined();

    expect(body.globalCount).toBe(1);
    expect(body.globalContext).toContain('## Relevant Past Work — other projects');
    expect(body.globalContext).toContain('PALANTIR_OBS');
    expect(body.globalContext).toContain('[project: search]');
    // Dedup by id against the main set and current-project exclusion.
    expect(body.globalContext).not.toContain('LOCAL_OBS');
    expect(body.globalContext).not.toContain('SAME_PROJECT_OTHER_ROW');
    // The main section stays untouched.
    expect(body.context).toContain('## Relevant Past Work (semantic match)');
    expect(body.context).toContain('LOCAL_OBS');
    expect(body.context).not.toContain('PALANTIR_OBS');
  });

  it('caps cross-project observations at globalLimit', async () => {
    const { routes } = makeRoutes({
      globalObservations: [10, 11, 12, 13].map(id => ({
        id,
        title: `GLOBAL_${id}`,
        narrative: 'other project hit',
        created_at: '2026-06-01T00:00:00.000Z',
        project: 'search',
      })),
    });

    const body = await runSemantic(routes, { limit: 5, globalLimit: 2 });

    expect(body.globalCount).toBe(2);
    expect(body.globalContext).toContain('GLOBAL_10');
    expect(body.globalContext).toContain('GLOBAL_11');
    expect(body.globalContext).not.toContain('GLOBAL_12');
  });

  it('fills the remaining budget with cross-project FTS facts', async () => {
    const { routes } = makeRoutes({
      globalObservations: [
        { id: 3, title: 'PALANTIR_OBS', narrative: 'palantir knowledge', created_at: '2026-06-03T00:00:00.000Z', project: 'search' },
      ],
      facts: [
        { id: 42, project: 'search', kind: 'architecture', fact: 'Palantir Foundry uses ontology-backed datasets' },
        { id: 43, project: PROJECT, kind: 'environment', fact: 'current project fact — must be excluded' },
        { id: 44, project: 'other', kind: 'user_preference', fact: 'prefers dark mode' },
      ],
    });

    const body = await runSemantic(routes, { limit: 5, globalLimit: 3 });

    // 1 observation + 2 facts (current-project fact excluded) = 3.
    expect(body.globalCount).toBe(3);
    expect(body.globalContext).toContain('PALANTIR_OBS');
    expect(body.globalContext).toContain('#42 [search/architecture] Palantir Foundry uses ontology-backed datasets');
    expect(body.globalContext).toContain('#44 [other/user_preference] prefers dark mode');
    expect(body.globalContext).not.toContain('must be excluded');
  });

  it('still returns the global section when the current project has no matches', async () => {
    const { routes } = makeRoutes({
      mainObservations: [],
      globalObservations: [
        { id: 3, title: 'PALANTIR_OBS', narrative: 'palantir knowledge', created_at: '2026-06-03T00:00:00.000Z', project: 'search' },
      ],
    });

    const body = await runSemantic(routes, { limit: 5, globalLimit: 3 });

    expect(body.context).toBe('');
    expect(body.count).toBe(0);
    expect(body.globalCount).toBe(1);
    expect(body.globalContext).toContain('PALANTIR_OBS');
  });

  it('omits the global section when the global search yields nothing usable', async () => {
    const { routes } = makeRoutes({
      mainObservations: [{ id: 1, title: 'LOCAL', narrative: 'local', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT }],
      globalObservations: [
        { id: 1, title: 'LOCAL', narrative: 'local', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT },
      ],
    });

    const body = await runSemantic(routes, { limit: 5, globalLimit: 3 });

    expect(body.globalContext).toBeUndefined();
    expect(body.globalCount).toBeUndefined();
  });
});
