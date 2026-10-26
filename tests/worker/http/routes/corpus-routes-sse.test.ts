import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';
import { KnowledgeAgent } from '../../../../src/services/worker/knowledge/KnowledgeAgent.js';
import { _internals as claudeResolver, resetClaudeExecutableCache } from '../../../../src/shared/find-claude-executable.js';
import { logger } from '../../../../src/utils/logger.js';

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

describe('CorpusRoutes query on a corpus that was never primed', () => {
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

  function unprimedQueryHandler() {
    const routes = createRoutes(new KnowledgeAgent({} as any), { ...createCorpus('alpha'), session_id: null });
    return captureHandler(routes, '/api/corpus/:name/query');
  }

  it('answers 409 CORPUS_NOT_PRIMED in JSON mode and sends nothing to the error sink', async () => {
    const { req } = createRequest('alpha', undefined, { question: 'why?' });
    const res = new FakeResponse();

    unprimedQueryHandler()(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.statusCode).toBe(409);
    expect(res.jsonBodies).toEqual([{ error: 'Corpus "alpha" has no session — call prime first', code: 'CORPUS_NOT_PRIMED' }]);
    // `logger` is one object for the whole single-process suite, so the spy also
    // sees warnings from timers and promises earlier files left running. CI hit
    // that: a second, unrelated warn landed inside this test's few milliseconds
    // ("Expected number of calls: 1, Received: 2") on some file orders only.
    // Count the warnings THIS rejection produced, not every warn in the process.
    const rejectionWarnings = warnSpy.mock.calls.filter(([, , context]) =>
      (context as { statusCode?: number } | undefined)?.statusCode === 409);
    expect(rejectionWarnings).toEqual([['WORKER', 'Request rejected', { statusCode: 409 }, expect.any(Error)]]);
    expect(errorSink).not.toHaveBeenCalled();
  });

  it('sends a 409 error event in SSE mode and nothing to the error sink', async () => {
    const { req } = createRequest('alpha', 'text/event-stream', { question: 'why?' });
    const res = new FakeResponse();

    unprimedQueryHandler()(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.terminalEvents()).toEqual([{
      event: 'error',
      data: { error: 'Corpus "alpha" has no session — call prime first', code: 'CORPUS_NOT_PRIMED', status: 409 },
    }]);
    expect(errorSink).not.toHaveBeenCalled();
  });
});

describe('CorpusRoutes when every Claude CLI is too old', () => {
  const originalResolver = { ...claudeResolver };
  let errorSink: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetClaudeExecutableCache();
    Object.assign(claudeResolver, {
      platform: () => 'linux',
      loadSettings: () => ({}),
      execSync: () => '/old/claude\n',
      existsSync: () => false,
      realpathSync: (path: string) => path,
      execFileSync: (_file: string, args: string[]) => {
        if (args.includes('dontAsk')) {
          throw Object.assign(new Error('Command failed'), { status: 1, stderr: "error: argument 'dontAsk' is invalid" });
        }
        return '1.0.0 (Claude Code)';
      },
    });
    errorSink = mock(() => {});
    logger.setErrorSink(errorSink);
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.assign(claudeResolver, originalResolver);
    resetClaudeExecutableCache();
    logger.setErrorSink(null);
    warnSpy.mockRestore();
  });

  function handlerFor(path: string) {
    return captureHandler(createRoutes(new KnowledgeAgent({} as any)), path);
  }

  it('answers prime with 424 CLAUDE_CLI_SETUP_REQUIRED in JSON mode and sends nothing to the error sink', async () => {
    const { req } = createRequest('alpha', undefined);
    const res = new FakeResponse();

    handlerFor('/api/corpus/:name/prime')(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.statusCode).toBe(424);
    expect(res.jsonBodies).toHaveLength(1);
    expect(res.jsonBodies[0]).toMatchObject({ code: 'CLAUDE_CLI_SETUP_REQUIRED' });
    expect((res.jsonBodies[0] as { error: string }).error).toContain('Every Claude CLI found is too old');
    expect(warnSpy).toHaveBeenCalledWith('WORKER', 'Request rejected', { statusCode: 424 }, expect.any(Error));
    expect(errorSink).not.toHaveBeenCalled();
  });

  it('sends prime a 424 error event in SSE mode and nothing to the error sink', async () => {
    const { req } = createRequest('alpha', 'text/event-stream');
    const res = new FakeResponse();

    handlerFor('/api/corpus/:name/prime')(req, res as unknown as Response);
    await waitFor(() => res.ended);

    const events = res.terminalEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    expect(events[0].data).toMatchObject({ code: 'CLAUDE_CLI_SETUP_REQUIRED', status: 424 });
    expect(errorSink).not.toHaveBeenCalled();
  });

  it('answers query with 424 in JSON mode and sends nothing to the error sink', async () => {
    const { req } = createRequest('alpha', undefined, { question: 'why?' });
    const res = new FakeResponse();

    handlerFor('/api/corpus/:name/query')(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.statusCode).toBe(424);
    expect(res.jsonBodies[0]).toMatchObject({ code: 'CLAUDE_CLI_SETUP_REQUIRED' });
    expect(errorSink).not.toHaveBeenCalled();
  });

  it('keeps an unspawnable CLI a 500 that reaches the error sink (a worker restart fixes it)', async () => {
    // The file is on disk but the OS cannot launch it: no exit status, no signal.
    Object.assign(claudeResolver, {
      existsSync: () => true,
      execFileSync: () => {
        throw Object.assign(new Error('spawn /stale/claude ENOENT'), { code: 'ENOENT' });
      },
    });
    const { req } = createRequest('alpha', undefined);
    const res = new FakeResponse();

    handlerFor('/api/corpus/:name/prime')(req, res as unknown as Response);
    await waitFor(() => res.ended);

    expect(res.statusCode).toBe(500);
    expect((res.jsonBodies[0] as { error: string }).error).toContain('could not be spawned');
    expect(res.jsonBodies[0]).not.toHaveProperty('code');
    expect(errorSink).toHaveBeenCalledTimes(1);
  });
});
