import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { Response } from 'express';
import { SSEBroadcaster } from '../../../../src/services/worker/SSEBroadcaster.js';

it('removes a disconnected SSE client when Bun emits socket close', async () => {
  const broadcaster = new SSEBroadcaster();
  let socketClosed!: () => void;
  const closed = new Promise<void>(resolve => { socketClosed = resolve; });
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    request.socket.once('close', socketClosed);
    broadcaster.addClient(response as Response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP address');
  const socket = connect(address.port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('data', () => resolve());
      socket.once('connect', () => socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n'));
    });
    expect(broadcaster.getClientCount()).toBe(1);
    socket.destroy();
    await closed;
    expect(broadcaster.getClientCount()).toBe(0);
  } finally {
    socket.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);
