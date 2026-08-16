import { describe, it, expect, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

/**
 * Relevance-annotation layer over /api/context/semantic
 * (CLAUDE_MEM_SEMANTIC_ANNOTATE). The annotator is stubbed per test; settings
 * are injected through the route's TTL-cached settings slot so no real
 * settings.json or Claude SDK process is involved.
 */

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
  return { path: '/api/context/semantic', body, query: {}, get: () => undefined } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

const LONG_QUERY = 'Why does the token refresh flake under parallel load again?';
const PROJECT = 'kit';

const LOCAL_OBS = [
  { id: 1, title: 'REFRESH_RACE', narrative: 'mutex released too early', created_at: '2026-06-01T00:00:00.000Z', project: PROJECT },
  { id: 2, title: 'UNRELATED_NAMING', narrative: 'collection prefix conventions', created_at: '2026-06-02T00:00:00.000Z', project: PROJECT },
];

function makeRoutes(options: { mainObservations?: any[]; globalObservations?: any[] } = {}) {
  const annotate = mock(async () => ({ outcome: 'ok' as const, verdicts: null, durationMs: 3, model: 'haiku' }));
  const search = mock(async (args: Record<string, unknown>) => ({
    observations: args.project ? (options.mainObservations ?? []) : (options.globalObservations ?? []),
  }));
  const routes = new SearchRoutes({
    search,
    getSessionSearch: () => ({ searchFacts: () => [] }),
  } as any);
  (routes as any).relevanceAnnotator = { annotate };
  return { routes, annotate };
}

function setAnnotateFlag(routes: SearchRoutes, value: 'true' | 'false'): void {
  (routes as any).cachedSettings = {
    CLAUDE_MEM_SEMANTIC_ANNOTATE: value,
    CLAUDE_MEM_SEMANTIC_ANNOTATE_DEBUG_LOG: 'false',
  };
  (routes as any).cachedSettingsAt = Date.now();
}

async function runSemantic(routes: SearchRoutes, body: Record<string, unknown> = {}): Promise<any> {
  const handler = captureSemanticHandler(routes);
  const response = makeResponse();
  handler(makeRequest({ q: LONG_QUERY, project: PROJECT, limit: 5, ...body }), response.res);
  await flushAsyncHandlers();
  return (response.json as any).mock.calls[0][0];
}

describe('/api/context/semantic relevance annotation', () => {
  it('flag off (default): annotator is never called and the response shape is unchanged', async () => {
    const { routes, annotate } = makeRoutes({ mainObservations: LOCAL_OBS });
    setAnnotateFlag(routes, 'false');

    const body = await runSemantic(routes);

    expect(annotate).not.toHaveBeenCalled();
    expect(body.annotations).toBeUndefined();
    expect(body.count).toBe(2);
    expect(body.context).toContain('REFRESH_RACE');
    expect(body.context).not.toContain('**Why now:**');
  });

  it('keep verdicts render a compact "Why now:" entry — hint and id, no narrative', async () => {
    const { routes, annotate } = makeRoutes({ mainObservations: LOCAL_OBS });
    setAnnotateFlag(routes, 'true');
    annotate.mockImplementation(async () => ({
      outcome: 'ok' as const,
      verdicts: new Map([['id:1', { hint: 'same race as your bug' }]]),
      durationMs: 12,
      model: 'haiku',
    }));

    const body = await runSemantic(routes);

    expect(body.context).toContain('### REFRESH_RACE (2026-06-01) #1\n**Why now:** same race as your bug');
    // Compact mode: the full narrative is replaced by the hint; the id stays
    // for expansion via get_observations.
    expect(body.context).not.toContain('mutex released too early');
    expect(body.context).toContain('get_observations([id])');
    expect(body.annotations).toEqual({ attempted: true, kept: 1, dropped: 0, durationMs: 12, timedOut: false });
  });

  it('drop verdicts remove the memory from the injection and from the count', async () => {
    const { routes, annotate } = makeRoutes({ mainObservations: LOCAL_OBS });
    setAnnotateFlag(routes, 'true');
    annotate.mockImplementation(async () => ({
      outcome: 'ok' as const,
      verdicts: new Map<string, unknown>([
        ['id:1', { hint: 'same race' }],
        ['id:2', 'drop'],
      ]),
      durationMs: 9,
      model: 'haiku',
    }));

    const body = await runSemantic(routes);

    expect(body.context).toContain('REFRESH_RACE');
    expect(body.context).not.toContain('UNRELATED_NAMING');
    expect(body.count).toBe(1);
    expect(body.annotations).toMatchObject({ kept: 1, dropped: 1 });
  });

  it('fail-open: a non-ok outcome (timeout) leaves the injection untouched, narratives included', async () => {
    const { routes, annotate } = makeRoutes({ mainObservations: LOCAL_OBS });
    setAnnotateFlag(routes, 'true');
    annotate.mockImplementation(async () => ({
      outcome: 'timeout' as const,
      verdicts: null,
      durationMs: 4000,
      model: 'haiku',
    }));

    const body = await runSemantic(routes);

    expect(body.count).toBe(2);
    expect(body.context).toContain('REFRESH_RACE');
    expect(body.context).toContain('UNRELATED_NAMING');
    expect(body.context).toContain('mutex released too early'); // full narrative kept
    expect(body.context).not.toContain('**Why now:**');
    expect(body.annotations).toMatchObject({ attempted: true, kept: 0, dropped: 0, timedOut: true });
  });

  it('verdicts apply to the cross-project section as well', async () => {
    const { routes, annotate } = makeRoutes({
      mainObservations: [LOCAL_OBS[0]],
      globalObservations: [
        { id: 7, title: 'GPU_FIX', narrative: 'driver pin fixed it', created_at: '2026-06-03T00:00:00.000Z', project: 'search' },
      ],
    });
    setAnnotateFlag(routes, 'true');
    annotate.mockImplementation(async (query: string, candidates: any[]) => ({
      outcome: 'ok' as const,
      // Both sections arrive in ONE batched call.
      verdicts: new Map<string, unknown>([
        ['id:1', 'drop'],
        ['id:7', { hint: 'pin the driver first' }],
      ]),
      durationMs: 20,
      model: 'haiku',
    }));

    const body = await runSemantic(routes, { globalLimit: 3 });

    expect(annotate).toHaveBeenCalledTimes(1);
    const candidates = (annotate.mock.calls[0] as any[])[1];
    expect(candidates.map((c: any) => c.key)).toEqual(['id:1', 'id:7']);

    // Dropped from the main section, hinted in the global one.
    expect(body.count).toBe(0);
    expect(body.context).toBe('');
    expect(body.globalContext).toContain('### GPU_FIX (2026-06-03) [project: search] #7\n**Why now:** pin the driver first');
    expect(body.globalContext).not.toContain('driver pin fixed it'); // compact: no narrative
    expect(body.globalCount).toBe(1);
    expect(body.annotations).toMatchObject({ kept: 1, dropped: 1 });
  });
});
