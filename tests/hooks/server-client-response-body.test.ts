import { expect, it } from 'bun:test';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { ServerClient, ServerClientError } from '../../src/services/hooks/server-client.js';

it('keeps a success-body timeout eligible for hook fallback', async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"session":'));
        timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}}')); controller.close(); }, 1000);
      }, cancel() { if (timer) clearTimeout(timer); },
    }), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    const client = new ServerClient({ serverBaseUrl: server.url.toString(), apiKey: 'fixture', timeoutMs: 100 });
    let error: unknown;
    try { await client.startSession({ projectId: 'fixture' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ServerClientError);
    expect((error as ServerClientError).kind).toBe('timeout');
    expect((error as ServerClientError).isFallbackEligible()).toBe(true);
  } finally { if (timer) clearTimeout(timer); server.stop(true); }
});

it('keeps a disconnected success body eligible for hook fallback', async () => {
  // A raw TCP server that drops the connection mid-body. Bun.serve cannot stage
  // this: when a Response stream errors it still writes the terminating chunk
  // (Bun 1.3.9), so the client sees a clean, merely truncated JSON body.
  const openSockets = new Set<Socket>();
  const server = createNetServer(socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{"session":\r\n');
      socket.destroy();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const client = new ServerClient({ serverBaseUrl: `http://127.0.0.1:${port}/`, apiKey: 'fixture', timeoutMs: 1000 });
    let error: unknown;
    try { await client.startSession({ projectId: 'fixture' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ServerClientError);
    expect((error as ServerClientError).kind).toBe('transport');
    expect((error as ServerClientError).isFallbackEligible()).toBe(true);
  } finally {
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
