/**
 * Scripted fetch for liveness tests. Every wait is abortable and cleans up its
 * own timer, so a test can assert "zero live timers" after the request settles.
 *
 * Bun 1.3 has no fake timers for setTimeout-driven code we can rely on here, so
 * tests use small real intervals (20–100 ms) plus `trackLiveTimers()`.
 */

export type StreamBodyStep =
  /** Emit bytes, optionally after a delay. */
  | { chunk: string | Uint8Array; delayMs?: number }
  /** Emit `count` SSE comment pings (default ': ping\n\n'), one every `intervalMs`. */
  | { pings: number; intervalMs: number; text?: string }
  /** Error the body (after headers), optionally after a delay. */
  | { fail: Error; delayMs?: number }
  /** Go silent until aborted. */
  | { hang: true };

export interface StreamFetchScript {
  status?: number;
  headers?: Record<string, string>;
  /** Delay before headers arrive. */
  headersDelayMs?: number;
  /** Never send headers; only an abort ends the request. */
  hangBeforeHeaders?: boolean;
  /** Network error before any response (fetch rejects). */
  failBeforeHeaders?: Error;
  body?: StreamBodyStep[];
}

export interface StreamFetchMock {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
}

const encoder = new TextEncoder();

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** One script per call, in order; the last script repeats for extra calls. */
export function createStreamFetchMock(...scripts: StreamFetchScript[]): StreamFetchMock {
  const calls: StreamFetchMock['calls'] = [];

  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];

    // Internal controller: aborted by the caller's signal or by body cancel.
    const lifetime = new AbortController();
    const callerSignal = init?.signal;
    const forwardAbort = () => lifetime.abort(callerSignal?.reason);
    if (callerSignal?.aborted) throw callerSignal.reason;
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    const detach = () => callerSignal?.removeEventListener('abort', forwardAbort);

    try {
      if (script.failBeforeHeaders) throw script.failBeforeHeaders;
      if (script.hangBeforeHeaders) await waitForAbort(lifetime.signal);
      if (script.headersDelayMs) await abortableSleep(script.headersDelayMs, lifetime.signal);
    } catch (err) {
      detach();
      throw err;
    }

    const steps = script.body ?? [];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const step of steps) {
            if ('chunk' in step) {
              if (step.delayMs) await abortableSleep(step.delayMs, lifetime.signal);
              controller.enqueue(typeof step.chunk === 'string' ? encoder.encode(step.chunk) : step.chunk);
            } else if ('pings' in step) {
              for (let i = 0; i < step.pings; i++) {
                await abortableSleep(step.intervalMs, lifetime.signal);
                controller.enqueue(encoder.encode(step.text ?? ': ping\n\n'));
              }
            } else if ('fail' in step) {
              if (step.delayMs) await abortableSleep(step.delayMs, lifetime.signal);
              throw step.fail;
            } else {
              await waitForAbort(lifetime.signal);
            }
          }
          controller.close();
        } catch (err) {
          // No-op if the consumer already cancelled the stream.
          controller.error(err);
        } finally {
          detach();
        }
      },
      cancel() {
        lifetime.abort(new Error('stream cancelled by consumer'));
      },
    });

    return new Response(stream, { status: script.status ?? 200, headers: script.headers });
  };

  return { fetch: mockFetch as typeof fetch, calls };
}

export interface LiveTimerTracker {
  /** Timers scheduled and neither fired nor cleared. */
  liveCount(): number;
  restore(): void;
}

/**
 * Source paths whose timers the liveness tests own: the idle-timeout fetch, the
 * SSE reader, the corpus SSE client, the worker providers, and this mock.
 */
const OWNED_TIMER_SOURCE_PATHS = [
  '/src/shared/worker-utils.ts',
  '/src/shared/sse-reader.ts',
  '/src/servers/corpus-worker-stream.ts',
  '/src/services/worker/',
  '/tests/helpers/stream-fetch-mock.ts',
];

/**
 * True when the synchronous part of the scheduling stack (below the patched
 * setTimeout wrapper, above the first microtask boundary) runs through owned
 * code. In a full `bun test tests` run, background work leaked by other test
 * files (Chroma subprocess cleanup, opencode retry loops) schedules timers while
 * these tests run; counting those made every "zero live timers" check fail.
 */
function scheduledByOwnedSource(): boolean {
  const frames = (new Error().stack ?? '').split('\n').slice(3);
  const microtaskBoundary = frames.findIndex((frame) => frame.includes('processTicksAndRejections'));
  const synchronousFrames = microtaskBoundary === -1 ? frames : frames.slice(0, microtaskBoundary);
  return synchronousFrames.some((frame) => OWNED_TIMER_SOURCE_PATHS.some((path) => frame.includes(path)));
}

/**
 * Patches global setTimeout/clearTimeout/setInterval/clearInterval to count live
 * handles scheduled by owned code (see OWNED_TIMER_SOURCE_PATHS). Install before
 * the code under test runs; call restore() in afterEach.
 */
export function trackLiveTimers(): LiveTimerTracker {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const live = new Set<unknown>();

  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = original.setTimeout((...inner: unknown[]) => { live.delete(handle); handler(...inner); }, ms, ...args);
    if (scheduledByOwnedSource()) live.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    live.delete(handle);
    original.clearTimeout(handle);
  }) as typeof clearTimeout;
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = original.setInterval(handler, ms, ...args);
    if (scheduledByOwnedSource()) live.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle);
    original.clearInterval(handle);
  }) as typeof clearInterval;

  return {
    liveCount: () => live.size,
    restore: () => Object.assign(globalThis, original),
  };
}
