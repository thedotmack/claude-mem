import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { logger } from '../../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
const baseReq: any = {
  body: { q: 'find recent work on this topic with enough words' },
};

interface MockRes {
  json: ReturnType<typeof mock>;
  status: ReturnType<typeof mock>;
}

function createMockRes(): MockRes {
  const res: any = {
    json: mock(() => {}),
    status: mock(() => res),
  };
  return res;
}

function captureSemanticContextHandler(routes: SearchRoutes): (req: Request, res: Response) => void | Promise<void> {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;

  const mockApp: any = {
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
    delete: mock(() => {}),
    use: mock(() => {}),
  };

  routes.setupRoutes(mockApp);

  if (!handler) {
    throw new Error('Failed to capture /api/context/semantic handler');
  }

  return async (req: Request, res: Response) => {
    if (!middleware) {
      return handler(req, res);
    }

    let nextCalled = false;
    await Promise.resolve(middleware(req, res, () => {
      nextCalled = true;
    }));
    if (nextCalled) {
      return handler(req, res);
    }
    return Promise.resolve();
  };
}

describe('SearchRoutes /api/context/semantic', () => {
  let searchMock: ReturnType<typeof mock>;
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

  it('returns scoped results without triggering fallback', async () => {
    const scopedRows = [
      { title: 'scoped-hit', narrative: 'Scoped narrative', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { title: 'extra', narrative: 'Ignored by limit', created_at: '2026-01-02T00:00:00Z', project: 'request-project' },
    ];
    searchMock = mock(() => ({ observations: scopedRows }));

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = {
      body: { ...baseReq.body, project: 'request-project', limit: '2' },
      query: {},
    } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ query: baseReq.body.q, project: 'request-project', limit: '2', type: 'observations', format: 'json' });
    expect(body.context).toContain('## Relevant Past Work (semantic match)');
    expect(body.context).toContain('Scoped narrative');
    expect(body.count).toBe(2);
  });

  it('falls back to one unscoped retry when scoped results are empty', async () => {
    let call = 0;
    const fallbackRows = [
      { title: 'fallback-noise-first', narrative: 'Higher-ranked wrong project', created_at: '2026-01-01T00:00:00Z', project: 'other-project' },
      { title: 'fallback-hit', narrative: 'Fallback by project', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { title: 'fallback-noise', narrative: 'Wrong project', created_at: '2026-01-02T00:00:00Z', project: 'other-project' },
    ];
    searchMock = mock((args: any) => {
      call += 1;
      if (call === 1) return { observations: [] };
      return { observations: fallbackRows };
    });

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[1][0]).not.toMatchObject({ project: 'request-project' });
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100' });
    expect(body.context).toContain('Fallback by project');
    expect(body.context).not.toContain('Higher-ranked wrong project');
    expect(body.context).not.toContain('Wrong project');
    expect(body.count).toBe(1);
  });

  it('keeps the fallback window wide enough to recover project hits beyond the old prefilter cap', async () => {
    const fallbackRows = Array.from({ length: 26 }, (_value, index) => ({
      title: `fallback-row-${index + 1}`,
      narrative: index === 25 ? 'Late matching project row' : `Noise row ${index + 1}`,
      created_at: '2026-01-01T00:00:00Z',
      project: index === 25 ? 'request-project' : 'other-project',
    }));
    searchMock = mock((args: any) => {
      if (args?.project) return { observations: [] };
      return { observations: fallbackRows };
    });

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project', limit: '5' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100' });
    expect(body.context).toContain('Late matching project row');
    expect(body.count).toBe(1);
  });

  it('recovers matches where merged_into_project matches the requested project', async () => {
    const fallbackRows = [
      { title: 'adopted-hit', narrative: 'Merged match', created_at: '2026-01-03T00:00:00Z', project: 'other-project', merged_into_project: 'request-project' },
      { title: 'not-a-hit', narrative: 'No match', created_at: '2026-01-04T00:00:00Z', project: 'other-project', merged_into_project: 'other-parent' },
    ];
    searchMock = mock((args: any) => {
      if (args?.project) return { observations: [] };
      return { observations: fallbackRows };
    });

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project', limit: 3 }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(body.context).toContain('Merged match');
    expect(body.context).not.toContain('No match');
    expect(body.count).toBe(1);
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100', type: 'observations' });
    expect(searchMock.mock.calls[1][0]).not.toHaveProperty('project');
  });

  it('does not fall back when no project is provided', async () => {
    searchMock = mock(() => ({ observations: [] }));

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(body.context).toBe('');
    expect(body.count).toBe(0);
  });

  it('returns empty semantic context when fallback observations do not match project filters', async () => {
    let call = 0;
    const fallbackRows = [
      { title: 'wrong-project', narrative: 'Wrong project', created_at: '2026-01-05T00:00:00Z', project: 'other-project' },
      { title: 'also-wrong', narrative: 'Also wrong', created_at: '2026-01-06T00:00:00Z', project: 'other-parent', merged_into_project: 'other-project' },
    ];
    searchMock = mock(() => {
      call += 1;
      if (call === 1) return { observations: [] };
      return { observations: fallbackRows };
    });

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(body.context).toBe('');
    expect(body.count).toBe(0);
  });
});
