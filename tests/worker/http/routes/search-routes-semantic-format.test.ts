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

const LONG_QUERY = 'Find relevant semantic context memories to inject for this prompt';

describe('/api/context/semantic format', () => {
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
