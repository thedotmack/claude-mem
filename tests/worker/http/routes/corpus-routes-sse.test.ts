import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';

const HEARTBEAT_INTERVAL_MS = 20;

function createCorpus(name: string) {
  return {
    version: 1 as const,
    name,
    description: 'A corpus',
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    filter: {},
    stats: { observation_count: 3, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
    system_prompt: '',
    session_id: 'sess-old' as string | null,
    observations: [],
  };
}

/** Minimal Express-like response: records status, headers, writes, json and end; emits 'close'. */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  writes: string[] = [];
  jsonBodies: unknown[] = [];
  ended = false;
  headersSent = false;
  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  write(chunk: string) { this.headersSent = true; this.writes.push(chunk); return true; }
  json(body: unknown) { this.headersSent = true; this.jsonBodies.push(body); this.ended = true; return this; }
  end() { this.headersSent = true; this.ended = true; return this; }
  pings(): number { return this.writes.filter((w) => w === ': ping\n\n').length; }
  terminalEvents(): Array<{ event: string; data: any }> {
    return this.writes
      .filter((w) => w.startsWith('event: '))
      .map((w) => {
        const [eventLine, dataLine] = w.split('\n');
        return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
      });
  }
}

function createRequest(name: string, accept: string | undefined, body: any = {}) {
  const socket = new EventEmitter();
  const req = {
    body,
    params: { name },
    path: `/api/corpus/${name}/prime`,
    query: {},
    headers: accept ? { accept } : {},
    socket,
  } as unknown as Request;
  return { req, socket };
}

function captureHandler(routes: CorpusRoutes, targetPath: string): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock(() => {}),
    delete: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path === targetPath) handler = rest[rest.length - 1];
    }),
  };
  routes.setupRoutes(mockApp);
  if (!handler) throw new Error(`${targetPath} not registered`);
  return handler;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

/** A prime that resolves after `durationMs`, or rejects as soon as its abortController fires. */
function createAbortablePrime(durationMs: number) {
  const seen: { abortController?: AbortController } = {};
  const prime = mock((corpus: any, callOptions: { abortController?: AbortController }) => {
    seen.abortController = callOptions.abortController;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve('sess-new'), durationMs);
      callOptions.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Claude Code process aborted by user'));
      }, { once: true });
    });
  });
  return { prime, seen };
}

function createRoutes(knowledgeAgent: any, corpus: any = createCorpus('alpha')) {
  return new CorpusRoutes(
    { read: mock(() => corpus), write: mock(() => {}), list: mock(() => [{ name: 'alpha' }]), delete: mock(() => false) } as any,
    { build: mock(() => Promise.resolve(corpus)) } as any,
    knowledgeAgent,
    { sseHeartbeatIntervalMs: HEARTBEAT_INTERVAL_MS }
  );
}

