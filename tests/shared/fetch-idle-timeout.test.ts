import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  fetchStreamWithIdleTimeout,
  fetchWithIdleTimeout,
  workerHttpRequest,
} from '../../src/shared/worker-utils.js';
import { readSseEvents } from '../../src/shared/sse-reader.js';
import { createStreamFetchMock, trackLiveTimers, type LiveTimerTracker } from '../helpers/stream-fetch-mock.js';

const URL_UNDER_TEST = 'http://127.0.0.1:1/test';
const IDLE_MS = 80;

describe('fetchWithIdleTimeout', () => {
  const originalFetch = globalThis.fetch;
  let timers: LiveTimerTracker;

  beforeEach(() => {
    timers = trackLiveTimers();
  });

  afterEach(() => {
    timers.restore();
    globalThis.fetch = originalFetch;
  });

  function useScript(...scripts: Parameters<typeof createStreamFetchMock>) {
    const mock = createStreamFetchMock(...scripts);
    globalThis.fetch = mock.fetch;
    return mock;
  }

  /** Let pending abort/cancel callbacks settle before counting timers. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('returns status, headers and the full body text', async () => {
    useScript({ status: 201, headers: { 'x-test': 'yes' }, body: [{ chunk: 'hel' }, { chunk: 'lo', delayMs: 10 }] });
    const result = await fetchWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS });
    expect(result.status).toBe(201);
    expect(result.ok).toBe(true);
    expect(result.headers.get('x-test')).toBe('yes');
    expect(result.text).toBe('hello');
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('pings keep a request alive well past the idle window', async () => {
    // 10 pings × 30 ms = ~300 ms total, almost 4× the 80 ms idle window.
    useScript({ body: [{ pings: 10, intervalMs: 30 }, { chunk: 'event: done\ndata: ok\n\n' }] });
    let chunkCount = 0;
    const startedAt = Date.now();
    const result = await fetchWithIdleTimeout(URL_UNDER_TEST, {}, {
      idleTimeoutMs: IDLE_MS,
      onChunk: () => { chunkCount++; },
    });
    expect(Date.now() - startedAt).toBeGreaterThan(IDLE_MS * 3);
    expect(chunkCount).toBe(11);
    expect(result.text.endsWith('data: ok\n\n')).toBe(true);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('silence before headers trips the idle timeout', async () => {
    useScript({ hangBeforeHeaders: true });
    await expect(fetchWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS }))
      .rejects.toThrow(`Request timed out after ${IDLE_MS}ms idle`);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('silence mid-body trips the idle timeout', async () => {
    useScript({ body: [{ chunk: 'partial' }, { hang: true }] });
    const error = await fetchWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Request timed out after ${IDLE_MS}ms idle`);
    // Existing callers classify timeouts with this regex — keep it matching.
    expect(/timed out|timeout/i.test(error.message)).toBe(true);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('absolute cap trips even while pings keep arriving', async () => {
    useScript({ body: [{ pings: 100, intervalMs: 20 }] });
    const startedAt = Date.now();
    await expect(fetchWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS, absoluteCapMs: 200 }))
      .rejects.toThrow('Request timed out after 200ms');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('network failure before the first byte surfaces unchanged', async () => {
    useScript({ failBeforeHeaders: new TypeError('fetch failed') });
    await expect(fetchWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS }))
      .rejects.toThrow('fetch failed');
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('body failure after the first byte surfaces unchanged', async () => {
    useScript({ body: [{ chunk: 'first' }, { fail: new Error('socket reset'), delayMs: 10 }] });
    await expect(fetchWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS }))
      .rejects.toThrow('socket reset');
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('caller signal abort propagates and clears timers', async () => {
    useScript({ body: [{ pings: 100, intervalMs: 20 }] });
    const caller = new AbortController();
    const callerReason = new Error('caller gave up');
    setTimeout(() => caller.abort(callerReason), 60);
    const error = await fetchWithIdleTimeout(URL_UNDER_TEST, { signal: caller.signal }, { idleTimeoutMs: IDLE_MS })
      .catch((err) => err);
    expect(error).toBe(callerReason);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('streaming variant feeds the SSE reader and pings count as activity', async () => {
    useScript({ body: [{ pings: 5, intervalMs: 30 }, { chunk: 'event: done\ndata: ok\n\n' }] });
    const streamed = await fetchStreamWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS });
    let activity = 0;
    const events = [];
    for await (const event of readSseEvents(streamed.chunks, {
      onActivity: () => { activity++; },
      terminalEventNames: ['done'],
    })) {
      events.push(event);
    }
    expect(activity).toBe(5);
    expect(events).toEqual([{ event: 'done', data: 'ok' }]);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('time spent by the consumer between reads does not count as idle', async () => {
    useScript({ body: [{ chunk: 'a' }, { chunk: 'b' }] });
    const streamed = await fetchStreamWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS });
    const received: string[] = [];
    for await (const chunk of streamed.chunks) {
      received.push(new TextDecoder().decode(chunk));
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    }
    expect(received.join('')).toBe('ab');
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('cancel() releases an unread body and its timers', async () => {
    useScript({ body: [{ hang: true }] });
    const streamed = await fetchStreamWithIdleTimeout(URL_UNDER_TEST, {}, { idleTimeoutMs: IDLE_MS });
    // The tracker is not vacuous: the idle timer is armed while the body is pending.
    expect(timers.liveCount()).toBeGreaterThan(0);
    await streamed.cancel();
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('workerHttpRequest with idleTimeoutMs returns a re-wrapped Response', async () => {
    const mock = useScript({ status: 202, headers: { 'content-type': 'application/json' }, body: [{ chunk: '{"ok":true}' }] });
    const response = await workerHttpRequest('/api/health', { idleTimeoutMs: IDLE_MS });
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
    expect(mock.calls[0].url.endsWith('/api/health')).toBe(true);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });

  it('workerHttpRequest with idleTimeoutMs times out on silence', async () => {
    useScript({ hangBeforeHeaders: true });
    await expect(workerHttpRequest('/api/health', { idleTimeoutMs: IDLE_MS }))
      .rejects.toThrow(`Request timed out after ${IDLE_MS}ms idle`);
    await settle();
    expect(timers.liveCount()).toBe(0);
  });
});
