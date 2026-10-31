import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { AdvisorRoutes } from '../../../../src/services/worker/http/routes/AdvisorRoutes.js';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';
import { DedupRoutes } from '../../../../src/services/worker/http/routes/DedupRoutes.js';
import { WorkStateRoutes } from '../../../../src/services/worker/http/routes/WorkStateRoutes.js';

function createMockRes(): {
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  const res: Partial<Response> = { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>;
  (res as any).send = mock(() => res);
  (res as any).setHeader = mock(() => res);
  (res as any).end = mock(() => undefined);
  // runLongCorpusWork subscribes to close events on both the response and the
  // client socket; the fake response needs EventEmitter-shaped methods.
  (res as any).on = mock(() => res);
  (res as any).off = mock(() => res);
  return { res, jsonSpy, statusSpy };
}

function createSocket() {
  return { on: mock(() => undefined), off: mock(() => undefined) };
}

/** Lets the async corpus handlers reach their JSON response before assertions. */
async function flushAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Mounts the route class on a fake express app and returns its last handler for a path. */
function captureHandler(
  routes: { setupRoutes: (app: any) => void },
  method: 'post' | 'get' | 'delete',
  path: string,
): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((p: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (p === path) handler = handlers[handlers.length - 1];
    }),
    delete: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  if (!handler) throw new Error(`route ${method.toUpperCase()} ${path} was not registered`);
  return (req: Request, res: Response): void => handler(req, res);
}

function stubStore(overrides: Record<string, any> = {}) {
  const getSessionStore = mock(() => ({
    isDedupEnabled: () => true,
    resolveDedupCandidate: () => true,
    appendWorkStateEntry: mock(() => 1),
    getWorkStateEntries: () => [],
    ...overrides,
  }));
  return {
    dbManager: {
      getSessionStore,
      getCloudSync: () => null,
    } as any,
    getSessionStore,
  };
}

describe('POST /api/work-state/entries origin guard', () => {
  it('rejects a write from a different localhost origin before touching the store', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new WorkStateRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/work-state/entries');

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler(
      {
        body: { cwd: '/tmp/proj', list: 'release', fields: { task: 'ship it' } },
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
      } as unknown as Request,
      res as Response,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('origin') }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  it('allows an Origin-less write and a same-port browser write past the guard', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new WorkStateRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/work-state/entries');

    const originless = createMockRes();
    handler(
      { body: { cwd: '/tmp/proj', list: 'release', fields: { task: 'ship it' } }, headers: {} } as unknown as Request,
      originless.res as Response,
    );
    expect(statusSpyNot403(originless.statusSpy)).toBe(true);
    expect(getSessionStore).toHaveBeenCalledTimes(1);

    const samePort = createMockRes();
    handler(
      {
        body: { cwd: '/tmp/proj', list: 'release', fields: { task: 'ship it' } },
        headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
      } as unknown as Request,
      samePort.res as Response,
    );
    expect(statusSpyNot403(samePort.statusSpy)).toBe(true);
    expect(getSessionStore).toHaveBeenCalledTimes(2);
  });
});

function statusSpyNot403(spy: ReturnType<typeof mock>): boolean {
  return !spy.mock.calls.some((args: any[]) => args[0] === 403);
}

describe('POST /api/dedup/candidates/:id/resolve origin guard', () => {
  it('rejects a resolve from a different localhost origin before touching the store', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new DedupRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/dedup/candidates/:id/resolve');

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler(
      {
        params: { id: '7' },
        body: { status: 'distinct' },
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
      } as unknown as Request,
      res as Response,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('origin') }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  it('allows an Origin-less resolve past the guard', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new DedupRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/dedup/candidates/:id/resolve');

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler(
      { params: { id: '7' }, body: { status: 'distinct' }, headers: {} } as unknown as Request,
      res as Response,
    );
    expect(statusSpyNot403(statusSpy)).toBe(true);
    expect(getSessionStore).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ candidate: { id: 7, status: 'distinct' } }));
  });

  it('allows a same-port browser resolve and records the verdict', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new DedupRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/dedup/candidates/:id/resolve');

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler(
      {
        params: { id: '7' },
        body: { status: 'distinct' },
        headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
      } as unknown as Request,
      res as Response,
    );
    expect(statusSpyNot403(statusSpy)).toBe(true);
    expect(getSessionStore).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ candidate: { id: 7, status: 'distinct' } }));
  });
});

