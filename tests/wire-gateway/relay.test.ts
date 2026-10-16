import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'node:zlib';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import {
  relayCaptureSkipCounts,
  type RelayExchange,
  type RelayExchangeResult,
} from '../../src/services/wire-gateway/relay/relay.js';
import { sse, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Phase 2 golden passthrough tests: the bytes an agent sends are the bytes the
// vendor gets, and the bytes the vendor sends are the bytes the agent gets.

const MAX_REQUEST_BYTES = 256 * 1024;
const BODY_IDLE_TIMEOUT_MS = 300;
const routesFilePath = join(WIRE_GATEWAY_DIR, 'relay-test-routes.json');

let upstream: FakeUpstream;
let gateway: StartedWireGateway;
const exchanges: RelayExchange[] = [];
const results = new Map<string, RelayExchangeResult>();
const capturedChunks = new Map<string, string>();

beforeAll(async () => {
  upstream = await startFakeUpstream();
  rmSync(routesFilePath, { force: true });
  addWireGatewayRoute({ routeId: 'claude', agentId: 'claude-code', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'codex', agentId: 'codex', upstreamBaseUrl: `${upstream.url}/v1/` }, routesFilePath);
  addWireGatewayRoute({ routeId: 'gemini', agentId: 'gemini-cli', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'native', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  addWireGatewayRoute({ routeId: 'chatgpt', agentId: 'codex', upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex' }, routesFilePath);
  addWireGatewayRoute({ routeId: 'code-assist', agentId: 'gemini-cli', upstreamBaseUrl: 'https://cloudcode-pa.googleapis.com' }, routesFilePath);
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    maxRequestBytes: MAX_REQUEST_BYTES,
    requestBodyIdleTimeoutMs: BODY_IDLE_TIMEOUT_MS,
    relayObserver: {
      onExchangeStarted: exchange => exchanges.push(exchange),
      onResponseChunk: (exchange, chunk) => {
        capturedChunks.set(exchange.exchangeId, (capturedChunks.get(exchange.exchangeId) ?? '') + new TextDecoder().decode(chunk));
      },
      onExchangeFinished: (exchange, result) => results.set(exchange.exchangeId, result),
    },
  });
});

afterAll(async () => {
  await gateway.stop();
  await upstream.stop();
  rmSync(routesFilePath, { force: true });
});

beforeEach(() => {
  upstream.setReply({ kind: 'json', body: { ok: true } });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(10);
  }
}

function lastExchange(): RelayExchange {
  return exchanges.at(-1)!;
}

async function resultOf(exchange: RelayExchange): Promise<RelayExchangeResult> {
  return waitFor(() => results.get(exchange.exchangeId));
}

/** Read a body to its end; 'errored' when the connection broke instead of ending. */
async function readStream(response: Response): Promise<{ text: string; outcome: 'ended' | 'errored'; chunkTimes: number[] }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunkTimes: number[] = [];
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, outcome: 'ended', chunkTimes };
      chunkTimes.push(Date.now());
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { text, outcome: 'errored', chunkTimes };
  }
}

// Odd JSON a re-encoder would change: spaces before ':', '\/', 1.50e2, 0.70,
// \u0001, duplicate keys, non-ASCII (magpie upstream_bytes_test.go:22-46).
const ODD_ANTHROPIC_BODY = `{ "max_tokens" : 1024,"model":"claude-x", "metadata":{"user_id":"u_1"},
 "system":[{"type":"text","text":"You are é \\/ \\"careful\\"\\n\\ttabs","cache_control":{"type":"ephemeral"}}],
 "messages":[{"role":"user","content":"read it"},
  {"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"c2ln"},{"type":"text","text":"ok 漢字 😀"},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"path":"/a b/c.go","n":1.50e2}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"line\\u0001one\\r\\nline two"}]},{"type":"text","text":"go on"}]}],
 "temperature":0.70, "stream":false, "model":"claude-x", "unknown_field":{"kept":[1,2,{"x":null}]}}`;
