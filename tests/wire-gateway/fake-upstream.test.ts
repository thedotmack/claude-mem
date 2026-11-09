import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { sse, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';

// The harness Phase 2's relay tests stand on: prove each scripted reply does
// what it claims, straight against the fake (no gateway in between).

let upstream: FakeUpstream;

beforeAll(async () => {
  upstream = await startFakeUpstream();
});

afterAll(async () => {
  await upstream.stop();
});

async function readAll(response: Response): Promise<{ text: string; chunkTimes: number[] }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunkTimes: number[] = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkTimes.push(Date.now());
    text += decoder.decode(value);
  }
  return { text, chunkTimes };
}

describe('fake upstream', () => {
  it('records method, path, query, headers and raw body bytes', async () => {
    upstream.setReply({ kind: 'json', body: '{"ok" : true}' });
    const body = new Uint8Array([0x7b, 0x20, 0x22, 0x61, 0x22, 0x20, 0x3a, 0x20, 0x31, 0x2e, 0x35, 0x30, 0x65, 0x32, 0x7d]);
    const response = await fetch(`${upstream.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
      body,
    });
    expect(await response.text()).toBe('{"ok" : true}');
    const recorded = upstream.requests.at(-1)!;
    expect(recorded.method).toBe('POST');
    expect(recorded.path).toBe('/v1/messages');
    expect(recorded.query).toBe('?beta=true');
    expect(recorded.headers['x-api-key']).toBe('sk-test');
    expect(Array.from(recorded.body)).toEqual(Array.from(body));
    expect(recorded.aborted).toBe(false);
  });

  it('streams SSE chunks with per-chunk delays', async () => {
    upstream.setReply({ kind: 'sse', chunks: [sse('event: ping'), sse('event: message_stop')], delayMs: 150 });
    const startedAt = Date.now();
    const { text, chunkTimes } = await readAll(await fetch(`${upstream.url}/sse`));
    expect(text).toBe('event: ping\n\nevent: message_stop\n\n');
    expect(chunkTimes.length).toBeGreaterThanOrEqual(2);
    expect(chunkTimes[0] - startedAt).toBeLessThan(150);
    expect(chunkTimes.at(-1)! - startedAt).toBeGreaterThanOrEqual(140);
    // A reply that finished is no abort, however long it streamed.
    expect(upstream.requests.at(-1)!.aborted).toBe(false);
  });

  it('sends gzip-encoded bytes labelled content-encoding: gzip', async () => {
    upstream.setReply({ kind: 'gzip', body: '{"hello":"world"}' });
    // decompress:false keeps the wire bytes (report 08 §Q3).
    const response = await fetch(`${upstream.url}/gz`, { decompress: false } as RequestInit);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const raw = new Uint8Array(await response.arrayBuffer());
    expect(gunzipSync(raw).toString('utf-8')).toBe('{"hello":"world"}');
  });

  it('cuts a stream mid-way: the client sees the first bytes, then an error, never an end event', async () => {
    upstream.setReply({ kind: 'cut', chunks: [sse('event: message_start')], delayMs: 50 });
    // keepalive:false — probed on Bun 1.3.9: a cut on a reused keep-alive
    // connection makes fetch replay the request (POST too) and splice both
    // bodies into one stream. A fresh connection shows the cut as it is.
    const requestsBefore = upstream.requests.length;
    const response = await fetch(`${upstream.url}/cut`, { keepalive: false });
    const reader = response.body!.getReader();
    let received = '';
    let outcome = 'ended';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
    } catch {
      outcome = 'errored';
    }
    expect(received).toBe('event: message_start\n\n');
    expect(outcome).toBe('errored');
    expect(upstream.requests.length - requestsBefore).toBe(1);
    expect(upstream.requests.at(-1)!.aborted).toBe(false);
  });

  it('keeps connections alive, so reuse is observable', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    await (await fetch(`${upstream.url}/one`)).text();
    await (await fetch(`${upstream.url}/two`)).text();
    const [first, second] = upstream.requests.slice(-2);
    expect(second.connectionNumber).toBe(first.connectionNumber);
  });

  it('plays an error event after HTTP 200', async () => {
    upstream.setReply({ kind: 'error-after-200', chunks: [sse('event: message_start')], errorEvent: sse('event: error\ndata: {"type":"error"}') });
    const response = await fetch(`${upstream.url}/err`);
    expect(response.status).toBe(200);
    const { text } = await readAll(response);
    expect(text).toContain('event: error');
  });

  it('hangs until the client goes away, and records the abort', async () => {
    upstream.setReply({ kind: 'hang' });
    const controller = new AbortController();
    const pending = fetch(`${upstream.url}/hang`, { signal: controller.signal }).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 100));
    const recorded = upstream.requests.at(-1)!;
    expect(recorded.path).toBe('/hang');
    controller.abort();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(recorded.aborted).toBe(true);
  });
});
