import { expect, it, spyOn } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';
import { Server } from '../../src/services/server/Server.js';
import { InitPhaseTracker } from '../../src/services/server/init-phase.js';
import { readSseEvents } from '../../src/shared/sse-reader.js';

async function fixture() {
  const tracker = new InitPhaseTracker();
  const responses: Response[] = [];
  const server = new Server({
    getInitializationComplete: () => false, getMcpReady: () => true,
    onShutdown: async () => {}, onRestart: async () => {},
    workerPath: '/owned/worker-service.cjs',
    getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    initPhaseSource: tracker,
    preBodyParserRoutes: [{ setupRoutes(app) {
      app.use('/api/ready', (_req, res, next) => { responses.push(res); next(); });
    } }],
  });
  await server.listen(0, '127.0.0.1');
  const port = (server.getHttpServer()!.address() as AddressInfo).port;
  const streams: ReturnType<typeof readSseEvents>[] = [];
  return {
    tracker, responses,
    async connect() {
      const response = await fetch(`http://127.0.0.1:${port}/api/ready`);
      const stream = readSseEvents(response.body!); streams.push(stream);
      expect(JSON.parse((await stream.next()).value!.data).phase).toBe('starting');
      return stream;
    },
    async close() {
      for (const response of responses) response.destroy();
      for (const stream of streams) await stream.return(undefined).catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

it('isolates a readiness response write failure from worker progress and healthy subscribers', async () => {
  const h = await fixture();
  let write: ReturnType<typeof spyOn> | undefined;
  try {
    const failed = await h.connect();
    const healthy = await h.connect();
    const closed = failed.next().then(result => result.done, () => true);
    write = spyOn(h.responses[0], 'write').mockImplementation(() => { throw new Error('owned readiness write failure'); });
    expect(() => h.tracker.setInitPhase('db_ready')).not.toThrow();
    expect(JSON.parse((await healthy.next()).value!.data).phase).toBe('db_ready');
    expect(await closed).toBe(true);
    expect(h.tracker.listenerCount()).toBe(1);
    h.tracker.setInitPhase('ready');
    expect(JSON.parse((await healthy.next()).value!.data).phase).toBe('ready');
    expect((await healthy.next()).done).toBe(true);
    expect(h.tracker.listenerCount()).toBe(0);
  } finally { write?.mockRestore(); await h.close(); }
});

it('handles asynchronous readiness response errors and releases the subscription', async () => {
  const h = await fixture();
  try {
    const failed = await h.connect();
    const closed = failed.next().then(result => result.done, () => true);
    expect(() => h.responses[0].emit('error', new Error('owned asynchronous readiness failure'))).not.toThrow();
    expect(await closed).toBe(true);
    expect(h.tracker.listenerCount()).toBe(0);
    expect(h.responses[0].destroyed).toBe(true);
    expect(() => h.tracker.setInitPhase('ready')).not.toThrow();
  } finally { await h.close(); }
});

it('keeps a healthy readiness stream open until its terminal phase', async () => {
  const h = await fixture();
  try {
    const stream = await h.connect();
    h.tracker.setInitPhase('routes_ready');
    expect(JSON.parse((await stream.next()).value!.data).phase).toBe('routes_ready');
    h.tracker.setInitPhase('ready');
    expect(JSON.parse((await stream.next()).value!.data).phase).toBe('ready');
    expect((await stream.next()).done).toBe(true);
  } finally { await h.close(); }
});

it('handles queued response errors until the closing transport emits close', async () => {
  const h = await fixture();
  let destroy: ReturnType<typeof spyOn> | undefined;
  try {
    const failed = await h.connect();
    const response = h.responses[0];
    const closed = failed.next().then(result => result.done, () => true);
    // Hold the real response in the error-to-close interval deterministically.
    // The response, phase subscription and final socket close remain real.
    destroy = spyOn(response, 'destroy').mockImplementation(() => response);
    expect(() => response.emit('error', new Error('first failed write'))).not.toThrow();
    expect(h.tracker.listenerCount()).toBe(0);
    await Promise.resolve();
    expect(() => response.emit('error', new Error('queued failed write'))).not.toThrow();
    expect(() => h.tracker.setInitPhase('ready')).not.toThrow();
    const socketClosed = new Promise<void>(resolve => response.socket!.once('close', () => resolve()));
    destroy.mockRestore();
    destroy = undefined;
    response.destroy();
    await socketClosed;
    expect(await closed).toBe(true);
    expect(response.listenerCount('error')).toBe(0);
  } finally { destroy?.mockRestore(); await h.close(); }
});
