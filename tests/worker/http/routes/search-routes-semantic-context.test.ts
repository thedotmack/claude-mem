import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { logger } from '../../../../src/utils/logger.js';

const QUERY = 'find recent work on this topic with enough words';

function createMockRes(): Response & { json: ReturnType<typeof mock>; status: ReturnType<typeof mock> } {
  const res: any = {
    json: mock(() => {}),
    status: mock(() => res),
  };
  return res;
}

function captureSemanticContextHandler(routes: SearchRoutes): (req: Request, res: Response) => Promise<void> {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void | Promise<void>) | undefined;
  const app: any = {
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
    use: mock(() => {}),
  };

  routes.setupRoutes(app);
  if (!handler) throw new Error('Failed to capture /api/context/semantic handler');

  return async (req: Request, res: Response): Promise<void> => {
    if (!middleware) {
      await handler!(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) {
      await handler!(req, res);
    }
  };
}

function makeRequest(body: Record<string, unknown>): Request {
  return {
    body,
    query: {},
    path: '/api/context/semantic',
    get: () => undefined,
  } as any;
}

describe('SearchRoutes /api/context/semantic recovery', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

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
  });

  it('recovers merged project matches from an unscoped semantic retry', async () => {
    const search = mock((args: any) => (
      args.project
        ? { observations: [] }
        : {
            observations: [
              { id: 1, title: 'wrong', narrative: 'Wrong project', created_at: '2026-01-01T00:00:00Z', project: 'other' },
              { id: 2, title: 'merged', narrative: 'Recovered merged match', created_at: '2026-01-02T00:00:00Z', project: 'other', merged_into_project: 'request-project' },
            ],
          }
    ));
    const handler = captureSemanticContextHandler(new SearchRoutes({ search } as any));
    const res = createMockRes();

    await handler(makeRequest({ q: QUERY, project: 'request-project', limit: '5' }), res);

    const [body] = res.json.mock.calls[0] as any[];
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0][0]).toMatchObject({ project: 'request-project', orderBy: 'relevance' });
    expect(search.mock.calls[0][2]).toEqual({ semanticHydrationLimit: 100 });
    expect(search.mock.calls[1][0]).not.toHaveProperty('project');
    expect(body.context).toContain('Recovered merged match');
    expect(body.context).not.toContain('Wrong project');
    expect(body.count).toBe(1);
  });

  it('keeps scoped semantic results when the unscoped retry falls back to keyword search', async () => {
    const search = mock((args: any, telemetry?: any) => {
      if (args.project) {
        if (telemetry) telemetry.search_strategy = 'chroma';
        return { observations: [{ id: 3, title: 'scoped', narrative: 'Scoped semantic hit', created_at: '2026-01-03T00:00:00Z', project: 'request-project' }] };
      }
      if (telemetry) telemetry.search_strategy = 'fts';
      return { observations: [{ id: 4, title: 'keyword', narrative: 'Keyword fallback hit', created_at: '2026-01-04T00:00:00Z', project: 'request-project' }] };
    });
    const handler = captureSemanticContextHandler(new SearchRoutes({ search } as any));
    const res = createMockRes();

    await handler(makeRequest({ q: QUERY, project: 'request-project', limit: '5' }), res);

    const [body] = res.json.mock.calls[0] as any[];
    expect(body.context).toContain('Scoped semantic hit');
    expect(body.context).not.toContain('Keyword fallback hit');
    expect(body.count).toBe(1);
  });

  it('keeps scoped results and logs only query length when fallback throws', async () => {
    let call = 0;
    const search = mock(() => {
      call += 1;
      if (call === 1) {
        return { observations: [{ id: 5, title: 'scoped', narrative: 'Scoped survives', created_at: '2026-01-05T00:00:00Z', project: 'request-project' }] };
      }
      throw new Error('fallback unavailable');
    });
    const handler = captureSemanticContextHandler(new SearchRoutes({ search } as any));
    const res = createMockRes();

    await handler(makeRequest({ q: QUERY, project: 'request-project', limit: '5' }), res);

    const [body] = res.json.mock.calls[0] as any[];
    expect(body.context).toContain('Scoped survives');
    expect(JSON.stringify(loggerSpies[2].mock.calls[0])).not.toContain(QUERY);
    expect((loggerSpies[2].mock.calls[0] as any[])[2]).toEqual({
      queryLength: QUERY.length,
      project: 'request-project',
      platformSource: undefined,
    });
  });

  it('does not run recovery when no project is provided', async () => {
    const search = mock(() => ({ observations: [] }));
    const handler = captureSemanticContextHandler(new SearchRoutes({ search } as any));
    const res = createMockRes();

    await handler(makeRequest({ q: QUERY, limit: '5' }), res);

    const [body] = res.json.mock.calls[0] as any[];
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).not.toHaveProperty('project');
    expect(body).toEqual({ context: '', count: 0 });
  });
});
