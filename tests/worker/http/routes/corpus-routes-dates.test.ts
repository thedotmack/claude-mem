/**
 * CorpusRoutes date-convention bridge and empty-corpus warning tests
 *
 * The MCP build_corpus tool sends dateStart/dateEnd (camelCase) while the
 * corpus filter uses date_start/date_end (snake_case). These tests pin the
 * bridge at the HTTP boundary and the warning added when a corpus is built
 * or rebuilt with 0 matching observations.
 *
 * Mock Justification:
 * - Express req/res mocks: Required because route handlers expect Express objects
 * - CorpusStore/CorpusBuilder/KnowledgeAgent: Avoids file I/O and search setup;
 *   we test the route boundary, not corpus building
 */

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
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
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

describe('CorpusRoutes date conventions and empty-corpus warning', () => {
  let handler: (req: Request, res: Response) => void;
  let mockBuild: ReturnType<typeof mock>;

  beforeEach(() => {
    mockBuild = mock((name: string, _description: string, filter: any) =>
      Promise.resolve(createCorpus(name, filter))
    );

    const routes = new CorpusRoutes(
      { list: mock(() => []), read: mock(() => null), delete: mock(() => false) } as any,
      { build: mockBuild } as any,
      {} as any
    );

    const mockApp: any = {
      get: mock(() => {}),
      delete: mock(() => {}),
      post: mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
        if (path === '/api/corpus') handler = routeHandler;
      }),
    };
    routes.setupRoutes(mockApp);
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
    mockBuild.mockImplementation((name: string, _description: string, filter: any) => {
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