const ODD_CHAT_BODY = `{"model":"gpt-x","messages":[{"role":"system","content":"be brief"},
 {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"\\/x\\"}"}}]},
 {"role":"tool","tool_call_id":"call_1","content":"file \\"body\\"\\n"},{"role":"user","content":"go on é"}],
 "temperature" : 1.50e0,"top_p":0.70,"stream":false,"user":"u","user":"dup"}`;
const ODD_RESPONSES_BODY = `{"model":"gpt-x","instructions":"be brief — ok",
 "input":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"ZW5j"},
 {"type":"function_call","call_id":"call_1","name":"Read","arguments":"{\\"path\\":\\"\\/x\\"}"},
 {"type":"function_call_output","call_id":"call_1","output":"done\\t\\"x\\""}],
 "store":false , "stream":false,"temperature":0.70,"max_output_tokens":1.0e3}`;
const ODD_GEMINI_BODY = `{"contents":[{"role":"user","parts":[{"text":"hi \\/ é"}]},
 {"role":"model","parts":[{"functionCall":{"name":"Read","args":{"n":1.50e2}},"thoughtSignature":"c2ln"}]}],
 "generationConfig" : {"temperature":0.70,"temperature":0.7}}`;

describe('byte-faithful request bodies, per protocol', () => {
  const cases = [
    { name: 'Anthropic', path: '/r/claude/v1/messages?beta=true', upstreamPath: '/v1/messages', query: '?beta=true', body: ODD_ANTHROPIC_BODY, protocol: 'anthropic' },
    { name: 'OpenAI Chat', path: '/r/codex/chat/completions', upstreamPath: '/v1/chat/completions', query: '', body: ODD_CHAT_BODY, protocol: 'openai-chat' },
    { name: 'OpenAI Responses', path: '/r/codex/responses', upstreamPath: '/v1/responses', query: '', body: ODD_RESPONSES_BODY, protocol: 'openai-responses' },
    { name: 'Gemini', path: '/r/gemini/v1beta/models/gemini-x:generateContent', upstreamPath: '/v1beta/models/gemini-x:generateContent', query: '', body: ODD_GEMINI_BODY, protocol: 'gemini' },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name}: the vendor gets the exact bytes, path and query; the agent gets the exact reply`, async () => {
      const upstreamReply = '{"id" : "x",\n "value":1.50e2, "text":"\\/é"}';
      upstream.setReply({ kind: 'json', body: upstreamReply, headers: { 'x-request-id': 'req_1' } });
      const sentBytes = new TextEncoder().encode(testCase.body);
      const response = await fetch(`${gateway.baseUrl}${testCase.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-api03-test',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31, interleaved-thinking-2025-05-14',
          'x-claude-mem-route-hint': 'never-forwarded',
          'accept-encoding': 'gzip, br',
        },
        body: sentBytes,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(upstreamReply);
      expect(response.headers.get('x-request-id')).toBe('req_1');

      const recorded = upstream.requests.at(-1)!;
      expect(Buffer.from(recorded.body).equals(Buffer.from(sentBytes))).toBe(true);
      expect(recorded.path).toBe(testCase.upstreamPath);
      expect(recorded.query).toBe(testCase.query);
      expect(recorded.headers['x-api-key']).toBe('sk-ant-api03-test');
      expect(recorded.headers['anthropic-version']).toBe('2023-06-01');
      expect(recorded.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31, interleaved-thinking-2025-05-14');
      expect(recorded.headers.host).toBe(`127.0.0.1:${upstream.port}`);
      expect(recorded.headers['accept-encoding']).toBeUndefined();
      expect(recorded.headers['x-claude-mem-route-hint']).toBeUndefined();
      expect(recorded.headers['content-length']).toBe(String(sentBytes.byteLength));

      const exchange = lastExchange();
      expect(exchange.protocol).toBe(testCase.protocol);
      expect(exchange.captured).toBe(true);
      // The decoded copy is the same bytes and parses (duplicate keys and all).
      expect(Buffer.from(exchange.decodedRequestBody!).equals(Buffer.from(sentBytes))).toBe(true);
      expect(() => JSON.parse(new TextDecoder().decode(exchange.decodedRequestBody!))).not.toThrow();
      expect((await resultOf(exchange)).outcome).toBe('complete');
    });
  }
});

