/**
 * CorpusRoutes Type Coercion Tests
 *
 * Tests that MCP/HTTP clients sending string-encoded corpus filters are coerced
 * before CorpusBuilder assumes array and number fields.
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

    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/corpus') handler = fn;
      }),
      get: mock(() => {}),
      delete: mock(() => {}),
    };

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
});
