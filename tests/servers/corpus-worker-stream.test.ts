import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  postCorpusRequestOverSse,
  CORPUS_STREAM_IDLE_TIMEOUT_MS,
  CORPUS_STREAM_ABSOLUTE_CAP_MS,
} from '../../src/servers/corpus-worker-stream.js';
import { createStreamFetchMock, trackLiveTimers, type LiveTimerTracker } from '../helpers/stream-fetch-mock.js';

// Production is idle 30 s / cap 15 min with a 10 s worker heartbeat; scaled 1000x down here.
const SCALED_TIMING = { idleTimeoutMs: 60, absoluteCapMs: 2_000 };
const PING_INTERVAL_MS = 20;
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

/** callWorker's success rendering for body requests (unchanged between JSON and SSE modes). */
const renderToolText = (json: unknown) => JSON.stringify(json, null, 2);

describe('postCorpusRequestOverSse (MCP callWorker corpus path)', () => {
  const originalFetch = globalThis.fetch;
  let timers: LiveTimerTracker;

  beforeEach(() => { timers = trackLiveTimers(); });
  afterEach(() => {
    timers.restore();
    globalThis.fetch = originalFetch;
  });

  function useScript(...scripts: Parameters<typeof createStreamFetchMock>) {
    const fetchMock = createStreamFetchMock(...scripts);
    globalThis.fetch = fetchMock.fetch;
    return fetchMock;
  }

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('uses the plan constants: 30 s idle, 15 min absolute cap', () => {
    expect(CORPUS_STREAM_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(CORPUS_STREAM_ABSOLUTE_CAP_MS).toBe(15 * 60_000);
  });

  it('survives a prime far longer than the idle window while pings arrive, and returns the JSON-mode body', async () => {
    const primeBody = { session_id: 'sess-123', name: 'alpha' };
    const fetchMock = useScript({
      headers: SSE_HEADERS,
      body: [
        { chunk: ': ping\n\n' },
        // 15 pings x 20 ms = 300 ms, five times the 60 ms idle window.
        { pings: 15, intervalMs: PING_INTERVAL_MS },
        { chunk: `event: result\ndata: ${JSON.stringify(primeBody)}\n\n`, delayMs: PING_INTERVAL_MS },
      ],
    });

    const result = await postCorpusRequestOverSse('/api/corpus/alpha/prime', {}, SCALED_TIMING);

    expect(result).toEqual(primeBody);
    expect(renderToolText(result)).toBe(renderToolText(primeBody));
    const init = fetchMock.calls[0].init!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect(fetchMock.calls[0].url.endsWith('/api/corpus/alpha/prime')).toBe(true);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('maps an error event back to the exact error text callWorker produced from a JSON error response', async () => {
    const notFoundBody = { error: 'Corpus "zeta" not found', fix: 'Check the corpus name or build a new one', available: ['alpha'] };
    useScript({
      headers: SSE_HEADERS,
      body: [{ chunk: ': ping\n\n' }, { chunk: `event: error\ndata: ${JSON.stringify({ ...notFoundBody, status: 404 })}\n\n` }],
    });

    await expect(postCorpusRequestOverSse('/api/corpus/zeta/prime', {}, SCALED_TIMING))
      .rejects.toThrow(`Worker API error (404): ${JSON.stringify(notFoundBody)}`);
  });

  it('keeps the JSON error text for a request rejected before the stream opened', async () => {
    useScript({ status: 400, headers: { 'content-type': 'application/json' }, body: [{ chunk: '{"error":"bad"}' }] });

    await expect(postCorpusRequestOverSse('/api/corpus', { name: '' }, SCALED_TIMING))
      .rejects.toThrow('Worker API error (400): {"error":"bad"}');
  });

  it('accepts a single JSON body from a worker that predates SSE', async () => {
    useScript({ headers: { 'content-type': 'application/json' }, body: [{ chunk: '{"answer":"42","session_id":"s"}' }] });

    expect(await postCorpusRequestOverSse('/api/corpus/alpha/query', { question: 'q' }, SCALED_TIMING))
      .toEqual({ answer: '42', session_id: 's' });
  });

  it('gives up after the idle window when the worker goes silent', async () => {
    useScript({ headers: SSE_HEADERS, body: [{ chunk: ': ping\n\n' }, { hang: true }] });

    await expect(postCorpusRequestOverSse('/api/corpus/alpha/prime', {}, SCALED_TIMING))
      .rejects.toThrow(`Request timed out after ${SCALED_TIMING.idleTimeoutMs}ms idle`);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('fails when the stream ends without a terminal event', async () => {
    useScript({ headers: SSE_HEADERS, body: [{ chunk: ': ping\n\n' }] });

    await expect(postCorpusRequestOverSse('/api/corpus/alpha/prime', {}, SCALED_TIMING))
      .rejects.toThrow('SSE stream ended before a terminal event (result, error)');
  });
});
