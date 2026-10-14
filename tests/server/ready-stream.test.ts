import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { AddressInfo } from 'net';
import http from 'http';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { InitPhaseTracker } from '../../src/services/server/init-phase.js';
import { readSseEvents, type SseEvent } from '../../src/shared/sse-reader.js';

const PING_INTERVAL_MS = 40;

function baseOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    getInitializationComplete: () => false,
    getMcpReady: () => true,
    onShutdown: mock(() => Promise.resolve()),
    onRestart: mock(() => Promise.resolve()),
    workerPath: '/test/worker-service.cjs',
    getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    readyStreamPingIntervalMs: PING_INTERVAL_MS,
    ...overrides,
  };
}

/** Reads raw lines and parsed events of GET /api/ready until the server ends it. */
async function openReadyStream(port: number) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: controller.signal });
  const pings: number[] = [];
  const events: SseEvent[] = [];
  const done = (async () => {
    for await (const event of readSseEvents(response.body!, { onActivity: () => pings.push(Date.now()) })) {
      events.push(event);
    }
  })();
  return { response, events, pings, done, abort: () => controller.abort() };
}

const phasesOf = (events: SseEvent[]) => events.map(event => JSON.parse(event.data).phase);
const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

describe('GET /api/ready', () => {
  let server: Server;
  let port: number;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = (['info', 'debug', 'warn', 'error'] as const).map(level => spyOn(logger, level).mockImplementation(() => {}));
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());
    // Same cleanup as server.test.ts: under Bun, close() after
    // closeAllConnections() can report ERR_SERVER_NOT_RUNNING.
    if (server?.getHttpServer()) await server.close().catch(() => {});
  });

  async function start(options: ServerOptions) {
    server = new Server(options);
    await server.listen(0, '127.0.0.1');
    port = (server.getHttpServer()!.address() as AddressInfo).port;
  }

  it('streams SSE headers and every phase in order, then ends after ready', async () => {
    const tracker = new InitPhaseTracker();
    await start(baseOptions({ initPhaseSource: tracker }));

    const stream = await openReadyStream(port);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.response.headers.get('cache-control')).toBe('no-cache');
    await waitFor(() => stream.events.length === 1);

    tracker.setInitPhase('db_ready');
    tracker.setInitPhase('routes_ready');
    tracker.setInitPhase('ready');
    await stream.done;

    expect(stream.events.every(event => event.event === 'phase')).toBe(true);
    expect(phasesOf(stream.events)).toEqual(['starting', 'db_ready', 'routes_ready', 'ready']);
    const last = JSON.parse(stream.events[3].data);
    expect(last.pid).toBe(process.pid);
    expect(typeof last.version).toBe('string');
    expect(tracker.listenerCount()).toBe(0);
  });

  it('emits a ready worker\'s terminal phase immediately and closes', async () => {
    const tracker = new InitPhaseTracker();
    tracker.setInitPhase('ready');
    await start(baseOptions({ initPhaseSource: tracker }));

    const stream = await openReadyStream(port);
    await stream.done;
    expect(phasesOf(stream.events)).toEqual(['ready']);
    expect(stream.pings).toHaveLength(0);
  });

  it('sends a ping comment on each interval while init is in progress', async () => {
    const tracker = new InitPhaseTracker();
    await start(baseOptions({ initPhaseSource: tracker }));

    const stream = await openReadyStream(port);
    await waitFor(() => stream.pings.length >= 3);
    const gaps = stream.pings.slice(1).map((at, index) => at - stream.pings[index]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(PING_INTERVAL_MS * 0.5);
      expect(gap).toBeLessThan(PING_INTERVAL_MS * 5);
    }
    tracker.setInitPhase('ready');
    await stream.done;
  });

  it('ends with failed{message} when background init dies', async () => {
    const tracker = new InitPhaseTracker();
    await start(baseOptions({ initPhaseSource: tracker }));

    const stream = await openReadyStream(port);
    await waitFor(() => stream.events.length === 1);
    tracker.setInitPhase('failed', 'bun:sqlite exploded');
    await stream.done;

    const payloads = stream.events.map(event => JSON.parse(event.data));
    expect(payloads.map(payload => payload.phase)).toEqual(['starting', 'failed']);
    expect(payloads[1].message).toBe('bun:sqlite exploded');
    expect(tracker.listenerCount()).toBe(0);
  });

  it('drops the listener and the ping timer when the client disconnects', async () => {
    const tracker = new InitPhaseTracker();
    await start(baseOptions({ initPhaseSource: tracker }));

    // node:http so the disconnect is a real socket close (Bun's fetch abort
    // can leave the pooled connection open).
    const firstChunk = await new Promise<{ request: http.ClientRequest; text: string }>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}/api/ready`, response => {
        response.once('data', chunk => resolve({ request, text: String(chunk) }));
      });
      request.on('error', reject);
    });
    expect(firstChunk.text).toContain('"phase":"starting"');
    expect(tracker.listenerCount()).toBe(1);

    firstChunk.request.destroy();
    await waitFor(() => tracker.listenerCount() === 0);
    // A later transition must not write to the closed response.
    tracker.setInitPhase('ready');
  });

  it('without a phase source, derives ready/starting from getInitializationComplete and re-checks on each ping', async () => {
    let initialized = false;
    await start(baseOptions({ getInitializationComplete: () => initialized }));

    const stream = await openReadyStream(port);
    await waitFor(() => stream.events.length === 1);
    initialized = true;
    await stream.done;
    expect(phasesOf(stream.events)).toEqual(['starting', 'ready']);
  });

  it('leaves /api/readiness unchanged for older clients', async () => {
    await start(baseOptions());
    const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe('initializing');
  });
});
