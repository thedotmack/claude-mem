import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { getSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { appendArrayItem, encodeJsonString } from '../../src/services/wire-gateway/json/splice.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { WireUsageLedger } from '../../src/services/wire-gateway/metrics/usage-ledger.js';
import { relayActivityCounts } from '../../src/services/wire-gateway/relay/relay.js';
import type { WireRewriteStage } from '../../src/services/wire-gateway/rewrite/rewrite-stage.js';
import { sse, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// The rewrite seam inside the real relay: compressed bodies, rejections,
// reply stages, the conversation ledger across requests and restarts, and
// the usage ledger line each model call leaves.

const testRoot = join(WIRE_GATEWAY_DIR, 'rewrite-relay-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const usageDirectory = join(testRoot, 'usage');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

let frozenNoteCounter = 0;

/** A stand-in for Phase 12's injection: a note frozen in the ledger on first sight, appended to `system` on every request. */
const frozenNoteStage: WireRewriteStage = {
  name: 'frozen-note',
  appliesTo: context => context.routeId === 'ledgered' && context.ledger?.status === 'born',
  onRequest: (context, body) => {
    const entry = context.ledger!.record({ type: 'injection', text: `note ${frozenNoteCounter++} <é>` });
    if (entry.type !== 'injection' || entry.text === null) return undefined;
    const systemSpan = getSpan(body, ['system']);
    if (!systemSpan || systemSpan.type !== 'array') return undefined;
    context.estimates.injectedTokens += 3;
    return appendArrayItem(body, systemSpan, `{"type":"text","text":${encodeJsonString(entry.text)}}`);
  },
};

/** Records an injection, then adds a tool result with no call: the pairing check sends the original instead. */
const pairBreakingStage: WireRewriteStage = {
  name: 'pair-breaker',
  appliesTo: context => context.routeId === 'pair-breaker' && context.ledger?.status === 'born',
  onRequest: (context, body) => {
    context.ledger!.record({ type: 'injection', text: 'never sent' });
    const messagesSpan = getSpan(body, ['messages']);
    if (!messagesSpan || messagesSpan.type !== 'array') return undefined;
    return appendArrayItem(body, messagesSpan, '{"role":"user","content":[{"type":"tool_result","tool_use_id":"ghost","content":"x"}]}');
  },
};

const stages: WireRewriteStage[] = [
  frozenNoteStage,
  pairBreakingStage,
  {
    name: 'uppercase-model',
    appliesTo: context => context.routeId === 'rewritten',
    onRequest: (_context, body) => encoder.encode(textOf(body).replace('"model":"claude-x"', '"model":"CLAUDE-X"')),
  },
  {
    name: 'refuser',
    appliesTo: context => context.routeId === 'refused',
    onRequest: () => ({ reject: { status: 429, message: 'slow down, said a stage' } }),
  },
  {
    name: 'shout-replies',
    appliesTo: context => context.routeId === 'shouted',
    onEvent: (_context, event) => (event.name === 'content_block_delta' ? { name: event.name, dataJson: event.dataJson.replace('hello', 'HELLO') } : undefined),
    onResponse: (_context, body) => encoder.encode(textOf(body).replace('hello', 'HELLO')),
  },
];

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

const startGateway = () => startWireGatewayForTest({
  routesFilePath,
  routesReloadCheckIntervalMs: 0,
  rewriteStages: stages,
  conversationLedger: new WireConversationLedger({ directory: ledgerDirectory }),
  capture: { usageLedger: new WireUsageLedger({ directory: usageDirectory }) },
});

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
  for (const routeId of ['ledgered', 'rewritten', 'refused', 'shouted', 'plain', 'pair-breaker']) {
    addWireGatewayRoute({ routeId, agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  }
  gateway = await startGateway();
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

function anthropicBody(messages: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: 'claude-x', max_tokens: 8192, system: [{ type: 'text', text: 'You are careful.' }], messages, ...extra });
}

async function post(routeId: string, body: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${gateway.baseUrl}/r/${routeId}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', ...headers },
    body,
  });
}

const anthropicSseReply = sse(
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x-served","usage":{"input_tokens":12,"cache_read_input_tokens":3000,"cache_creation_input_tokens":40,"output_tokens":0}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
);

describe('the rewrite seam in the relay', () => {
  it('forwards a rewritten gzip body decoded, without its content-encoding, and counts it once', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const rewrittenBefore = relayActivityCounts.requestsRewritten;
    const response = await post('rewritten', gzipSync(Buffer.from(anthropicBody([{ role: 'user', content: 'hi' }]))), { 'content-encoding': 'gzip' });
    await response.arrayBuffer();
    const sent = upstream.requests.at(-1)!;
    expect(sent.headers['content-encoding']).toBeUndefined();
    expect(textOf(sent.body)).toContain('"model":"CLAUDE-X"');
    expect(relayActivityCounts.requestsRewritten).toBe(rewrittenBefore + 1);
  });

  it('leaves a gzip body compressed when no stage changed it', async () => {
    const compressed = gzipSync(Buffer.from(anthropicBody([{ role: 'user', content: 'hi' }])));
    await (await post('plain', compressed, { 'content-encoding': 'gzip' })).arrayBuffer();
    const sent = upstream.requests.at(-1)!;
    expect(sent.headers['content-encoding']).toBe('gzip');
    expect(Buffer.from(sent.body).equals(compressed)).toBe(true);
  });

  it('answers a stage rejection in the agent\'s error shape and never asks the provider', async () => {
    const requestsBefore = upstream.requests.length;
    const response = await post('refused', anthropicBody([{ role: 'user', content: 'hi' }]));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ type: 'error', error: { message: 'slow down, said a stage' } });
    expect(upstream.requests.length).toBe(requestsBefore);
  });

  it('runs reply stages on a stream event by event, and on a whole JSON reply', async () => {
    upstream.setReply({ kind: 'sse', chunks: [anthropicSseReply.slice(0, 200), anthropicSseReply.slice(200)] });
    const streamed = await (await post('shouted', anthropicBody([{ role: 'user', content: 'hi' }], { stream: true }))).text();
    expect(streamed).toBe(anthropicSseReply.replace('hello', 'HELLO'));
    upstream.setReply({ kind: 'json', body: { content: [{ type: 'text', text: 'hello' }] } });
    expect(await (await post('shouted', anthropicBody([{ role: 'user', content: 'hi' }]))).json()).toEqual({ content: [{ type: 'text', text: 'HELLO' }] });
  });

  it('freezes a rewrite in the conversation ledger and re-applies it the same across requests and a restart', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const session = { 'x-claude-code-session-id': 'ledger-session-1' };
    const firstMessages = [{ role: 'user', content: 'build the thing' }];
    await (await post('ledgered', anthropicBody(firstMessages), session)).arrayBuffer();
    const firstSent = textOf(upstream.requests.at(-1)!.body);
    expect(firstSent).toContain('{"type":"text","text":"note 0 <é>"}');

    const laterMessages = [...firstMessages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now test it' }];
    await (await post('ledgered', anthropicBody(laterMessages), session)).arrayBuffer();
    const secondSent = textOf(upstream.requests.at(-1)!.body);
    expect(secondSent).toContain('note 0 <é>');
    expect(secondSent).not.toContain('note 1');
    // The system prefix the vendor caches is byte-identical across requests.
    const prefixOf = (sent: string) => sent.slice(0, sent.indexOf('"messages"'));
    expect(prefixOf(secondSent)).toBe(prefixOf(firstSent));

    await gateway.stop();
    gateway = await startGateway();
    await (await post('ledgered', anthropicBody(laterMessages), session)).arrayBuffer();
    expect(textOf(upstream.requests.at(-1)!.body)).toBe(secondSent);
  });

  it('keeps nothing in the ledger from a rewrite whose bytes did not go', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const body = anthropicBody([{ role: 'user', content: 'build the thing' }]);
    await (await post('pair-breaker', body, { 'x-claude-code-session-id': 'ledger-session-pairs' })).arrayBuffer();
    expect(textOf(upstream.requests.at(-1)!.body)).toBe(body);
    const ledgerFile = readdirSync(ledgerDirectory)
      .map(name => readFileSync(join(ledgerDirectory, name), 'utf8'))
      .filter(text => text.includes('never sent'));
    expect(ledgerFile).toEqual([]);
  });

  it('never rewrites a conversation it first sees mid-way', async () => {
    const midway = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    const body = anthropicBody(midway);
    await (await post('ledgered', body, { 'x-claude-code-session-id': 'ledger-session-midway' })).arrayBuffer();
    expect(textOf(upstream.requests.at(-1)!.body)).toBe(body);
  });

  it('writes a usage line per model call, native routes included, with cache numbers, stages and buckets', async () => {
    upstream.setReply({ kind: 'sse', chunks: [anthropicSseReply] });
    await (await post('ledgered', anthropicBody([{ role: 'user', content: 'measure me' }], { stream: true }), { 'x-claude-code-session-id': 'usage-session' })).text();
    // The usage line is written once the reply is delivered to the observers.
    let record: ReturnType<WireUsageLedger['read']>[number] | undefined;
    const usageLedger = new WireUsageLedger({ directory: usageDirectory });
    for (let attempt = 0; attempt < 50 && !record; attempt++) {
      record = usageLedger.read().find(line => line.session === 'usage-session');
      if (!record) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(record).toMatchObject({
      agent: 'claude-code',
      routeId: 'ledgered',
      model: 'claude-x-served',
      status: 200,
      in: 12,
      out: 7,
      cacheRead: 3000,
      cacheWrite: 40,
      cacheWrite1h: 0,
      kind: 'turn',
      stages: ['frozen-note'],
      injectedTokensEst: 3,
      culledTokensEst: 0,
    });
    expect(record!.ttftMs).not.toBeNull();
    expect(record!.ms).toBeGreaterThanOrEqual(record!.ttftMs!);
    expect(record!.buckets!.system).toBeGreaterThan(0);
    expect(record!.buckets!.chat).toBeGreaterThan(0);
  });
});