describe('classification by suffix', () => {
  it('/v1/messages?beta=true is Anthropic and captured; count_tokens is Anthropic, relay only', async () => {
    await (await fetch(`${gateway.baseUrl}/r/claude/v1/messages?beta=true`, { method: 'POST', body: '{}' })).text();
    expect(lastExchange()).toMatchObject({ protocol: 'anthropic', captured: true, suffixPath: '/v1/messages' });
    await (await fetch(`${gateway.baseUrl}/r/claude/v1/messages/count_tokens?beta=true`, { method: 'POST', body: '{}' })).text();
    expect(lastExchange()).toMatchObject({ protocol: 'anthropic', captured: false, decodedRequestBody: null });
  });

  it('/responses/compact is relay only; :streamGenerateContent is Gemini', async () => {
    await (await fetch(`${gateway.baseUrl}/r/codex/responses/compact`, { method: 'POST', body: '{}' })).text();
    expect(lastExchange()).toMatchObject({ protocol: 'openai-responses', captured: false });
    await (await fetch(`${gateway.baseUrl}/r/gemini/v1beta/models/gemini-x:streamGenerateContent?alt=sse`, { method: 'POST', body: '{}' })).text();
    expect(lastExchange()).toMatchObject({ protocol: 'gemini', captured: true });
    expect(upstream.requests.at(-1)!.query).toBe('?alt=sse');
  });

  it('HEAD /api/hello and GET /v1/models relay transparently, uncaptured', async () => {
    const hello = await fetch(`${gateway.baseUrl}/r/claude/api/hello`, { method: 'HEAD' });
    expect(hello.status).toBe(200);
    expect(upstream.requests.at(-1)).toMatchObject({ method: 'HEAD', path: '/api/hello' });
    expect(lastExchange()).toMatchObject({ protocol: null, captured: false });

    upstream.setReply({ kind: 'json', body: { data: [{ id: 'm1' }] } });
    const models = await fetch(`${gateway.baseUrl}/r/codex/models?limit=1000`);
    expect(await models.json()).toEqual({ data: [{ id: 'm1' }] });
    expect(upstream.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models', query: '?limit=1000' });
    expect(lastExchange()).toMatchObject({ protocol: null, captured: false });
  });

  it('a native-capture route relays but never captures', async () => {
    await (await fetch(`${gateway.baseUrl}/r/native/v1/messages`, { method: 'POST', body: '{}' })).text();
    expect(lastExchange()).toMatchObject({ protocol: 'anthropic', captured: false, captureSkippedReason: 'native_capture_source' });
  });

  it('an unknown route is a protocol-native 404 that names `wire routes list`', async () => {
    const response = await fetch(`${gateway.baseUrl}/r/nope/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    const body = await response.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('claude-mem wire routes list');
  });
});

describe('streaming responses', () => {
  it('SSE chunks reach the agent as they arrive, before the stream ends', async () => {
    const chunks = [
      sse('event: message_start\ndata: {"type":"message_start"}'),
      sse('event: ping\ndata: {"type":"ping"}'),
      sse('event: message_stop\ndata: {"type":"message_stop"}'),
    ];
    upstream.setReply({ kind: 'sse', chunks, delayMs: 300 });
    const startedAt = Date.now();
    const response = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{"stream":true}' });
    const { text, outcome, chunkTimes } = await readStream(response);
    expect(outcome).toBe('ended');
    // Every byte, ping included, in order.
    expect(text).toBe(chunks.join(''));
    expect(chunkTimes[0] - startedAt).toBeLessThan(250);
    expect(chunkTimes.at(-1)! - startedAt).toBeGreaterThanOrEqual(550);

    const exchange = lastExchange();
    const result = await resultOf(exchange);
    expect(result).toMatchObject({ outcome: 'complete', endMarkerSeen: true, recordedStatus: 200 });
    // Observers got a copy of every chunk before the finish.
    expect(capturedChunks.get(exchange.exchangeId)).toBe(chunks.join(''));
  });

  it('a gzip response keeps its content-encoding and its compressed bytes', async () => {
    upstream.setReply({ kind: 'gzip', body: '{"hello":"world"}' });
    const response = await fetch(`${gateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: '{}', decompress: false } as RequestInit);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const raw = new Uint8Array(await response.arrayBuffer());
    expect(gunzipSync(raw).toString('utf-8')).toBe('{"hello":"world"}');
  });

  it('upstream non-2xx bodies relay unmodified', async () => {
    const overloaded = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    upstream.setReply({ kind: 'json', status: 529, body: overloaded, headers: { 'retry-after': '3', 'x-should-retry': 'true' } });
    const response = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(529);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('x-should-retry')).toBe('true');
    expect(await response.text()).toBe(overloaded);
  });

  it('an error event after HTTP 200 relays as it is and ends the stream', async () => {
    const start = sse('event: message_start\ndata: {"type":"message_start"}');
    const errorEvent = sse('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    upstream.setReply({ kind: 'error-after-200', chunks: [start], errorEvent });
    const response = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{}' });
    const { text, outcome } = await readStream(response);
    expect(outcome).toBe('ended');
    expect(text).toBe(start + errorEvent);
    expect((await resultOf(lastExchange())).endMarkerSeen).toBe(true);
  });
});

describe('cut streams are never "fixed"', () => {
  it('upstream breaking mid-reply: the agent gets what arrived, then a broken connection, and no synthetic end', async () => {
    const arrived = [
      sse('event: message_start\ndata: {"type":"message_start"}'),
      sse('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}'),
    ];
    upstream.setReply({ kind: 'cut', chunks: arrived, delayMs: 50 });
    // keepalive:false on the agent side too: Bun's fetch would otherwise
    // replay the request on the reused connection (see the next test).
    const response = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{"stream":true}', keepalive: false });
    const { text, outcome } = await readStream(response);
    expect(text).toBe(arrived.join(''));
    expect(text).not.toContain('message_stop');
    expect(text).not.toContain('event: error');
    // Bun.serve would end an errored body with a clean terminating chunk;
    // the relay breaks the connection instead (idle-timer reset, ~4 s).
    expect(outcome).toBe('errored');

    const result = await resultOf(lastExchange());
    expect(result).toMatchObject({ outcome: 'cut', endMarkerSeen: false });
    expect(await waitFor(() => (gateway.service.pendingRequests === 0 ? true : undefined))).toBe(true);
  }, 15_000);

  it('upstream ending cleanly before its end marker: relayed as it ended, flagged cut', async () => {
    const arrived = [sse('data: {"choices":[{"delta":{"content":"hel"}}]}')];
    upstream.setReply({ kind: 'sse', chunks: arrived });
    const response = await fetch(`${gateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: '{"stream":true}' });
    const { text, outcome } = await readStream(response);
    expect(outcome).toBe('ended');
    expect(text).toBe(arrived.join(''));
    expect(text).not.toContain('[DONE]');
    expect((await resultOf(lastExchange())).outcome).toBe('cut');
  });

  it('upstream fetch never reuses a connection, so a cut is never replayed to the vendor', async () => {
    // Probed on Bun 1.3.9: a cut on a reused keep-alive connection makes
    // fetch send the request again and splice both replies. The relay uses
    // keepalive:false, so each upstream request has its own connection.
    const requestsBefore = upstream.requests.length;
    upstream.setReply({ kind: 'json', body: { ok: true } });
    await (await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{"n":1}' })).text();
    upstream.setReply({ kind: 'cut', chunks: [sse('event: message_start\ndata: {}')], delayMs: 20 });
    const cutResponse = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{"n":2}', keepalive: false });
    const { text, outcome } = await readStream(cutResponse);
    expect(outcome).toBe('errored');
    expect(text).toBe(sse('event: message_start\ndata: {}'));

    const sent = upstream.requests.slice(requestsBefore);
    expect(sent.map(request => new TextDecoder().decode(request.body))).toEqual(['{"n":1}', '{"n":2}']);
    expect(sent[0].connectionNumber).not.toBe(sent[1].connectionNumber);
  }, 15_000);
});

describe('WebSocket upgrades', () => {
  it('are answered 426 without reaching upstream, so Codex falls back to HTTP at once', async () => {
    const requestsBefore = upstream.requests.length;
    const response = await fetch(`${gateway.baseUrl}/r/codex/responses`, {
      headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    expect(response.status).toBe(426);
    expect((await response.json()).error.message).toContain('HTTP only');
    expect(upstream.requests.length).toBe(requestsBefore);
  });
});

describe('client disconnects cancel the upstream', () => {
  it('an agent that leaves while upstream is silent makes the vendor see an abort (499)', async () => {
    upstream.setReply({ kind: 'hang' });
    const requestsBefore = upstream.requests.length;
    const controller = new AbortController();
    const pending = fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal }).catch(error => error);
    const recorded = await waitFor(() => upstream.requests[requestsBefore]);
    controller.abort();
    await pending;
    await waitFor(() => (recorded.aborted ? true : undefined));
    expect((await resultOf(lastExchange())).outcome).toBe('client_aborted');
    expect((await resultOf(lastExchange())).recordedStatus).toBe(499);
  });

  it('an agent that leaves mid-stream makes the vendor see an abort', async () => {
    upstream.setReply({ kind: 'sse', chunks: Array.from({ length: 50 }, (_, index) => sse(`data: {"n":${index}}`)), delayMs: 100 });
    const controller = new AbortController();
    const response = await fetch(`${gateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: '{}', signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const recorded = upstream.requests.at(-1)!;
    controller.abort();
    await reader.read().catch(() => undefined);
    await waitFor(() => (recorded.aborted ? true : undefined));
    expect((await resultOf(lastExchange())).outcome).toBe('client_aborted');
  });

  it('a Codex that leaves right after response.completed on a stream with no content-type is a complete exchange', async () => {
    // ChatGPT's Codex backend streams SSE with no content-type, and codex-cli
    // hangs up as soon as response.completed arrives (both seen live).
    const completed = sse('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}');
    upstream.setReply({ kind: 'sse', omitContentType: true, chunks: [sse('event: response.created\ndata: {"type":"response.created"}'), completed, sse('data: {"padding":1}')], delayMs: 300 });
    const controller = new AbortController();
    const response = await fetch(`${gateway.baseUrl}/r/codex/responses`, { method: 'POST', body: '{"stream":true}', signal: controller.signal });
    expect(response.headers.get('content-type')).toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('response.completed"')) {
      const next = await reader.read();
      if (next.done) break;
      received += decoder.decode(next.value);
    }
    const recorded = upstream.requests.at(-1)!;
    controller.abort();
    await reader.read().catch(() => undefined);
    await waitFor(() => (recorded.aborted ? true : undefined));
    const result = await resultOf(lastExchange());
    expect(result.outcome).toBe('complete');
    expect(result.recordedStatus).toBe(200);
  });
});

describe('a relayed request survives long silent gaps', () => {
  it('server.timeout(req, 0) keeps a stream alive past the server idle timer', async () => {
    const quietGateway = await startWireGatewayForTest({ routesFilePath, routesReloadCheckIntervalMs: 0, idleTimeoutSeconds: 1 });
    try {
      const chunks = [sse('data: {"choices":[]}'), sse('data: [DONE]')];
      // 1 s idle timer fires at about 4 s on Bun 1.3.9 (report 08 §Q2); a 6 s gap would be cut without the per-request override.
      upstream.setReply({ kind: 'sse', chunks, delayMs: 6_000 });
      const response = await fetch(`${quietGateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: '{}', keepalive: false });
      const { text, outcome } = await readStream(response);
      expect(outcome).toBe('ended');
      expect(text).toBe(chunks.join(''));
    } finally {
      await quietGateway.stop();
    }
  }, 20_000);
});

describe('bounded request bodies', () => {
  it('a chunked body over the limit is a protocol-native 413 and the vendor is never asked (Anthropic shape)', async () => {
    const requestsBefore = upstream.requests.length;
    const oversized = new Uint8Array(64 * 1024).fill(0x61);
    let sentChunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentChunks++ < 6) controller.enqueue(oversized);
        else controller.close();
      },
    });
    // keepalive:false: Bun's fetch would reuse this connection although the gateway stopped reading its body.
    const response = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', body, duplex: 'half', keepalive: false } as RequestInit);
    expect(response.status).toBe(413);
    const parsed = await response.json() as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('request_too_large');
    expect(parsed.error.message).toContain('CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES');
    expect(upstream.requests.length).toBe(requestsBefore);
  });

  it('a Content-Length body over the limit is a 413 in OpenAI shape', async () => {
    const response = await fetch(`${gateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: new Uint8Array(MAX_REQUEST_BYTES + 1) });
    expect(response.status).toBe(413);
    const parsed = await response.json() as { error: { type: string; code: unknown; message: string } };
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(typeof parsed.error.message).toBe('string');
  });

  it('a body that stalls is a protocol-native 408 (Gemini shape)', async () => {
    const requestsBefore = upstream.requests.length;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"contents":'));
      },
    });
    const startedAt = Date.now();
    // keepalive:false: Bun's fetch would reuse this connection although its body never finished.
    const response = await fetch(`${gateway.baseUrl}/r/gemini/v1beta/models/gemini-x:generateContent`, { method: 'POST', body: stalled, duplex: 'half', keepalive: false } as RequestInit);
    expect(response.status).toBe(408);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BODY_IDLE_TIMEOUT_MS - 50);
    const parsed = await response.json() as { error: { code: number; status: string; message: string } };
    expect(parsed.error).toMatchObject({ code: 408, status: 'DEADLINE_EXCEEDED' });
    expect(upstream.requests.length).toBe(requestsBefore);
  });
});

