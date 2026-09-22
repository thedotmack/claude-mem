import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Request, Response } from 'express';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';

function createCorpus(name: string, observationCount: number, filter: any = {}) {
  return {
    version: 1 as const,
    name,
    description: 'A corpus',
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    filter,
    stats: {
      observation_count: observationCount,
      token_estimate: 0,
      date_range: { earliest: '', latest: '' },
      type_breakdown: {},
    },
    system_prompt: '',
    session_id: null,
    observations: [],
  };
}

function createMockReqRes(name: string, body: any) {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, params: { name }, path: `/api/corpus/${name}/rebuild`, query: {} } as unknown as Request,
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Response,
    jsonSpy,
    statusSpy,
  };
}

function captureRebuildHandler(routes: CorpusRoutes): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock(() => {}),
    delete: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path === '/api/corpus/:name/rebuild') handler = rest[rest.length - 1];
    }),
  };
  routes.setupRoutes(mockApp);
  if (!handler) throw new Error('rebuild handler not registered');
  return handler;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('rebuild_corpus shrink guard', () => {
  let read: ReturnType<typeof mock>;
  let write: ReturnType<typeof mock>;
  let build: ReturnType<typeof mock>;

  function setup(existing: any, rebuilt: any) {
    read = mock(() => existing);
    write = mock(() => undefined);
    build = mock(() => Promise.resolve(rebuilt));
    const routes = new CorpusRoutes(
      { read, write, list: mock(() => []), delete: mock(() => false) } as any,
      { build } as any,
      {} as any,
    );
    return captureRebuildHandler(routes);
  }

  it('restores the previous corpus and returns 409 on a destructive shrink', async () => {
    const existing = createCorpus('big', 74, { date_start: '2024-01-01' });
    const handler = setup(existing, createCorpus('big', 11));
    const { req, res, statusSpy, jsonSpy } = createMockReqRes('big', {});

    handler(req, res);
    await flushPromises();

    expect(statusSpy).toHaveBeenCalledWith(409);
    expect(write).toHaveBeenCalledWith(existing);
    expect(jsonSpy.mock.calls[0][0]).toMatchObject({ previous_count: 74, rebuilt_count: 11 });
  });

  it('accepts the shrink and does not restore when force is set', async () => {
    const existing = createCorpus('big', 74);
    const handler = setup(existing, createCorpus('big', 11));
    const { req, res, statusSpy } = createMockReqRes('big', { force: true });

    handler(req, res);
    await flushPromises();

    expect(statusSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('allows a routine refresh that keeps most observations', async () => {
    const existing = createCorpus('big', 74);
    const handler = setup(existing, createCorpus('big', 70));
    const { req, res, statusSpy } = createMockReqRes('big', {});

    handler(req, res);
    await flushPromises();

    expect(statusSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not trip the guard on a tiny corpus below the floor', async () => {
    const existing = createCorpus('tiny', 3);
    const handler = setup(existing, createCorpus('tiny', 0));
    const { req, res, statusSpy } = createMockReqRes('tiny', {});

    handler(req, res);
    await flushPromises();

    expect(statusSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('never runs two rebuilds of the same corpus at once', async () => {
    const existing = createCorpus('big', 74);
    read = mock(() => existing);
    write = mock(() => undefined);
    let active = 0;
    let maxActive = 0;
    build = mock(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return createCorpus('big', 74);
    });
    const routes = new CorpusRoutes(
      { read, write, list: mock(() => []), delete: mock(() => false) } as any,
      { build } as any,
      {} as any,
    );
    const handler = captureRebuildHandler(routes);

    const a = createMockReqRes('big', {});
    const b = createMockReqRes('big', {});
    handler(a.req, a.res);
    handler(b.req, b.res);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(maxActive).toBe(1);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
