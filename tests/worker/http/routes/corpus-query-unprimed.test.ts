import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';
import { KnowledgeAgent } from '../../../../src/services/worker/knowledge/KnowledgeAgent.js';

function createUnprimedCorpus(name: string) {
  return {
    version: 1 as const,
    name,
    description: 'A corpus',
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    filter: {},
    stats: { observation_count: 3, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
    system_prompt: '',
    session_id: null,
    observations: [],
  };
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  writes: string[] = [];
  jsonBodies: any[] = [];
  ended = false;
  headersSent = false;
  status(code: number) { this.statusCode = code; return this; }
  setHeader() {}
  write(chunk: string) { this.headersSent = true; this.writes.push(chunk); return true; }
  json(body: unknown) { this.headersSent = true; this.jsonBodies.push(body); this.ended = true; return this; }
  end() { this.headersSent = true; this.ended = true; return this; }
}

function createRequest(name: string, accept?: string) {
  return {
    body: { question: 'What changed?' },
    params: { name },
    path: `/api/corpus/${name}/query`,
    query: {},
    headers: accept ? { accept } : {},
    socket: new EventEmitter(),
  } as unknown as Request;
}

function captureQueryHandler(): (req: Request, res: Response) => void {
  const corpusStore = {
    read: mock(() => createUnprimedCorpus('alpha')),
    write: mock(() => {}),
    list: mock(() => []),
    delete: mock(() => false),
  } as any;
  const routes = new CorpusRoutes(corpusStore, {} as any, new KnowledgeAgent(corpusStore));
  let handler: ((req: Request, res: Response) => void) | undefined;
  routes.setupRoutes({
    get: mock(() => {}),
    delete: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path === '/api/corpus/:name/query') handler = rest[rest.length - 1];
    }),
  } as any);
  if (!handler) throw new Error('/api/corpus/:name/query not registered');
  return handler;
}

async function waitForEnd(res: FakeResponse): Promise<void> {
  const startedAt = Date.now();
  while (!res.ended) {
    if (Date.now() - startedAt > 2000) throw new Error('response never ended');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('POST /api/corpus/:name/query on a corpus that was never primed', () => {
  let errorSink: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSink = mock(() => {});
    logger.setErrorSink(errorSink);
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logger.setErrorSink(null);
    warnSpy.mockRestore();
  });

  it('answers 409 CORPUS_NOT_PRIMED and sends nothing to the error sink', async () => {
    const res = new FakeResponse();
    captureQueryHandler()(createRequest('alpha'), res as unknown as Response);
    await waitForEnd(res);

    expect(res.statusCode).toBe(409);
    expect(res.jsonBodies).toEqual([{ error: 'Corpus "alpha" has no session — call prime first', code: 'CORPUS_NOT_PRIMED' }]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSink).not.toHaveBeenCalled();
  });

  it('sends a 409 error event in SSE mode and nothing to the error sink', async () => {
    const res = new FakeResponse();
    captureQueryHandler()(createRequest('alpha', 'text/event-stream'), res as unknown as Response);
    await waitForEnd(res);

    const errorEvent = res.writes.find((chunk) => chunk.startsWith('event: error'));
    expect(errorEvent).toBeDefined();
    expect(JSON.parse(errorEvent!.split('\n')[1].slice('data: '.length))).toMatchObject({ status: 409, code: 'CORPUS_NOT_PRIMED' });
    expect(errorSink).not.toHaveBeenCalled();
  });
});
