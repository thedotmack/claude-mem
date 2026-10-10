import { expect, it } from 'bun:test';
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"session":'));
        timer = setTimeout(() => controller.error(new Error('fixture disconnect')), 50);
      },
    }), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    const client = new ServerClient({ serverBaseUrl: server.url.toString(), apiKey: 'fixture', timeoutMs: 1000 });
    let error: unknown;
    try { await client.startSession({ projectId: 'fixture' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ServerClientError);
    expect((error as ServerClientError).kind).toBe('transport');
    expect((error as ServerClientError).isFallbackEligible()).toBe(true);
  } finally { if (timer) clearTimeout(timer); server.stop(true); }
});
