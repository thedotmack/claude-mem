import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { EatPipelineResult } from '../../src/services/worker/eat/types.js';

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so this pipeline stub would otherwise leak
// into other test files in the same `bun test` run.
import * as realPipeline from '../../src/services/worker/eat/pipeline.js';
const realPipelineSnapshot = { ...realPipeline };

const pipelineCalls: Array<{ input: string | undefined; opts: Record<string, unknown> }> = [];
let pipelineResult: EatPipelineResult;

mock.module('../../src/services/worker/eat/pipeline.js', () => ({
  runEatPipeline: async (input: string | undefined, opts: Record<string, unknown> = {}) => {
    pipelineCalls.push({ input, opts });
    return pipelineResult;
  },
}));

afterAll(() => {
  mock.module('../../src/services/worker/eat/pipeline.js', () => realPipelineSnapshot);
});

import { EatRoutes } from '../../src/services/worker/http/routes/EatRoutes.js';

function captureRoute(routes: EatRoutes): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const register = mock((path: string, ...rest: any[]) => {
    if (path !== '/api/eat') return;
    middleware = rest[0];
    handler = rest[1];
  });
  const app = { post: register } as any;

  routes.setupRoutes(app);
  if (!middleware || !handler) throw new Error('Handler not registered for POST /api/eat');

  return (req: Request, res: Response): void => {
    let nextCalled = false;
    middleware!(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

function makeResponse(): { res: Response; getStatus: () => number; getJson: () => any; waitForJson: () => Promise<any> } {
  let statusCode = 200;
  let jsonPayload: any;
  let resolveJson: (value: any) => void;
  const jsonPromise = new Promise<any>(resolve => { resolveJson = resolve; });
  const res = {
    headersSent: false,
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: any) => {
      jsonPayload = payload;
      resolveJson(payload);
      return res;
    },
  } as any;
  return {
    res: res as Response,
    getStatus: () => statusCode,
    getJson: () => jsonPayload,
    waitForJson: () => jsonPromise,
  };
}

function makeRequest(body: Record<string, unknown>): Request {
  return { path: '/api/eat', body } as any;
}

const draft = {
  type: 'discovery',
  title: 'Bun ships S3',
  subtitle: 'Native S3 client',
  facts: ['Bun 1.2 shipped native S3 support'],
  narrative: 'Bun 1.2 shipped native S3 support in the runtime.',
  concepts: ['bun'],
};

describe('EatRoutes POST /api/eat', () => {
  let store: SessionStore;
  let handler: (req: Request, res: Response) => void;
  let sessionStoreCalls: number;

  beforeEach(() => {
    pipelineCalls.length = 0;
    pipelineResult = {
      source: { kind: 'text', locator: 'Bun 1.2 shipped native S3 support' },
      chunks: 1,
      drafts: [draft],
      rejected: 0,
      model: 'anthropic/claude-haiku-4.5',
    };
    store = new SessionStore(':memory:');
    sessionStoreCalls = 0;
    const dbManager = {
      getSessionStore: () => {
        sessionStoreCalls++;
        return store;
      },
      getChromaSync: () => null,
      getCloudSync: () => null,
    } as any;
    handler = captureRoute(new EatRoutes(dbManager));
  });

  afterEach(() => {
    store.close();
  });

  it('rejects when neither input nor content is present', async () => {
    const response = makeResponse();
    handler(makeRequest({ project: 'claude-mem' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(pipelineCalls.length).toBe(0);
  });

  it('rejects when both input and content are present', async () => {
    const response = makeResponse();
    handler(makeRequest({ input: 'README.md', content: 'raw text', project: 'claude-mem' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(pipelineCalls.length).toBe(0);
  });

  it('rejects unknown keys via the strict schema', async () => {
    const response = makeResponse();
    handler(makeRequest({ content: 'raw text', project: 'claude-mem', mode: 'auto' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(400);
    expect(body.error).toBe('ValidationError');
    expect(pipelineCalls.length).toBe(0);
  });

  it('rejects a missing project via the schema', async () => {
    const response = makeResponse();
    handler(makeRequest({ content: 'raw text' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(400);
    expect(body.error).toBe('ValidationError');
    expect(pipelineCalls.length).toBe(0);
  });

  it('rejects a payload over 8 MB with payload_too_large', async () => {
    const response = makeResponse();
    handler(makeRequest({ content: 'x'.repeat(8 * 1024 * 1024 + 1), project: 'claude-mem' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(413);
    expect(body.error).toBe('payload_too_large');
    expect(pipelineCalls.length).toBe(0);
  });

  it('rejects when both content and mcp are present', async () => {
    const response = makeResponse();
    handler(makeRequest({ content: 'raw text', mcp: { url: 'https://mcp.example.com/mcp' }, project: 'claude-mem' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(pipelineCalls.length).toBe(0);
  });

  it('accepts mcp alone and forwards the config to the pipeline', async () => {
    pipelineResult = { ...pipelineResult, source: { kind: 'mcp', locator: 'https://mcp.example.com/mcp' } };
    const mcp = { url: 'https://mcp.example.com/mcp', resource: 'doc://readme', headers: { Authorization: 'Bearer token' } };
    const response = makeResponse();
    handler(makeRequest({ mcp, project: 'claude-mem', dry_run: true }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(200);
    expect(body.request_id).toBeString();
    expect(pipelineCalls.length).toBe(1);
    expect(pipelineCalls[0].input).toBeUndefined();
    expect(pipelineCalls[0].opts.mcp).toEqual(mcp);
  });

  it('accepts input alone and accepts content alone', async () => {
    const inputResponse = makeResponse();
    handler(makeRequest({ input: 'Bun 1.2 shipped native S3 support', project: 'claude-mem', dry_run: true }), inputResponse.res);
    expect((await inputResponse.waitForJson()).request_id).toBeString();

    const contentResponse = makeResponse();
    handler(makeRequest({ content: 'Bun 1.2 shipped native S3 support', project: 'claude-mem', dry_run: true }), contentResponse.res);
    expect((await contentResponse.waitForJson()).request_id).toBeString();
    expect(pipelineCalls.length).toBe(2);
    expect(pipelineCalls[1].opts.content).toBe('Bun 1.2 shipped native S3 support');
  });

  it('dry_run returns drafts and empty observation_ids without touching storage', async () => {
    const response = makeResponse();
    handler(makeRequest({ content: 'Bun 1.2 shipped native S3 support', project: 'claude-mem', dry_run: true }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(200);
    expect(body.request_id).toBeString();
    expect(body.source).toEqual(pipelineResult.source);
    expect(body.chunks).toBe(1);
    expect(body.observation_ids).toEqual([]);
    expect(body.drafts).toEqual([draft]);
    expect(body.rejected).toBe(0);
    expect(sessionStoreCalls).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) as count FROM observations').get()).toEqual({ count: 0 });
  });

  it('stores drafts as observations when dry_run is absent', async () => {
    pipelineResult = { ...pipelineResult, source: { kind: 'file', locator: '/tmp/readme.md' } };
    const response = makeResponse();
    handler(makeRequest({ input: '/tmp/readme.md', project: 'claude-mem' }), response.res);
    const body = await response.waitForJson();
    expect(response.getStatus()).toBe(200);
    expect(body.observation_ids.length).toBe(1);
    expect(body.drafts).toBeUndefined();

    const row = store.db.prepare('SELECT type, title, files_read, metadata, generated_by_model FROM observations WHERE id = ?').get(body.observation_ids[0]) as any;
    expect(row.type).toBe('discovery');
    expect(row.title).toBe(draft.title);
    expect(JSON.parse(row.files_read)).toEqual(['/tmp/readme.md']);
    expect(JSON.parse(row.metadata)).toEqual({ eat: true, source: { kind: 'file', locator: '/tmp/readme.md' } });
    expect(row.generated_by_model).toBe('anthropic/claude-haiku-4.5');
  });
});
