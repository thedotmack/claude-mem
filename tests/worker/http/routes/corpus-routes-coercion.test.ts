
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Request, Response } from 'express';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';

function createMockReqRes(body: any): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/api/corpus', params: {}, query: {}, headers: {}, socket: { on: mock(() => {}), off: mock(() => {}) } } as unknown as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy, headersSent: false, on: mock(() => {}), off: mock(() => {}), end: mock(() => {}) } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function createCorpus(name: string, filter: any) {
  return {
    version: 1 as const,
    name,
    description: '',
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    filter,
    stats: {
      observation_count: 0,
      token_estimate: 0,
      date_range: { earliest: '', latest: '' },
      type_breakdown: {},
    },
    system_prompt: '',
    session_id: null,
    observations: [],
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function captureChain(mockApp: any, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: (req: Request, res: Response) => void;
  mockApp.post = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) handler(req, res);
  };
}

describe('CorpusRoutes Type Coercion', () => {
  let handler: (req: Request, res: Response) => void;
  let mockBuild: ReturnType<typeof mock>;

  beforeEach(() => {
    mockBuild = mock((name: string, description: string, filter: any) => Promise.resolve(createCorpus(name, filter)));

    const routes = new CorpusRoutes(
      { list: mock(() => []), read: mock(() => null), delete: mock(() => false) } as any,
      { build: mockBuild } as any,
      {} as any
    );

    const mockApp: any = {
      get: mock(() => {}),
      delete: mock(() => {}),
    };
    handler = captureChain(mockApp, '/api/corpus');
    routes.setupRoutes(mockApp as any);
  });

  it.each<[Record<string, unknown>, Record<string, unknown>]>([
    [{ name: 'native', types: ['decision', 'bugfix'], concepts: ['hooks'], files: ['src/a.ts'], limit: 10 },
      { types: ['decision', 'bugfix'], concepts: ['hooks'], files: ['src/a.ts'], limit: 10 }],
    [{ name: 'json-strings', types: '["decision","bugfix"]', concepts: '["hooks","agent"]', files: '["src/a.ts","src/b.ts"]', limit: '25' },
      { types: ['decision', 'bugfix'], concepts: ['hooks', 'agent'], files: ['src/a.ts', 'src/b.ts'], limit: 25 }],
    [{ name: 'camel-dates', dateStart: '2025-01-01', dateEnd: '2025-03-01' },
      { date_start: '2025-01-01', date_end: '2025-03-01' }],
    [{ name: 'snake-dates', date_start: '2025-01-01', date_end: '2025-03-01' },
      { date_start: '2025-01-01', date_end: '2025-03-01' }],
    [{ name: 'comma-strings', types: 'decision, bugfix', concepts: 'hooks, agent', files: 'src/a.ts, src/b.ts' },
      { types: ['decision', 'bugfix'], concepts: ['hooks', 'agent'], files: ['src/a.ts', 'src/b.ts'] }],
  ])('coerces the filter in %j', async (body, expectedFilter) => {
    const { req, res, jsonSpy } = createMockReqRes(body);
    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith(body.name, '', expectedFilter);
    expect(jsonSpy).toHaveBeenCalled();
  });

  it.each([
    { name: 'bad-array', concepts: ['hooks', 42] },
    { name: 'bad-type', types: ['typo'] },
    { name: 'bad-limit', limit: 'many' },
    { name: 'bad name/with spaces' },
    { name: '  bad  ' },
  ])('rejects %j before calling CorpusBuilder', async (body) => {
    const { req, res, statusSpy } = createMockReqRes(body);
    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it.each([
    ['dateStart', 'not-a-date'],
    ['date_start', 'not-a-date'],
    ['dateEnd', '2025-13-45'],
    ['date_end', 'yesterday-ish'],
  ])('rejects an unparseable %s with 400 INVALID_DATE before calling CorpusBuilder', async (key, value) => {
    const { req, res, statusSpy, jsonSpy } = createMockReqRes({ name: 'bad-date', [key]: value });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_DATE' }));
    expect(mockBuild).not.toHaveBeenCalled();
  });

});