describe('CorpusRoutes SSE mode (Accept: text/event-stream)', () => {
  it('opens the stream at once, pings while priming, then sends one result event with the JSON-mode body', async () => {
    const { prime } = createAbortablePrime(HEARTBEAT_INTERVAL_MS * 6);
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req } = createRequest('alpha', 'text/event-stream');
    const res = new FakeResponse();

    handler(req, res as unknown as Response);

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.pings()).toBe(1); // immediate ping flushes headers

    await waitFor(() => res.ended);

    expect(res.pings()).toBeGreaterThanOrEqual(3);
    expect(res.terminalEvents()).toEqual([{ event: 'result', data: { session_id: 'sess-new', name: 'alpha' } }]);
    expect(res.writes[res.writes.length - 1].startsWith('event: result')).toBe(true);
    expect(res.jsonBodies).toEqual([]);

    // No heartbeat after the terminal event.
    const writesAtEnd = res.writes.length;
    await sleep(HEARTBEAT_INTERVAL_MS * 3);
    expect(res.writes.length).toBe(writesAtEnd);
  });

  it('turns a thrown error into a terminal error event carrying the HTTP status', async () => {
    const prime = mock(() => Promise.reject(new Error('Claude Code process exited with code 1')));
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req } = createRequest('alpha', 'text/event-stream');
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.terminalEvents()).toEqual([
      { event: 'error', data: { error: 'Claude Code process exited with code 1', status: 500 } },
    ]);
  });

  it('sends the 404 body as a terminal error event with status 404', async () => {
    const routes = new CorpusRoutes(
      { read: mock(() => null), write: mock(() => {}), list: mock(() => [{ name: 'beta' }]), delete: mock(() => false) } as any,
      {} as any,
      { prime: mock(() => Promise.resolve('never')) } as any,
      { sseHeartbeatIntervalMs: HEARTBEAT_INTERVAL_MS }
    );
    const handler = captureHandler(routes, '/api/corpus/:name/prime');
    const { req } = createRequest('missing', 'text/event-stream');
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.terminalEvents()).toEqual([{
      event: 'error',
      data: {
        error: 'Corpus "missing" not found',
        fix: 'Check the corpus name or build a new one',
        available: ['beta'],
        status: 404,
      },
    }]);
  });

  it('aborts the Agent SDK work when the client socket closes (Bun fires only the socket close)', async () => {
    const { prime, seen } = createAbortablePrime(60_000);
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req, socket } = createRequest('alpha', 'text/event-stream');
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => res.pings() >= 2);
    expect(seen.abortController?.signal.aborted).toBe(false);

    socket.emit('close');
    await waitFor(() => res.ended);

    expect(seen.abortController?.signal.aborted).toBe(true);
    expect(res.terminalEvents()).toEqual([]);
    const writesAtEnd = res.writes.length;
    await sleep(HEARTBEAT_INTERVAL_MS * 3);
    expect(res.writes.length).toBe(writesAtEnd);
  });

  it('aborts the query when the response closes before it settles', async () => {
    const seen: { abortController?: AbortController } = {};
    const query = mock((corpus: any, question: string, callOptions: { abortController?: AbortController }) => {
      seen.abortController = callOptions.abortController;
      return new Promise((_, reject) => {
        callOptions.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const handler = captureHandler(createRoutes({ query }), '/api/corpus/:name/query');
    const { req } = createRequest('alpha', 'text/event-stream', { question: 'why?' });
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => seen.abortController !== undefined);
    res.emit('close');
    await waitFor(() => res.ended);

    expect(query.mock.calls[0][1]).toBe('why?');
    expect(seen.abortController?.signal.aborted).toBe(true);
    expect(res.terminalEvents()).toEqual([]);
  });

  it('does not abort when the connection closes after the work settled', async () => {
    const { prime, seen } = createAbortablePrime(1);
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req, socket } = createRequest('alpha', 'text/event-stream');
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => res.ended);
    res.emit('close');
    socket.emit('close');

    expect(seen.abortController?.signal.aborted).toBe(false);
    expect(socket.listenerCount('close')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });
});

describe('CorpusRoutes JSON mode (no event-stream Accept)', () => {
  it('keeps the single JSON response for prime', async () => {
    const { prime } = createAbortablePrime(5);
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req } = createRequest('alpha', 'application/json');
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.writes).toEqual([]);
    expect(res.headers).toEqual({});
    expect(res.statusCode).toBe(200);
    expect(res.jsonBodies).toEqual([{ session_id: 'sess-new', name: 'alpha' }]);
  });

  it('keeps the 500 JSON error body for a thrown error', async () => {
    const prime = mock(() => Promise.reject(new Error('boom')));
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req } = createRequest('alpha', undefined);
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBodies).toEqual([{ error: 'boom' }]);
  });

  it('still aborts the work when a JSON client disconnects', async () => {
    const { prime, seen } = createAbortablePrime(60_000);
    const handler = captureHandler(createRoutes({ prime }), '/api/corpus/:name/prime');
    const { req, socket } = createRequest('alpha', undefined);
    const res = new FakeResponse();

    handler(req, res as unknown as Response);
    await waitFor(() => seen.abortController !== undefined);
    socket.emit('close');
    await waitFor(() => res.ended);

    expect(seen.abortController?.signal.aborted).toBe(true);
    expect(res.jsonBodies).toEqual([]);
  });
});