describe('compressed request bodies', () => {
  it('a Codex zstd body goes upstream compressed while the decoded copy parses', async () => {
    const json = '{"model":"gpt-x","input":[{"type":"message","role":"user","content":"hi é"}],"stream" : false}';
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(json));
    await (await fetch(`${gateway.baseUrl}/r/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd', authorization: 'Bearer sk-proj-test' },
      body: compressed,
    })).text();
    const recorded = upstream.requests.at(-1)!;
    expect(recorded.headers['content-encoding']).toBe('zstd');
    expect(Buffer.from(recorded.body).equals(Buffer.from(compressed))).toBe(true);
    expect(recorded.headers.authorization).toBe('Bearer sk-proj-test');

    const exchange = lastExchange();
    expect(exchange.captured).toBe(true);
    expect(new TextDecoder().decode(exchange.decodedRequestBody!)).toBe(json);
    expect(JSON.parse(new TextDecoder().decode(exchange.decodedRequestBody!)).model).toBe('gpt-x');
  });

  it('an unknown content-encoding is relayed untouched, capture skipped and counted', async () => {
    const before = relayCaptureSkipCounts.unknown_content_encoding ?? 0;
    const opaque = new Uint8Array([1, 2, 3, 250, 251]);
    await (await fetch(`${gateway.baseUrl}/r/codex/responses`, { method: 'POST', headers: { 'content-encoding': 'compress' }, body: opaque })).text();
    expect(Buffer.from(upstream.requests.at(-1)!.body).equals(Buffer.from(opaque))).toBe(true);
    expect(upstream.requests.at(-1)!.headers['content-encoding']).toBe('compress');
    expect(lastExchange()).toMatchObject({ captured: false, captureSkippedReason: 'unknown_content_encoding' });
    expect(relayCaptureSkipCounts.unknown_content_encoding).toBe(before + 1);
  });
});

describe('subscription sign-ins are refused before forwarding (D4)', () => {
  const cases = [
    { name: 'Claude OAuth bearer', path: '/r/claude/v1/messages', headers: { authorization: 'Bearer sk-ant-oat01-abc' }, shape: 'anthropic', agent: 'claude-code' },
    { name: 'Claude OAuth in x-api-key', path: '/r/claude/v1/messages', headers: { 'x-api-key': 'sk-ant-oat01-abc' }, shape: 'anthropic', agent: 'claude-code' },
    { name: 'oauth- anthropic-beta', path: '/r/claude/v1/messages', headers: { 'x-api-key': 'sk-ant-api03-x', 'anthropic-beta': 'fine-1, oauth-2025-04-20' }, shape: 'anthropic', agent: 'claude-code' },
    { name: 'ChatGPT JWT bearer', path: '/r/codex/responses', headers: { authorization: 'Bearer eyJhbGciOi.x.y' }, shape: 'openai', agent: 'codex' },
    { name: 'chatgpt-account-id', path: '/r/codex/chat/completions', headers: { authorization: 'Bearer sk-x', 'chatgpt-account-id': 'acct' }, shape: 'openai', agent: 'codex' },
    { name: 'chatgpt.com upstream', path: '/r/chatgpt/responses', headers: { authorization: 'Bearer sk-x' }, shape: 'openai', agent: 'codex' },
    { name: 'Google ya29 bearer', path: '/r/gemini/v1beta/models/gemini-x:streamGenerateContent', headers: { authorization: 'Bearer ya29.a0' }, shape: 'gemini', agent: 'gemini-cli' },
    { name: 'Code Assist upstream', path: '/r/code-assist/v1internal:streamGenerateContent', headers: {}, shape: 'gemini', agent: 'gemini-cli' },
    { name: 'an unclassified suffix still refused, in the vendor shape', path: '/r/claude/v1/models', headers: { authorization: 'Bearer sk-ant-oat01-abc' }, shape: 'anthropic', agent: 'claude-code' },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name}: 403 in ${testCase.shape} shape naming \`claude-mem wire disconnect ${testCase.agent}\``, async () => {
      const requestsBefore = upstream.requests.length;
      const response = await fetch(`${gateway.baseUrl}${testCase.path}`, { method: 'POST', headers: testCase.headers, body: '{}' });
      expect(response.status).toBe(403);
      const body = await response.json() as Record<string, any>;
      if (testCase.shape === 'anthropic') {
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('permission_error');
      } else if (testCase.shape === 'openai') {
        expect(body.error.type).toBe('invalid_request_error');
        expect(body.error.code).toBe('claude_mem_subscription_signin_refused');
      } else {
        expect(body.error.code).toBe(403);
        expect(body.error.status).toBe('PERMISSION_DENIED');
      }
      expect(body.error.message).toContain(`claude-mem wire disconnect ${testCase.agent}`);
      expect(upstream.requests.length).toBe(requestsBefore);
    });
  }

  it('an API key passes', async () => {
    const response = await fetch(`${gateway.baseUrl}/r/claude/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'sk-ant-api03-x' }, body: '{}' });
    expect(response.status).toBe(200);
  });
});

describe('upstream unreachable', () => {
  it('is a protocol-native 502', async () => {
    const deadRoutes = join(WIRE_GATEWAY_DIR, 'relay-test-dead-routes.json');
    rmSync(deadRoutes, { force: true });
    addWireGatewayRoute({ routeId: 'dead', agentId: 'codex', upstreamBaseUrl: 'http://127.0.0.1:1' }, deadRoutes);
    const deadGateway = await startWireGatewayForTest({ routesFilePath: deadRoutes, routesReloadCheckIntervalMs: 0 });
    try {
      const response = await fetch(`${deadGateway.baseUrl}/r/dead/chat/completions`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(502);
      const body = await response.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe('server_error');
      expect(body.error.message).toContain('127.0.0.1:1');
    } finally {
      await deadGateway.stop();
      rmSync(deadRoutes, { force: true });
    }
  });
});

describe('drain with the relay', () => {
  it('stop answers new relay requests 503 and waits for an in-flight relayed stream to end', async () => {
    const drainingGateway = await startWireGatewayForTest({ routesFilePath, routesReloadCheckIntervalMs: 0, drainTimeoutMs: 5_000 });
    const chunks = [sse('data: {"choices":[]}'), sse('data: [DONE]')];
    upstream.setReply({ kind: 'sse', chunks, delayMs: 500 });
    const response = await fetch(`${drainingGateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: '{}', keepalive: false });
    const reader = response.body!.getReader();
    await reader.read();

    const stopping = drainingGateway.stop();
    const refused = await fetch(`${drainingGateway.baseUrl}/r/codex/chat/completions`, { method: 'POST', body: '{}', keepalive: false });
    expect(refused.status).toBe(503);

    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe(chunks[1]);
    await stopping;
  });
});
