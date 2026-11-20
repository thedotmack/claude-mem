import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { SSEBroadcaster } from '../../../../src/services/worker/SSEBroadcaster.js';

/**
 * Backpressure on Bun's real node:http response, not an emitter or a bare
 * Writable: a raw socket client stops reading so the kernel buffers fill and
 * res.write() returns false. The broadcaster must wait for the response's
 * drain, then deliver every queued frame once and in order; a client that
 * never reads again must be disconnected at the pending-byte cap.
 */

const FRAME_PAYLOAD = 'x'.repeat(16 * 1024);
// Upper bound on broadcasts for the stalled-client case: 4,096 frames of
// 16 KiB is 64 MiB, far above loopback socket buffers plus the 1 MiB cap on
// macOS and Linux, so reaching it means the client was never disconnected.
const MAX_BROADCASTS = 4096;

let warnSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  debugSpy.mockRestore();
});

async function startStream(broadcaster: SSEBroadcaster): Promise<{
  server: Server; client: Socket; response: Response; received: () => string;
}> {
  let gotResponse!: (response: Response) => void;
  const responseReady = new Promise<Response>(resolve => { gotResponse = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    broadcaster.addClient(response as unknown as Response);
    gotResponse(response as unknown as Response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP address');
  const client = connect(address.port, '127.0.0.1');
  let text = '';
  client.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    client.once('error', reject);
    client.once('connect', () => client.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n'));
    client.once('data', chunk => { text += chunk; resolve(); });
  });
  // Stop reading: what the server writes now piles up in socket buffers.
  client.pause();
  client.on('data', chunk => { text += chunk; });
  client.pause();
  return { server, client, response: await responseReady, received: () => text };
}

async function stop(server: Server, client: Socket): Promise<void> {
  client.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 1));
}

function idsIn(text: string): number[] {
  return [...text.matchAll(/"queueDepth":(\d+)/g)].map(match => Number(match[1]));
}

it('waits for the HTTP response to drain, then delivers each queued frame once and in order', async () => {
  const broadcaster = new SSEBroadcaster();
  const { server, client, received } = await startStream(broadcaster);
  try {
    const queues = (broadcaster as any).queues as Map<unknown, { frames: unknown[]; bytes: number }>;
    let sent = 0;
    // Broadcast until frames are queued behind backpressure, then a few more,
    // staying well under the cap so nothing is disconnected.
    let queuedAt = -1;
    while (sent < MAX_BROADCASTS && (queuedAt < 0 || sent < queuedAt + 8)) {
      broadcaster.broadcast({ type: 'processing_status', queueDepth: sent, text: FRAME_PAYLOAD });
      sent += 1;
      const queue = [...queues.values()][0];
      if (queuedAt < 0 && queue && queue.frames.length > 0) queuedAt = sent;
      if (queuedAt < 0 && sent % 16 === 0) await tick();
    }
    expect(queuedAt).toBeGreaterThan(0);
    expect(broadcaster.getClientCount()).toBe(1);

    client.resume();
    const expected = Array.from({ length: sent }, (_, i) => i);
    for (let waited = 0; waited < 5000 && idsIn(received()).length < sent; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(idsIn(received())).toEqual(expected);
    // Only the cap's own warning matters here; other code in the same test
    // process may log unrelated warnings.
    expect(warnSpy.mock.calls.some(call => String(call[1]).includes('SSE client stopped reading'))).toBe(false);
  } finally {
    await stop(server, client);
  }
}, 15000);

it('disconnects a client that never reads again once its queued frames pass the cap, with a WARN', async () => {
  const broadcaster = new SSEBroadcaster();
  const { server, client, response } = await startStream(broadcaster);
  try {
    let sent = 0;
    while (sent < MAX_BROADCASTS && broadcaster.getClientCount() > 0) {
      broadcaster.broadcast({ type: 'processing_status', queueDepth: sent, text: FRAME_PAYLOAD });
      sent += 1;
      if (sent % 16 === 0) await tick();
    }
    expect(broadcaster.getClientCount()).toBe(0);
    expect(response.destroyed).toBe(true);
    const warning = warnSpy.mock.calls.find(call => String(call[1]).includes('SSE client stopped reading'));
    expect(warning).toBeDefined();
    const context = warning![2] as { pendingBytes: number; pendingFrames: number; maxPendingBytes: number };
    expect(context.maxPendingBytes).toBe(1024 * 1024);
    expect(context.pendingFrames).toBeGreaterThan(0);
    expect(context.pendingBytes).toBeLessThanOrEqual(context.maxPendingBytes);
  } finally {
    await stop(server, client);
  }
}, 15000);
