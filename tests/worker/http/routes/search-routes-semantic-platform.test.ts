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
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Request {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    path: '/api/context/semantic',
    body: input.body ?? {},
    query: input.query ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

const LONG_QUERY = 'Find relevant platform scoped semantic context memories for this project';

describe('/api/context/semantic platform scoping', () => {
  const cases: Array<[string, {
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
  }]> = [
    ['body platformSource', { body: { platformSource: 'Cursor' } }],
    ['body platform_source', { body: { platform_source: 'cursor' } }],
    ['query platform_source', { query: { platform_source: 'cursor' } }],
    ['x-platform-source header', { headers: { 'x-platform-source': 'cursor' } }],
  ];

  for (const [label, request] of cases) {
    it(`forwards ${label} into SearchManager.search`, async () => {
      const search = mock(async (options: Record<string, unknown>) => {
        if (options.platformSource !== 'cursor') {
          return {
            observations: [{
              title: 'CLAUDE_CROSS_PLATFORM_OBS',
              narrative: 'wrong platform',
              created_at: '2026-06-01T00:00:00.000Z',
            }],
          };
        }

        return {
          observations: [{
            title: 'CURSOR_SCOPED_OBS',
            narrative: 'cursor platform result',
            created_at: '2026-06-02T00:00:00.000Z',
          }],
        };
      });
      const routes = new SearchRoutes({ search } as any);
      const handler = captureSemanticHandler(routes);
      const response = makeResponse();

      handler(makeRequest({
        ...request,
        body: { q: LONG_QUERY, project: 'semantic-platform-project', ...(request.body ?? {}) },
      }), response.res);
      await flushAsyncHandlers();

      expect(search).toHaveBeenCalledWith(expect.objectContaining({
        query: LONG_QUERY,
        type: 'observations',
        project: 'semantic-platform-project',
        platformSource: 'cursor',
        format: 'json',
      }));
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
      const body = (response.json as any).mock.calls[0][0] as { context: string };
      expect(body.context).toContain('CURSOR_SCOPED_OBS');
      expect(body.context).not.toContain('CLAUDE_CROSS_PLATFORM_OBS');
    });
  }
});

describe('/api/context/semantic format', () => {
  const LONG_QUERY = 'Find relevant semantic context memories to inject for this prompt';
  const observation = {
    id: 4118,
    title: 'Semantic injection renders narratives',
    subtitle: 'Index format is opt-in',
    narrative: 'NARRATIVE_BODY',
    created_at: '2026-10-04T00:00:00.000Z',
  };

  async function render(body: Record<string, unknown>): Promise<string> {
    const routes = new SearchRoutes({ search: mock(async () => ({ observations: [observation] })) } as any);
    const handler = captureSemanticHandler(routes);
    const response = makeResponse();
    handler(makeRequest({ body: { q: LONG_QUERY, ...body } }), response.res);
    await flushAsyncHandlers();
    return ((response.json as any).mock.calls[0][0] as { context: string }).context;
  }

  it('renders full narratives when no format is given', async () => {
    const context = await render({});
    expect(context).toContain('### Semantic injection renders narratives (2026-10-04)');
    expect(context).toContain('NARRATIVE_BODY');
  });

  it('renders id, title and subtitle with a get_observations pointer for format=index', async () => {
    const context = await render({ format: 'index' });
    expect(context).toContain('- #4118 Semantic injection renders narratives — Index format is opt-in (2026-10-04)');
    expect(context).toContain('get_observations');
    expect(context).not.toContain('NARRATIVE_BODY');
  });
});