describe('POST /api/dedup/scan origin guard', () => {
  const scanResult = [{ project: 'acme', candidates: 3 }];

  it('rejects a scan from a different localhost origin before touching the store', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new DedupRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/dedup/scan');

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler(
      { body: {}, headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' } } as unknown as Request,
      res as Response,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('origin') }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  for (const [label, headers] of [
    ['an Origin-less scan', {}],
    ['a same-port browser scan', { origin: 'http://localhost:37777', host: '127.0.0.1:37777' }],
  ] as const) {
    it(`allows ${label} and runs the scan`, () => {
      const { dbManager, getSessionStore } = stubStore({ runDedupScan: () => scanResult });
      const routes = new DedupRoutes(dbManager);
      const handler = captureHandler(routes, 'post', '/api/dedup/scan');

      const { res, statusSpy, jsonSpy } = createMockRes();
      handler({ body: {}, headers } as unknown as Request, res as Response);

      expect(statusSpyNot403(statusSpy)).toBe(true);
      // isDedupEnabled + runDedupScan: both store reads prove the guard let
      // the request all the way through to the scan.
      expect(getSessionStore).toHaveBeenCalledTimes(2);
      expect(jsonSpy).toHaveBeenCalledWith({ scanned: scanResult });
    });
  }
});

describe('POST /api/corpus* origin guard', () => {
  // The registered express paths (with :name), not concrete URLs — the fake app
  // matches the registration string.
  const endpoints = [
    ['/api/corpus', { name: 'acme', types: ['feature'] }],
    ['/api/corpus/:name/rebuild', {}],
    ['/api/corpus/:name/prime', {}],
    ['/api/corpus/:name/query', { question: 'what changed?' }],
    ['/api/corpus/:name/reprime', {}],
  ] as const;

  for (const [path, body] of endpoints) {
    it(`rejects ${path} from a different localhost origin`, () => {
      const routes = new CorpusRoutes(
        { list: mock(() => []), read: mock(() => null), write: mock(() => {}) } as any,
        { build: mock(() => { throw new Error('the corpus work must not start'); }) } as any,
        { query: mock(() => { throw new Error('the corpus query must not start'); }) } as any,
      );
      const handler = captureHandler(routes, 'post', path);

      const { res, statusSpy, jsonSpy } = createMockRes();
      handler(
        {
          params: { name: 'acme' },
          body,
          headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
        } as unknown as Request,
        res as Response,
      );

      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('origin') }));
    });
  }

  const passThroughOrigins = [
    ['an Origin-less request', {}],
    ['a same-port browser request', { origin: 'http://localhost:37777', host: '127.0.0.1:37777' }],
  ] as const;

  it('allows Origin-less and same-port build requests and runs the builder', async () => {
    const build = mock(async () => ({ observations: [], name: 'acme', stats: { observation_count: 0 } }));
    const routes = new CorpusRoutes(
      { list: mock(() => []), read: mock(() => null), write: mock(() => {}) } as any,
      { build } as any,
      {} as any,
    );
    const handler = captureHandler(routes, 'post', '/api/corpus');

    for (const [, headers] of passThroughOrigins) {
      const { res, statusSpy, jsonSpy } = createMockRes();
      handler(
        {
          body: { name: 'acme', types: ['feature'] },
          headers,
          socket: createSocket(),
        } as unknown as Request,
        res as Response,
      );
      await flushAsync();
      expect(statusSpyNot403(statusSpy)).toBe(true);
      expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'acme' }));
    }
    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenLastCalledWith('acme', '', expect.objectContaining({ types: ['feature'] }));
  });

  for (const [path, body] of endpoints.slice(1)) {
    it(`allows Origin-less and same-port ${path} requests and reads the corpus`, async () => {
      const read = mock(() => null);
      const routes = new CorpusRoutes(
        { list: mock(() => []), read, write: mock(() => {}) } as any,
        { build: mock(async () => { throw new Error('the corpus work must not start'); }) } as any,
        { query: mock(async () => { throw new Error('the corpus query must not start'); }) } as any,
      );
      const handler = captureHandler(routes, 'post', path);

      for (const [, headers] of passThroughOrigins) {
        const { res, statusSpy, jsonSpy } = createMockRes();
        handler(
          {
            params: { name: 'acme' },
            body,
            headers,
            socket: createSocket(),
          } as unknown as Request,
          res as Response,
        );
        await flushAsync();
        expect(statusSpyNot403(statusSpy)).toBe(true);
        // A missing corpus answers 404 after the store is read — the guard let
        // the request through and the handler did its own work.
        expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('not found') }));
      }
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenLastCalledWith('acme');
    });
  }
});

describe('POST /api/advisor-calls origin guard', () => {
  const ingestBody = { contentSessionId: 's1', calls: [{ toolUseId: 't1', advice: 'x', occurredAtEpoch: 1 }] };

  it('rejects an ingest from a different localhost origin before the ingest runs', () => {
    const { dbManager, getSessionStore } = stubStore();
    const routes = new AdvisorRoutes(dbManager);
    const handler = captureHandler(routes, 'post', '/api/advisor-calls');

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler(
      {
        body: ingestBody,
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
      } as unknown as Request,
      res as Response,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('origin') }));
    expect(getSessionStore).not.toHaveBeenCalled();
  });

  for (const [label, headers] of [
    ['an Origin-less ingest', {}],
    ['a same-port browser ingest', { origin: 'http://localhost:37777', host: '127.0.0.1:37777' }],
  ] as const) {
    it(`allows ${label} and records the calls`, () => {
      const { dbManager, getSessionStore } = stubStore({
        createSDKSession: () => 42,
        recordAdvisorCall: () => ({ inserted: true }),
      });
      const routes = new AdvisorRoutes(dbManager);
      const handler = captureHandler(routes, 'post', '/api/advisor-calls');

      const { res, statusSpy, jsonSpy } = createMockRes();
      handler({ body: ingestBody, headers, query: {} } as unknown as Request, res as Response);

      expect(statusSpyNot403(statusSpy)).toBe(true);
      expect(getSessionStore).toHaveBeenCalledTimes(1);
      expect(jsonSpy).toHaveBeenCalledWith({ status: 'stored', stored: 1, duplicates: 0, privateOnly: 0 });
    });
  }
});
