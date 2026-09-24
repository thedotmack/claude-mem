
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
  let mockRead: ReturnType<typeof mock>;
  let mockBackup: ReturnType<typeof mock>;
  let mockWrite: ReturnType<typeof mock>;
  let rebuildHandler: (req: Request, res: Response) => void;

  beforeEach(() => {
    mockBuild = mock((name: string, description: string, filter: any) => Promise.resolve(createCorpus(name, filter)));
    mockRead = mock(() => null);
    mockBackup = mock(() => '/tmp/native.corpus.json.bak');
    mockWrite = mock(() => undefined);

    const routes = new CorpusRoutes(
      { list: mock(() => []), read: mockRead, delete: mock(() => false), backup: mockBackup, write: mockWrite } as any,
      { build: mockBuild } as any,
      {} as any
    );

    const buildApp: any = {
      get: mock(() => {}),
      delete: mock(() => {}),
    };
    handler = captureChain(buildApp, '/api/corpus');
    routes.setupRoutes(buildApp as any);

    const rebuildApp: any = {
      get: mock(() => {}),
      delete: mock(() => {}),
    };
    rebuildHandler = captureChain(rebuildApp, '/api/corpus/:name/rebuild');
    routes.setupRoutes(rebuildApp as any);
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

  it('accepts camelCase date filters and persists them in corpus filter format', async () => {
    const { req, res } = createMockReqRes({
      name: 'camel-dates',
      dateStart: '2025-01-01T00:00:00.000Z',
      dateEnd: '2025-01-31T23:59:59.999Z',
    });

    handler(req as Request, res as Response);
    await flushPromises();

    expect(mockBuild).toHaveBeenCalledWith('camel-dates', '', {
      date_start: '2025-01-01T00:00:00.000Z',
      date_end: '2025-01-31T23:59:59.999Z',
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

  it('backs up the previous corpus and warns when a rebuild shrinks it', async () => {
    mockRead.mockImplementation(() => createCorpus('shrinking', {
      query: 'legacy docs',
      date_start: '2025-01-01T00:00:00.000Z',
      date_end: '2025-01-31T23:59:59.999Z',
    }));
    mockBuild.mockImplementation(() => Promise.resolve({
      ...createCorpus('shrinking', {
        query: 'legacy docs',
        date_start: '2025-01-01T00:00:00.000Z',
        date_end: '2025-01-31T23:59:59.999Z',
      }),
      stats: {
        observation_count: 2,
        token_estimate: 0,
        date_range: { earliest: '', latest: '' },
        type_breakdown: {},
      },
    }));
    mockRead.mockImplementationOnce(() => ({
      ...createCorpus('shrinking', {
        query: 'legacy docs',
        date_start: '2025-01-01T00:00:00.000Z',
        date_end: '2025-01-31T23:59:59.999Z',
      }),
      stats: {
        observation_count: 5,
        token_estimate: 0,
        date_range: { earliest: '', latest: '' },
        type_breakdown: {},
      },
    }));

    const { req, res, jsonSpy } = createMockReqRes({});
    req.params = { name: 'shrinking' };

    rebuildHandler(req as Request, res as Response);
    await flushPromises();

    expect(mockBackup).toHaveBeenCalledWith('shrinking');
    expect(mockBuild).toHaveBeenCalledWith('shrinking', '', {
      query: 'legacy docs',
      date_start: '2025-01-01T00:00:00.000Z',
      date_end: '2025-01-31T23:59:59.999Z',
    }, { writeFile: false });
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({
      name: 'shrinking',
      stats: expect.objectContaining({ observation_count: 2 }),
    }));
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      backup_path: '/tmp/native.corpus.json.bak',
      warning: expect.stringContaining('shrank from 5 to 2 observations'),
    }));
  });
});
