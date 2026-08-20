
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
    req: { body, path: '/api/corpus', params: {}, query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
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

  it('accepts native array filters and numeric limit', async () => {
    const { req, res, jsonSpy } = createMockReqRes({
      name: 'native',
      types: ['decision', 'bugfix'],
      concepts: ['hooks'],
      files: ['src/a.ts'],
      limit: 10,
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith('native', '', {
      types: ['decision', 'bugfix'],
      concepts: ['hooks'],
      files: ['src/a.ts'],
      limit: 10,
    });
    expect(jsonSpy).toHaveBeenCalled();
  });

  it('coerces JSON-encoded string filters and string limit', async () => {
    const { req, res } = createMockReqRes({
      name: 'json-strings',
      types: '["decision","bugfix"]',
      concepts: '["hooks","agent"]',
      files: '["src/a.ts","src/b.ts"]',
      limit: '25',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith('json-strings', '', {
      types: ['decision', 'bugfix'],
      concepts: ['hooks', 'agent'],
      files: ['src/a.ts', 'src/b.ts'],
      limit: 25,
    });
  });

  it('coerces comma-separated filters and trims whitespace', async () => {
    const { req, res } = createMockReqRes({
      name: 'comma-strings',
      types: 'decision, bugfix',
      concepts: 'hooks, agent',
      files: 'src/a.ts, src/b.ts',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith('comma-strings', '', {
      types: ['decision', 'bugfix'],
      concepts: ['hooks', 'agent'],
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('rejects invalid array items before calling CorpusBuilder', async () => {
    const { req, res, statusSpy } = createMockReqRes({
      name: 'bad-array',
      concepts: ['hooks', 42],
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('rejects unsupported corpus types before calling CorpusBuilder', async () => {
    const { req, res, statusSpy } = createMockReqRes({
      name: 'bad-type',
      types: ['typo'],
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('rejects invalid limit before calling CorpusBuilder', async () => {
    const { req, res, statusSpy } = createMockReqRes({
      name: 'bad-limit',
      limit: 'many',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('rejects a corpus name with illegal characters before calling CorpusBuilder', async () => {
    const { req, res, statusSpy } = createMockReqRes({
      name: 'bad name/with spaces',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('rejects a padded corpus name instead of silently trimming it', async () => {
    const { req, res, statusSpy } = createMockReqRes({
      name: '  bad  ',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('accepts camelCase dateStart/dateEnd and maps them to the snake_case filter', async () => {
    const { req, res } = createMockReqRes({
      name: 'camel-dates',
      dateStart: '2026-07-31',
      dateEnd: '2026-08-01',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith('camel-dates', '', {
      date_start: '2026-07-31',
      date_end: '2026-08-01',
    });
  });

  it('prefers snake_case date_start when both conventions are sent', async () => {
    const { req, res } = createMockReqRes({
      name: 'snake-dates',
      date_start: '2026-01-01',
      dateStart: '2026-07-31',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith('snake-dates', '', {
      date_start: '2026-01-01',
    });
  });

  it('adds a warning when the built corpus matched 0 observations', async () => {
    const { req, res, jsonSpy } = createMockReqRes({
      name: 'empty-corpus',
      dateStart: '2099-01-01',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    const payload = jsonSpy.mock.calls[0][0] as { warning?: string; observations?: unknown };
    expect(payload.warning).toContain('0 observations');
    expect(payload.observations).toBeUndefined();
  });

  it('omits the warning when observations matched', async () => {
    mockBuild.mockImplementation((name: string, _description: string, filter: unknown) => {
      const corpus = createCorpus(name, filter);
      corpus.stats.observation_count = 3;
      return Promise.resolve(corpus);
    });

    const { req, res, jsonSpy } = createMockReqRes({
      name: 'non-empty-corpus',
      query: 'hooks',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    const payload = jsonSpy.mock.calls[0][0] as { warning?: string };
    expect(payload.warning).toBeUndefined();
  });
});
