import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { OutboundRedactionPlaceholders } from '../../src/services/wire-gateway/privacy/outbound-redaction.js';
import { sse, startFakeUpstream, type FakeUpstream, type RecordedUpstreamRequest } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Outbound redaction through the real relay: the provider sees placeholders,
// the agent sees its values, and a route without the feature is untouched.

const testRoot = join(WIRE_GATEWAY_DIR, 'privacy-relay-test');
const routesFilePath = join(testRoot, 'routes.json');
const anthropicKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The first placeholder the provider was sent. */
function placeholderSentIn(request: RecordedUpstreamRequest): string {
  const found = textOf(request.body).match(/\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/);
  if (!found) throw new Error(`no placeholder in ${textOf(request.body)}`);
  return found[0];
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream();
  addWireGatewayRoute({ routeId: 'redacted', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native', features: { outboundRedaction: true } }, routesFilePath);
  addWireGatewayRoute({ routeId: 'plain', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    outboundRedactionPlaceholders: new OutboundRedactionPlaceholders({ keyFilePath: join(testRoot, 'redact.key') }),
  });
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

const anthropicRequest = {
  model: 'claude-x',
  stream: true,
  max_tokens: 64,
  messages: [{ role: 'user', content: `deploy with ${anthropicKey} please` }],
};

describe('outbound redaction through the relay', () => {
  it('sends the provider a placeholder and streams the value back to the agent', async () => {
    upstream.setReply(request => {
      const placeholder = placeholderSentIn(request);
      const delta = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`;
      return {
        kind: 'sse',
        chunks: [sse(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":5,"output_tokens":0}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          delta(`using ${placeholder.slice(0, 9)}`),
          delta(`${placeholder.slice(9)} now`),
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        )],
      };
    });
    const response = await fetch(`${gateway.baseUrl}/r/redacted/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify(anthropicRequest),
    });
    const replyText = await response.text();
    const sentToProvider = textOf(upstream.requests.at(-1)!.body);
    expect(sentToProvider).not.toContain(anthropicKey);
    expect(sentToProvider).toMatch(/deploy with \{\{API_KEY_[a-z2-7]{8}\}\} please/);
    expect(upstream.requests.at(-1)!.headers['x-api-key']).toBe('test-key');
    // The placeholder's start moves into the next delta, so the joined text is whole.
    const joinedText = replyText.split('\n\n')
      .map(event => event.match(/^data: (.*)$/m)?.[1])
      .filter((data): data is string => data !== undefined)
      .map(data => (JSON.parse(data) as { delta?: { text?: string } }).delta?.text ?? '')
      .join('');
    expect(joinedText).toBe(`using ${anthropicKey} now`);
    expect(replyText).not.toContain('{{');
    expect(replyText).toContain('event: message_stop');
  });

  it('masks a gzip body and sends it decoded, without its content-encoding', async () => {
    upstream.setReply(request => ({ kind: 'json', body: { echoed: placeholderSentIn(request) } }));
    const response = await fetch(`${gateway.baseUrl}/r/redacted/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(JSON.stringify({ ...anthropicRequest, stream: false }))),
    });
    expect(await response.json()).toEqual({ echoed: anthropicKey });
    const sent = upstream.requests.at(-1)!;
    expect(sent.headers['content-encoding']).toBeUndefined();
    expect(textOf(sent.body)).not.toContain(anthropicKey);
    expect(JSON.parse(textOf(sent.body)).messages[0].content).toMatch(/^deploy with \{\{API_KEY_/);
  });

  it('refuses, never sends unmasked, a body it cannot decode (fail closed)', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const requestsBefore = upstream.requests.length;
    const response = await fetch(`${gateway.baseUrl}/r/redacted/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'x-unknown-coding' },
      body: JSON.stringify(anthropicRequest),
    });
    expect(response.status).toBe(502);
    const error = await response.json() as { type: string; error: { message: string } };
    expect(error.type).toBe('error');
    expect(error.error.message).toContain('outbound redaction');
    expect(error.error.message).not.toContain(anthropicKey);
    expect(upstream.requests.length).toBe(requestsBefore);
  });

  it('leaves a route without the feature byte for byte', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const body = JSON.stringify(anthropicRequest);
    await (await fetch(`${gateway.baseUrl}/r/plain/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).arrayBuffer();
    expect(textOf(upstream.requests.at(-1)!.body)).toBe(body);
  });
});
