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

  it('retains scoped results when the relevance-ordered retry adds nothing new', async () => {
    const scopedRows = [
      { id: 1, title: 'scoped-hit', narrative: 'Scoped narrative', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { id: 2, title: 'extra', narrative: 'Ignored by limit', created_at: '2026-01-02T00:00:00Z', project: 'request-project' },
    ];
    const fallbackRows = [
      ...scopedRows,
      { id: 3, title: 'wrong-project', narrative: 'Wrong project', created_at: '2026-01-03T00:00:00Z', project: 'other-project' },
    ];
    searchMock = mock((args: any) => (
      args?.project
        ? { observations: scopedRows }
        : { observations: fallbackRows }
    ));

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
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ query: baseReq.body.q, project: 'request-project', limit: '100', type: 'observations', format: 'json', orderBy: 'relevance' });
    expect(searchMock.mock.calls[1][0]).toMatchObject({ query: baseReq.body.q, limit: '100', type: 'observations', format: 'json', orderBy: 'relevance' });
    expect(body.context).toContain('## Relevant Past Work (semantic match)');
    expect(body.context).toContain('Scoped narrative');
    expect(body.context).not.toContain('Wrong project');
    expect(body.count).toBe(2);
  });

  it('falls back to one unscoped retry when scoped results are empty', async () => {
    let call = 0;
    const fallbackRows = [
      { id: 11, title: 'fallback-noise-first', narrative: 'Higher-ranked wrong project', created_at: '2026-01-01T00:00:00Z', project: 'other-project' },
      { id: 12, title: 'fallback-hit', narrative: 'Fallback by project', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { id: 13, title: 'fallback-noise', narrative: 'Wrong project', created_at: '2026-01-02T00:00:00Z', project: 'other-project' },
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
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100', orderBy: 'relevance' });
    expect(body.context).toContain('Fallback by project');
    expect(body.context).not.toContain('Higher-ranked wrong project');
    expect(body.context).not.toContain('Wrong project');
    expect(body.count).toBe(1);
  });

  it('keeps the fallback window wide enough to recover project hits beyond the old prefilter cap', async () => {
    const fallbackRows = Array.from({ length: 26 }, (_value, index) => ({
      id: index + 1,
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
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100', orderBy: 'relevance' });
    expect(body.context).toContain('Late matching project row');
    expect(body.count).toBe(1);
  });

  it('recovers matches where merged_into_project matches the requested project', async () => {
    const fallbackRows = [
      { id: 21, title: 'adopted-hit', narrative: 'Merged match', created_at: '2026-01-03T00:00:00Z', project: 'other-project', merged_into_project: 'request-project' },
      { id: 22, title: 'not-a-hit', narrative: 'No match', created_at: '2026-01-04T00:00:00Z', project: 'other-project', merged_into_project: 'other-parent' },
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
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100', type: 'observations', orderBy: 'relevance' });
    expect(searchMock.mock.calls[1][0]).not.toHaveProperty('project');
  });

  it('supplements partial scoped hits with merged project matches from the unscoped retry', async () => {
    let call = 0;
    const scopedRows = [
      { id: 31, title: 'direct-hit', narrative: 'Direct scoped match', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
    ];
    const fallbackRows = [
      { id: 31, title: 'direct-hit', narrative: 'Direct scoped match', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { id: 32, title: 'merged-hit', narrative: 'Recovered merged match', created_at: '2026-01-02T00:00:00Z', project: 'other-project', merged_into_project: 'request-project' },
      { id: 33, title: 'wrong-project', narrative: 'Wrong project', created_at: '2026-01-03T00:00:00Z', project: 'other-project' },
    ];
    searchMock = mock((args: any) => {
      call += 1;
      if (call === 1) return { observations: scopedRows };
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
    expect(searchMock.mock.calls[0][0]).toMatchObject({ project: 'request-project', limit: '100', orderBy: 'relevance' });
    expect(searchMock.mock.calls[1][0]).toMatchObject({ limit: '100', orderBy: 'relevance' });
    expect(body.context).toContain('Direct scoped match');
    expect(body.context).toContain('Recovered merged match');
    expect(body.context).not.toContain('Wrong project');
    expect(body.count).toBe(2);
  });

  it('keeps scoped results when the fallback retry throws', async () => {
    let call = 0;
    const scopedRows = [
      { id: 43, title: 'direct-hit', narrative: 'Direct scoped match', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
    ];
    searchMock = mock((_args: any, telemetry?: any) => {
      call += 1;
      if (call === 1) {
        if (telemetry) telemetry.search_strategy = 'chroma';
        return { observations: scopedRows };
      }
      throw new Error('fallback unavailable');
    });

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project', limit: '5' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(body.context).toContain('Direct scoped match');
    expect(body.count).toBe(1);
    const warnContext = (loggerSpies[2].mock.calls[0] as any[])[2];
    expect(JSON.stringify(loggerSpies[2].mock.calls[0])).not.toContain(baseReq.body.q);
    expect(warnContext).toEqual({ queryLength: baseReq.body.q.length, project: 'request-project' });
  });

  it('recovers adopted matches even when scoped hydration already fills the limit', async () => {
    const scopedRows = [
      { id: 51, title: 'direct-hit-1', narrative: 'Direct hit 1', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { id: 52, title: 'direct-hit-2', narrative: 'Direct hit 2', created_at: '2026-01-02T00:00:00Z', project: 'request-project' },
      { id: 53, title: 'direct-hit-3', narrative: 'Direct hit 3', created_at: '2026-01-03T00:00:00Z', project: 'request-project' },
      { id: 54, title: 'direct-hit-4', narrative: 'Direct hit 4', created_at: '2026-01-04T00:00:00Z', project: 'request-project' },
      { id: 55, title: 'direct-hit-5', narrative: 'Direct hit 5', created_at: '2026-01-05T00:00:00Z', project: 'request-project' },
    ];
    const fallbackRows = [
      { id: 56, title: 'merged-top-hit', narrative: 'Recovered adopted top hit', created_at: '2026-01-06T00:00:00Z', project: 'other-project', merged_into_project: 'request-project' },
      ...scopedRows,
    ];
    searchMock = mock((args: any) => (
      args?.project
        ? { observations: scopedRows }
        : { observations: fallbackRows }
    ));

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project', limit: '5' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(body.context).toContain('Recovered adopted top hit');
    expect(body.context).toContain('Direct hit 1');
    expect(body.context).toContain('Direct hit 4');
    expect(body.context).not.toContain('Direct hit 5');
    expect(body.count).toBe(5);
  });

  it('preserves fallback relevance order when recovered matches outrank direct scoped rows', async () => {
    const scopedRows = [
      { id: 61, title: 'direct-hit-low-1', narrative: 'Lower direct hit 1', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { id: 62, title: 'direct-hit-low-2', narrative: 'Lower direct hit 2', created_at: '2026-01-02T00:00:00Z', project: 'request-project' },
    ];
    const fallbackRows = [
      { id: 63, title: 'merged-high-hit', narrative: 'Recovered high-rank merged hit', created_at: '2026-01-03T00:00:00Z', project: 'other-project', merged_into_project: 'request-project' },
      ...scopedRows,
    ];
    searchMock = mock((args: any) => (
      args?.project
        ? { observations: scopedRows }
        : { observations: fallbackRows }
    ));

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project', limit: '2' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(body.context).toContain('Recovered high-rank merged hit');
    expect(body.context).toContain('Lower direct hit 1');
    expect(body.context).not.toContain('Lower direct hit 2');
    expect(body.context.indexOf('Recovered high-rank merged hit')).toBeLessThan(
      body.context.indexOf('Lower direct hit 1')
    );
    expect(body.count).toBe(2);
  });

  it('keeps scoped semantic ordering when the fallback search drops to FTS', async () => {
    const scopedRows = [
      { id: 71, title: 'direct-hit-1', narrative: 'Scoped semantic hit 1', created_at: '2026-01-01T00:00:00Z', project: 'request-project' },
      { id: 72, title: 'direct-hit-2', narrative: 'Scoped semantic hit 2', created_at: '2026-01-02T00:00:00Z', project: 'request-project' },
    ];
    const fallbackRows = [
      { id: 73, title: 'fts-hit', narrative: 'Keyword fallback hit', created_at: '2026-01-03T00:00:00Z', project: 'request-project' },
      ...scopedRows,
    ];
    searchMock = mock((args: any, telemetry?: any) => {
      if (args?.project) {
        if (telemetry) telemetry.search_strategy = 'chroma';
        return { observations: scopedRows };
      }
      if (telemetry) telemetry.search_strategy = 'fts';
      return { observations: fallbackRows };
    });

    const routes = new SearchRoutes({ search: searchMock } as any);
    const handler = captureSemanticContextHandler(routes);
    const req = { body: { ...baseReq.body, project: 'request-project', limit: '2' }, query: {} } as unknown as Request;
    const res = createMockRes();

    await handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const [body] = res.json.mock.calls[0] as any[];
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(body.context).toContain('Scoped semantic hit 1');
    expect(body.context).toContain('Scoped semantic hit 2');
    expect(body.context).not.toContain('Keyword fallback hit');
    expect(body.count).toBe(2);
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
    expect(searchMock.mock.calls[0][0]).toMatchObject({ query: baseReq.body.q, type: 'observations', limit: '5', format: 'json' });
    expect(searchMock.mock.calls[0][0]).not.toHaveProperty('project');
    expect(searchMock.mock.calls[0][0]).not.toHaveProperty('orderBy');
    expect(body.context).toBe('');
    expect(body.count).toBe(0);
  });

  it('returns empty semantic context when fallback observations do not match project filters', async () => {
    let call = 0;
    const fallbackRows = [
      { id: 41, title: 'wrong-project', narrative: 'Wrong project', created_at: '2026-01-05T00:00:00Z', project: 'other-project' },
      { id: 42, title: 'also-wrong', narrative: 'Also wrong', created_at: '2026-01-06T00:00:00Z', project: 'other-parent', merged_into_project: 'other-project' },
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
