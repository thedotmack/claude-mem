import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute, readWireGatewayRoutesFile, setWireGatewayRouteFeature } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { WireUsageLedger } from '../../src/services/wire-gateway/metrics/usage-ledger.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { toolPairingProblem } from '../../src/services/wire-gateway/rewrite/tool-pairing.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import {
  WireObservationLookup,
  fetchToolObservationsFromWorker,
  type WireSwapObservation,
  type WireToolObservationQuery,
} from '../../src/services/wire-gateway/endless/observation-lookup.js';
import { boundCallId, coveredReplacementText, observationReplacementText } from '../../src/services/wire-gateway/endless/endless-mode-stage.js';
import { buildEndlessModeReport, formatEndlessModeReport } from '../../src/services/wire-gateway/endless/endless-report.js';
import { validateWireGatewayListenSettings } from '../../src/services/wire-gateway/config.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Endless Mode at the wire (plan Phase 11), through the real relay: per
// protocol, a conversation born under the gateway whose first tool result
// gets an observation is swapped once, at a turn start, and stays the same
// byte for byte on every later request and across a restart.

const testRoot = join(WIRE_GATEWAY_DIR, 'endless-mode-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const usageDirectory = join(testRoot, 'usage');
const decoder = new TextDecoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

const ENDLESS_SETTINGS = {
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'true',
  // Older than 0 turns: any result of an earlier turn.
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS: '0',
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES: '1000',
};

// ---------------------------------------------------------------------------
// The fake worker behind the observation lookup

type FetcherMode = 'table' | 'hang' | 'down';
let fetcherMode: FetcherMode = 'table';
/** tool_use_id → observation, per test conversation. */
const observationsByToolUseId = new Map<string, WireSwapObservation>();
const pendingLookups = new Set<Promise<unknown>>();
const lookupQueries: WireToolObservationQuery[] = [];

async function fakeFetchToolObservations(query: WireToolObservationQuery): Promise<Map<string, WireSwapObservation>> {
  lookupQueries.push(query);
  if (fetcherMode === 'hang') return new Promise(() => undefined);
  if (fetcherMode === 'down') throw new Error('connect ECONNREFUSED');
  const found = new Map<string, WireSwapObservation>();
  for (const toolUseId of query.toolUseIds) {
    const observation = observationsByToolUseId.get(toolUseId);
    if (observation) found.set(toolUseId, observation);
  }
  return found;
}

function trackedFetcher(query: WireToolObservationQuery): Promise<Map<string, WireSwapObservation>> {
  const pending = fakeFetchToolObservations(query);
  if (fetcherMode !== 'hang') {
    pendingLookups.add(pending);
    pending.finally(() => pendingLookups.delete(pending)).catch(() => undefined);
  }
  return pending;
}

/** Let the background lookups the last request asked for finish. */
async function settleLookups(): Promise<void> {
  await Promise.allSettled([...pendingLookups]);
  await new Promise(resolve => setTimeout(resolve, 5));
}

// ---------------------------------------------------------------------------
// Conversations in each protocol

interface Turn {
  n: number;
  userText: string;
  callId: string;
  args: Record<string, unknown>;
  resultText: string;
  finalText: string;
}

function turnOf(tag: string, n: number): Turn {
  return {
    n,
    userText: `${tag}: task number ${n}, look at file ${n}`,
    callId: `call_${tag}_${n}`,
    args: { path: `/repo/${tag}/file${n}.ts` },
    resultText: `contents of file ${n} <${tag}>\n${'lorem ipsum dolor '.repeat(150)}`,
    finalText: `file ${n} is fine`,
  };
}

interface ProtocolCase {
  protocol: WireProtocol;
  routeId: string;
  agentId: string;
  path: string;
  user(turn: Turn): unknown[];
  call(turn: Turn): unknown[];
  result(turn: Turn): unknown[];
  final(turn: Turn): unknown[];
  body(items: unknown[]): string;
}

const protocolCases: ProtocolCase[] = [
  {
    protocol: 'anthropic',
    routeId: 'endless-anthropic',
    agentId: 'claude-code',
    path: '/v1/messages',
    user: turn => [{ role: 'user', content: turn.userText }],
    call: turn => [{ role: 'assistant', content: [
      { type: 'thinking', thinking: `thinking about file ${turn.n}`, signature: `sig-call-${turn.n}` },
      { type: 'tool_use', id: turn.callId, name: 'read_file', input: turn.args },
    ] }],
    result: turn => [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.callId, content: turn.resultText }] }],
    final: turn => [{ role: 'assistant', content: [
      { type: 'thinking', thinking: `wrapping up file ${turn.n}`, signature: `sig-final-${turn.n}` },
      { type: 'text', text: turn.finalText },
    ] }],
    body: items => JSON.stringify({ model: 'claude-x', max_tokens: 8192, system: [{ type: 'text', text: 'You are careful.' }], messages: items }),
  },
  {
    protocol: 'openai-chat',
    routeId: 'endless-chat',
    agentId: 'opencode',
    path: '/v1/chat/completions',
    user: turn => [{ role: 'user', content: turn.userText }],
    call: turn => [{ role: 'assistant', content: null, tool_calls: [{ id: turn.callId, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(turn.args) } }] }],
    result: turn => [{ role: 'tool', tool_call_id: turn.callId, content: turn.resultText }],
    final: turn => [{ role: 'assistant', content: turn.finalText }],
    body: items => JSON.stringify({ model: 'gpt-x', messages: items }),
  },
  {
    protocol: 'openai-responses',
    routeId: 'endless-responses',
    agentId: 'codex',
    path: '/v1/responses',
    user: turn => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.userText }] }],
    call: turn => [
      { type: 'reasoning', id: `rs_${turn.n}`, summary: [], encrypted_content: `enc-${turn.n}` },
      { type: 'function_call', call_id: turn.callId, name: 'read_file', arguments: JSON.stringify(turn.args) },
    ],
    result: turn => [{ type: 'function_call_output', call_id: turn.callId, output: turn.resultText }],
    final: turn => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.finalText }] }],
    body: items => JSON.stringify({ model: 'gpt-x', input: items }),
  },
  {
    protocol: 'gemini',
    routeId: 'endless-gemini',
    agentId: 'gemini-cli',
    path: '/v1beta/models/gemini-x:generateContent',
    user: turn => [{ role: 'user', parts: [{ text: turn.userText }] }],
    call: turn => [{ role: 'model', parts: [{ functionCall: { id: turn.callId, name: 'read_file', args: turn.args }, thoughtSignature: `ts-${turn.n}` }] }],
    result: turn => [{ role: 'user', parts: [{ functionResponse: { id: turn.callId, name: 'read_file', response: { output: turn.resultText } } }] }],
    final: turn => [{ role: 'model', parts: [{ text: turn.finalText }] }],
    body: items => JSON.stringify({ contents: items }),
  },
];

/**
 * The requests of a conversation of `turnCount` turns, in order: each turn's
 * start (its user words) and its tool loop (the call and its result).
 */
function conversationRequests(protocolCase: ProtocolCase, tag: string, turnCount: number): string[] {
  const requests: string[] = [];
  const items: unknown[] = [];
  for (let n = 1; n <= turnCount; n++) {
    const turn = turnOf(tag, n);
    if (n > 1) items.push(...protocolCase.final(turnOf(tag, n - 1)));
    items.push(...protocolCase.user(turn));
    requests.push(protocolCase.body(items));
    items.push(...protocolCase.call(turn), ...protocolCase.result(turn));
    requests.push(protocolCase.body(items));
  }
  return requests;
}

function observationFor(observationId: number): WireSwapObservation {
  return { observationId, title: `File ${observationId} read`, narrative: 'The file defines the parser <and> its tests.', facts: ['parser lives in src/', 'tests pass'] };
}

// ---------------------------------------------------------------------------
// The gateway

let upstream: FakeUpstream;
let gateway: StartedWireGateway;
let observationLookup: WireObservationLookup;

async function startGateway(): Promise<void> {
  gateway = await startEndlessGateway(ENDLESS_SETTINGS, ledgerDirectory);
}

async function startEndlessGateway(rewriteSettings: Record<string, string>, conversationLedgerDirectory: string): Promise<StartedWireGateway> {
  observationLookup = new WireObservationLookup({ fetchToolObservations: trackedFetcher, missBackoffBaseMs: 0 });
  return startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    rewriteSettings,
    observationLookup,
    conversationLedger: new WireConversationLedger({ directory: conversationLedgerDirectory }),
    capture: { usageLedger: new WireUsageLedger({ directory: usageDirectory }) },
  });
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
  for (const protocolCase of protocolCases) {
    addWireGatewayRoute({ routeId: protocolCase.routeId, agentId: protocolCase.agentId, upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  }
  addWireGatewayRoute({ routeId: 'endless-off', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native', features: { endlessMode: false } }, routesFilePath);
  addWireGatewayRoute({ routeId: 'endless-kill', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  await startGateway();
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

async function send(protocolCase: ProtocolCase, body: string, routeId = protocolCase.routeId, through: StartedWireGateway = gateway): Promise<string> {
  const response = await fetch(`${through.baseUrl}/r/${routeId}${protocolCase.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body,
  });
  await response.arrayBuffer();
  expect(response.status).toBe(200);
  return textOf(upstream.requests.at(-1)!.body);
}

/** A body's messages array (it is the body's last member), open at its end. */
function prefixOf(body: string): string {
  expect(body.endsWith(']}')).toBe(true);
  return body.slice(0, -2);
}

const anthropicCase = protocolCases[0];

describe('Endless Mode per protocol', () => {
  for (const protocolCase of protocolCases) {
    it(`${protocolCase.protocol}: swaps the first result at a turn start, then keeps a byte-identical prefix for five requests and a restart`, async () => {
      fetcherMode = 'table';
      const tag = `prefix-${protocolCase.protocol}`;
      const first = turnOf(tag, 1);
      observationsByToolUseId.set(first.callId, observationFor(101));
      const requests = conversationRequests(protocolCase, tag, 4);
      // [u1] [u1 c1 r1] [.. f1 u2] [.. c2 r2] [.. f2 u3] [.. c3 r3] [.. f3 u4] [.. c4 r4]
      const sent: string[] = [];
      for (const [index, body] of requests.entries()) {
        sent.push(await send(protocolCase, body));
        await settleLookups();
        if (index < 2) expect(sent[index]).toBe(body);
      }

      // The first swap: at the start of turn 2, never earlier.
      const swapped = sent[2];
      expect(swapped).toContain(`[claude-mem: this read_file result (call_id=${first.callId}) was replaced by observation #101]`);
      expect(swapped).toContain('File 101 read');
      expect(swapped).toContain('- parser lives in src/');
      expect(swapped).not.toContain(`contents of file 1 <${tag}>`);

      // Five consecutive requests after it: each starts with the one before.
      for (let index = 3; index < sent.length; index++) {
        expect(sent[index].startsWith(prefixOf(sent[index - 1]))).toBe(true);
      }
      // Nothing else was swapped (only call 1 had an observation), and later results went as they came.
      expect(sent[7]).toContain(`contents of file 2 <${tag}>`);

      // Pairs stay whole; ids and order stay.
      const original = parseWireRequest(protocolCase.protocol, new TextEncoder().encode(requests[7]), { suffixPath: protocolCase.path });
      const rewritten = parseWireRequest(protocolCase.protocol, new TextEncoder().encode(sent[7]), { suffixPath: protocolCase.path });
      expect(toolPairingProblem(original, rewritten)).toBeNull();
      const callIdsOf = (request: typeof original) => request.messages.flatMap(message => message.parts.filter(part => part.callId).map(part => `${part.kind}:${part.callId}`));
      expect(callIdsOf(rewritten)).toEqual(callIdsOf(original));
      expect(rewritten.system).toEqual(original.system);
      expect(rewritten.tools).toEqual(original.tools);

      // Sealed reasoning is never touched (Anthropic's is dropped after the boundary only; see below).
      if (protocolCase.protocol === 'openai-responses') for (let n = 1; n <= 4; n++) expect(sent[7]).toContain(`"encrypted_content":"enc-${n}"`);
      if (protocolCase.protocol === 'gemini') for (let n = 1; n <= 4; n++) expect(sent[7]).toContain(`"thoughtSignature":"ts-${n}"`);

      // A restart with an empty observation cache puts back the same bytes from the ledger.
      await gateway.stop();
      fetcherMode = 'down';
      await startGateway();
      expect(await send(protocolCase, requests[7])).toBe(sent[7]);
      expect(await send(protocolCase, requests[6])).toBe(sent[6]);
      fetcherMode = 'table';
    });
  }

  it('anthropic: drops thinking exactly after the boundary, up to the turn that swapped, and nowhere else', async () => {
    fetcherMode = 'table';
    const tag = 'thinking-boundary';
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(201));
    const requests = conversationRequests(anthropicCase, tag, 3);
    const sent: string[] = [];
    for (const body of requests) {
      sent.push(await send(anthropicCase, body));
      await settleLookups();
    }
    // [u1 c1 r1 f1 u2 ...]: swap in r1 (index 2); f1 (index 3) loses its thinking; c1 (index 1) keeps it.
    expect(sent[2]).toContain('"signature":"sig-call-1"');
    expect(sent[2]).not.toContain('sig-final-1');
    expect(sent[2]).not.toContain('wrapping up file 1');
    expect(sent[2]).toContain('"text":"file 1 is fine"');
    // What the model said after the swap was in place keeps its thinking on every later request.
    for (const later of sent.slice(3)) {
      expect(later).not.toContain('sig-final-1');
      expect(later).toContain('"signature":"sig-call-2"');
    }
    expect(sent[5]).toContain('"signature":"sig-final-2"');
    expect(sent[5]).toContain('"signature":"sig-call-3"');
  });

  it('never swaps mid tool-loop, even with the observation cached; swaps at the next turn start', async () => {
    fetcherMode = 'table';
    const tag = 'mid-loop';
    const requests = conversationRequests(anthropicCase, tag, 3);
    for (const body of requests.slice(0, 3)) {
      expect(await send(anthropicCase, body)).toBe(body);
      await settleLookups();
    }
    // The observation exists only now; the next request is mid tool-loop.
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(301));
    expect(await send(anthropicCase, requests[3])).toBe(requests[3]);
    await settleLookups();
    // Sent again (a retry) with the observation now cached: still mid-loop, still untouched.
    expect(await send(anthropicCase, requests[3])).toBe(requests[3]);
    // The next turn start swaps it.
    expect(await send(anthropicCase, requests[4])).toContain('was replaced by observation #301]');
  });

  it('never swaps in a conversation it first saw mid-way', async () => {
    fetcherMode = 'table';
    const tag = 'not-born';
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(401));
    const requests = conversationRequests(anthropicCase, tag, 3);
    for (const body of requests.slice(2)) {
      expect(await send(anthropicCase, body)).toBe(body);
      await settleLookups();
    }
  });

  it('keeps errors, images, edit tools, small results and cache breakpoints; a shared batch observation is shown once', async () => {
    fetcherMode = 'table';
    const tag = 'eligibility';
    const big = (label: string) => `${label}\n${'some output line '.repeat(120)}`;
    const calls = [
      { id: `${tag}_plain_a`, name: 'read_file' },
      { id: `${tag}_plain_b`, name: 'read_file' },
      { id: `${tag}_error`, name: 'read_file' },
      { id: `${tag}_edit`, name: 'Edit' },
      { id: `${tag}_small`, name: 'read_file' },
      { id: `${tag}_image`, name: 'read_file' },
      { id: `${tag}_cached`, name: 'read_file' },
    ];
    // One batch: every call's observation is #501.
    for (const call of calls) observationsByToolUseId.set(call.id, observationFor(501));
    const results = [
      { type: 'tool_result', tool_use_id: `${tag}_plain_a`, content: big('plain a') },
      { type: 'tool_result', tool_use_id: `${tag}_plain_b`, content: big('plain b') },
      { type: 'tool_result', tool_use_id: `${tag}_error`, content: big('error'), is_error: true },
      { type: 'tool_result', tool_use_id: `${tag}_edit`, content: big('edit') },
      { type: 'tool_result', tool_use_id: `${tag}_small`, content: 'small' },
      { type: 'tool_result', tool_use_id: `${tag}_image`, content: [{ type: 'text', text: big('image') }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { type: 'tool_result', tool_use_id: `${tag}_cached`, content: [{ type: 'text', text: big('cached'), cache_control: { type: 'ephemeral' } }] },
    ];
    const u1 = { role: 'user', content: `${tag}: do many things` };
    const c1 = { role: 'assistant', content: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: {} })) };
    const r1 = { role: 'user', content: results };
    const f1 = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
    const u2 = { role: 'user', content: `${tag}: next` };
    await send(anthropicCase, anthropicCase.body([u1]));
    await send(anthropicCase, anthropicCase.body([u1, c1, r1]));
    await settleLookups();
    const sent = await send(anthropicCase, anthropicCase.body([u1, c1, r1, f1, u2]));
    expect(sent).toContain(`[claude-mem: this read_file result (call_id=${tag}_plain_a) was replaced by observation #501]`);
    expect(sent).toContain(`[claude-mem: this read_file result (call_id=${tag}_plain_b) is covered by observation #501 above (call_id=${tag}_plain_a)]`);
    for (const kept of ['error', 'edit', 'image', 'cached']) expect(sent).toContain(`${kept}\\nsome output line`);
    expect(sent).toContain('"content":"small"');
    expect(sent).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('adds no swap when dropping thinking would leave an assistant message empty', async () => {
    fetcherMode = 'table';
    const tag = 'empty-assistant';
    const turn = turnOf(tag, 1);
    observationsByToolUseId.set(turn.callId, observationFor(601));
    const u1 = anthropicCase.user(turn);
    const loop = [...anthropicCase.call(turn), ...anthropicCase.result(turn)];
    const thinkingOnly = { role: 'assistant', content: [{ type: 'thinking', thinking: 'nothing to say', signature: 'sig-only' }] };
    await send(anthropicCase, anthropicCase.body(u1));
    await send(anthropicCase, anthropicCase.body([...u1, ...loop]));
    await settleLookups();
    const body = anthropicCase.body([...u1, ...loop, thinkingOnly, ...anthropicCase.user(turnOf(tag, 2))]);
    expect(await send(anthropicCase, body)).toBe(body);
    // Nothing was frozen either: the next request of the loop goes as it came too.
    const next = anthropicCase.body([...u1, ...loop, thinkingOnly, ...anthropicCase.user(turnOf(tag, 2)), ...anthropicCase.call(turnOf(tag, 2))]);
    expect(await send(anthropicCase, next)).toBe(next);
  });

  it('with the worker down or hanging, sends every request byte-identical and never waits for it', async () => {
    const timeConversation = async (routeId: string, tag: string) => {
      const requests = conversationRequests(anthropicCase, tag, 4);
      const started = performance.now();
      for (const body of requests) expect(await send(anthropicCase, body, routeId)).toBe(body);
      return performance.now() - started;
    };
    // Warm up both paths, then compare against a route with Endless Mode off.
    fetcherMode = 'hang';
    await timeConversation('endless-off', 'warm-off');
    await timeConversation(anthropicCase.routeId, 'warm-on');
    const baselineMs = await timeConversation('endless-off', 'baseline');
    const hangingMs = await timeConversation(anthropicCase.routeId, 'worker-hangs');
    fetcherMode = 'down';
    const downMs = await timeConversation(anthropicCase.routeId, 'worker-down');
    fetcherMode = 'table';
    // Eight requests each; a lookup that hangs forever must cost none of them anything noticeable.
    expect(hangingMs).toBeLessThan(baselineMs + 250);
    expect(downMs).toBeLessThan(baselineMs + 250);
  });

  it('a route switched off stops swapping at once, and never resumes a conversation it went unswapped in', async () => {
    fetcherMode = 'table';
    const tag = 'kill-switch';
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(701));
    const requests = conversationRequests(anthropicCase, tag, 3);
    for (const body of requests.slice(0, 2)) {
      await send(anthropicCase, body, 'endless-kill');
      await settleLookups();
    }
    expect(await send(anthropicCase, requests[2], 'endless-kill')).toContain('#701');
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', false, routesFilePath)).toBe(true);
    expect(readWireGatewayRoutesFile(routesFilePath).routes['endless-kill'].features.endlessMode).toBe(false);
    // Off: the history goes as the agent wrote it, mid tool-loop included.
    expect(await send(anthropicCase, requests[3], 'endless-kill')).toBe(requests[3]);
    // On again: the model has answered the original history since, so this conversation stays unswapped.
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', true, routesFilePath)).toBe(true);
    for (const body of requests.slice(4)) expect(await send(anthropicCase, body, 'endless-kill')).toBe(body);
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', undefined, routesFilePath)).toBe(true);
    expect(readWireGatewayRoutesFile(routesFilePath).routes['endless-kill'].features).toEqual({});
    expect(setWireGatewayRouteFeature('no-such-route', 'endlessMode', false, routesFilePath)).toBe(false);
  });

  it('switched off and on with no request between, keeps putting the same swaps back', async () => {
    fetcherMode = 'table';
    const tag = 'kill-switch-idle';
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(702));
    const requests = conversationRequests(anthropicCase, tag, 2);
    const sent: string[] = [];
    for (const body of requests.slice(0, 3)) {
      sent.push(await send(anthropicCase, body, 'endless-kill'));
      await settleLookups();
    }
    expect(sent[2]).toContain('#702');
    setWireGatewayRouteFeature('endless-kill', 'endlessMode', false, routesFilePath);
    setWireGatewayRouteFeature('endless-kill', 'endlessMode', undefined, routesFilePath);
    expect((await send(anthropicCase, requests[3], 'endless-kill')).startsWith(prefixOf(sent[2]))).toBe(true);
  });

  it('anthropic: a second swap in an already-swapped message drops the thinking said since the first', async () => {
    fetcherMode = 'table';
    const tag = 'second-batch';
    const big = (label: string) => `${label}\n${'more output '.repeat(200)}`;
    const thinking = (signature: string) => ({ type: 'thinking', thinking: `about ${signature}`, signature });
    const u1 = { role: 'user', content: `${tag}: read two files` };
    const c1 = { role: 'assistant', content: [thinking('sig-c1'), { type: 'tool_use', id: `${tag}_a`, name: 'read_file', input: {} }, { type: 'tool_use', id: `${tag}_b`, name: 'read_file', input: {} }] };
    const r1 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${tag}_a`, content: big('file a') }, { type: 'tool_result', tool_use_id: `${tag}_b`, content: big('file b') }] };
    const f1 = { role: 'assistant', content: [thinking('sig-f1'), { type: 'text', text: 'read both' }] };
    const u2 = { role: 'user', content: `${tag}: now check something` };
    const c2 = { role: 'assistant', content: [thinking('sig-c2'), { type: 'tool_use', id: `${tag}_c`, name: 'read_file', input: {} }] };
    const r2 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${tag}_c`, content: 'short' }] };
    const f2 = { role: 'assistant', content: [thinking('sig-f2'), { type: 'text', text: 'checked' }] };
    const u3 = { role: 'user', content: `${tag}: and finally` };
    observationsByToolUseId.set(`${tag}_a`, observationFor(801));
    await send(anthropicCase, anthropicCase.body([u1]));
    await send(anthropicCase, anthropicCase.body([u1, c1, r1]));
    await settleLookups();
    // Turn 2: a is swapped in message 2; f1 (message 3) loses its thinking.
    const turn2 = await send(anthropicCase, anthropicCase.body([u1, c1, r1, f1, u2]));
    expect(turn2).toContain('#801');
    expect(turn2).not.toContain('sig-f1');
    // b's observation arrives; the loop request asks for it but swaps nothing.
    observationsByToolUseId.set(`${tag}_b`, observationFor(802));
    const loop2 = anthropicCase.body([u1, c1, r1, f1, u2, c2, r2]);
    expect((await send(anthropicCase, loop2)).includes('sig-c2')).toBe(true);
    await settleLookups();
    // Turn 3: b is swapped in the same message 2, so what was said since turn 2 (c2, f2) was said over
    // the original b and loses its thinking too; c1, before both swaps, keeps its own.
    const turn3 = await send(anthropicCase, anthropicCase.body([u1, c1, r1, f1, u2, c2, r2, f2, u3]));
    expect(turn3).toContain('#802');
    expect(turn3).not.toContain('sig-c2');
    expect(turn3).not.toContain('sig-f2');
    expect(turn3).toContain('sig-c1');
    // The next request of the loop puts both drops back byte for byte.
    const c3 = { role: 'assistant', content: [thinking('sig-c3'), { type: 'tool_use', id: `${tag}_d`, name: 'read_file', input: {} }] };
    const r3 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${tag}_d`, content: 'short' }] };
    const loop3 = await send(anthropicCase, anthropicCase.body([u1, c1, r1, f1, u2, c2, r2, f2, u3, c3, r3]));
    expect(loop3.startsWith(prefixOf(turn3))).toBe(true);
    expect(loop3).toContain('sig-c3');
  });

  it('anthropic: a recorded drop that would empty a reply sends the request as it came and suspends the conversation', async () => {
    fetcherMode = 'table';
    const tag = 'recorded-drop-empties';
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(1001));
    const requests = conversationRequests(anthropicCase, tag, 3);
    for (const body of requests.slice(0, 2)) {
      await send(anthropicCase, body);
      await settleLookups();
    }
    expect(await send(anthropicCase, requests[2])).toContain('#1001');
    // The agent now sends f1 (inside the recorded drop) as thinking alone.
    const turn = turnOf(tag, 1);
    const altered = anthropicCase.body([
      ...anthropicCase.user(turn), ...anthropicCase.call(turn), ...anthropicCase.result(turn),
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking', signature: 'sig-only' }] },
      ...anthropicCase.user(turnOf(tag, 2)),
    ]);
    expect(await send(anthropicCase, altered)).toBe(altered);
    // Suspended: even the ordinary history is never swapped again.
    for (const body of requests.slice(3)) expect(await send(anthropicCase, body)).toBe(body);
  });

  it('with the default minimum age of 3, swaps a result only once more than 3 turns have begun after it', async () => {
    fetcherMode = 'table';
    const tag = 'default-age';
    observationsByToolUseId.set(turnOf(tag, 1).callId, observationFor(901));
    const agedGateway = await startEndlessGateway({ ...ENDLESS_SETTINGS, CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS: '3' }, join(testRoot, 'ledger-default-age'));
    try {
      const requests = conversationRequests(anthropicCase, tag, 5);
      const sent: string[] = [];
      for (const body of requests) {
        sent.push(await send(anthropicCase, body, anthropicCase.routeId, agedGateway));
        await settleLookups();
      }
      // Turn starts 2, 3 and 4 (1, 2 and 3 turns after the result): untouched.
      for (const index of [2, 4, 6]) expect(sent[index]).toBe(requests[index]);
      // Turn 5 starts the fourth turn after it: swapped.
      expect(sent[8]).toContain('was replaced by observation #901]');
    } finally {
      await agedGateway.stop();
    }
  });

  it('records swapped tokens in the usage ledger, which status --endless reads', async () => {
    let records: ReturnType<WireUsageLedger['read']> = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      records = new WireUsageLedger({ directory: usageDirectory }).read();
      if (records.some(record => record.swappedTokensEst > 0)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const swappedRecord = records.find(record => record.swappedTokensEst > 0);
    expect(swappedRecord?.stages).toEqual(['endless-mode']);
    const report = buildEndlessModeReport(records);
    expect(report.map(agent => agent.agentId)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini-cli', 'opencode']));
    expect(report.every(agent => agent.tokensSaved > 0)).toBe(true);
  });
});

describe('the observation lookup', () => {
  it('never waits, dedupes a lookup in flight, and caches no failure', async () => {
    let now = 0;
    let calls = 0;
    let answer: 'fail' | Map<string, WireSwapObservation> = 'fail';
    let release!: () => void;
    const lookup = new WireObservationLookup({
      missBackoffBaseMs: 1_000,
      now: () => now,
      fetchToolObservations: async () => {
        calls++;
        await new Promise<void>(resolve => { release = resolve; });
        if (answer === 'fail') throw new Error('worker down');
        return answer;
      },
    });
    const query = { contentSessionId: 's', platformSource: 'codex', toolUseIds: ['a', 'b'] };
    const first = lookup.requestRefresh('conversation', query);
    expect(lookup.requestRefresh('conversation', query)).toBe(first);
    expect(calls).toBe(1);
    release();
    await first;
    expect(lookup.cached('conversation', 'a')).toBeUndefined();
    // After a failure, nothing is asked until the wait is over; then it is asked again.
    await lookup.requestRefresh('conversation', query);
    expect(calls).toBe(1);
    now = 1_000;
    answer = new Map([['a', observationFor(9)]]);
    const second = lookup.requestRefresh('conversation', query);
    expect(calls).toBe(2);
    release();
    await second;
    expect(lookup.cached('conversation', 'a')?.observationId).toBe(9);
    expect(lookup.cached('conversation', 'b')).toBeUndefined();
  });

  it('asks again about a missing observation less and less often, and never about a found one', async () => {
    let now = 0;
    const asked: Array<{ at: number; ids: string[] }> = [];
    let found = new Map<string, WireSwapObservation>([['a', observationFor(9)]]);
    const lookup = new WireObservationLookup({
      missBackoffBaseMs: 5_000,
      now: () => now,
      fetchToolObservations: async query => { asked.push({ at: now, ids: query.toolUseIds }); return found; },
    });
    const query = { contentSessionId: 's', platformSource: 'codex', toolUseIds: ['a', 'b'] };
    for (const at of [0, 1_000, 5_000, 9_000, 15_000, 35_000]) {
      now = at;
      await lookup.requestRefresh('c', query);
    }
    // b missed at 0 (wait 5 s), at 5 000 (wait 10 s), at 15 000 (wait 20 s): asked again at 35 000.
    expect(asked).toEqual([
      { at: 0, ids: ['a', 'b'] },
      { at: 5_000, ids: ['b'] },
      { at: 15_000, ids: ['b'] },
      { at: 35_000, ids: ['b'] },
    ]);
    found = new Map([['b', observationFor(10)]]);
    now = 200_000;
    await lookup.requestRefresh('c', query);
    expect(lookup.cached('c', 'b')?.observationId).toBe(10);
  });

  it('reads tool uses\' observations from the worker\'s /api/wire/tool-observations', async () => {
    const worker = await startFakeUpstream(request => request.path === '/api/wire/tool-observations'
      ? { kind: 'json', body: { observations: [{ toolUseId: 'toolu_1', observationId: 42, title: 'Parser read', narrative: 'It parses.', facts: ['one', 'two'] }] } }
      : { kind: 'json', status: 404, body: { error: 'not found' } });
    try {
      const found = await fetchToolObservationsFromWorker(
        { contentSessionId: 'session-1', platformSource: 'claude-code', toolUseIds: ['toolu_1', 'toolu_2'] },
        apiPath => `${worker.url}${apiPath}`,
      );
      expect([...found.entries()]).toEqual([['toolu_1', { observationId: 42, title: 'Parser read', narrative: 'It parses.', facts: ['one', 'two'] }]]);
      expect(worker.requests.map(request => [request.path, JSON.parse(textOf(request.body))])).toEqual([
        ['/api/wire/tool-observations', { platformSource: 'claude-code', contentSessionId: 'session-1', toolUseIds: ['toolu_1', 'toolu_2'] }],
      ]);
      // (Caught by hand: `expect(promise).rejects` crashes Bun 1.3.9 here.)
      const failure = await fetchToolObservationsFromWorker(
        { contentSessionId: 's', platformSource: 'p', toolUseIds: ['x'] },
        apiPath => `${worker.url}/missing${apiPath}`,
      ).then(() => null, (error: unknown) => error);
      expect(String(failure)).toContain('HTTP 404');
    } finally {
      await worker.stop();
    }
  });
});

describe('replacement text', () => {
  it('is deterministic, bounded to 4,000 characters, and names a long call id by its hash', () => {
    const longId = `call_${'z'.repeat(80)}`;
    const text = observationReplacementText('read_file', longId, { observationId: 7, title: 'T', narrative: 'n'.repeat(5_000), facts: ['f'] });
    expect(text.length).toBe(4_000);
    expect(text.startsWith(`[claude-mem: this read_file result (call_id=${boundCallId(longId)}) was replaced by observation #7]\nT\nnnn`)).toBe(true);
    expect(boundCallId(longId)).toMatch(/^[0-9a-f]{64}$/);
    expect(boundCallId('call_short')).toBe('call_short');
    expect(observationReplacementText('read_file', 'c', observationFor(3))).toBe(observationReplacementText('read_file', 'c', observationFor(3)));
    expect(coveredReplacementText('grep', 'c2', 3, 'c1')).toBe('[claude-mem: this grep result (call_id=c2) is covered by observation #3 above (call_id=c1)]');
  });
});

describe('status --endless', () => {
  it('splits each conversation at its first swap and adds up the tokens saved, per agent', () => {
    const record = (session: string, t: string, cacheRead: number, cacheWrite: number, swappedTokensEst = 0) => ({
      t, agent: 'codex', session, routeId: 'r', model: 'm', status: 200, in: 1, out: 1, cacheRead, cacheWrite, cacheWrite1h: 0,
      reasoning: 0, ms: 1, ttftMs: 1, kind: 'turn', stages: swappedTokensEst > 0 ? ['endless-mode'] : [], injectedTokensEst: 0, swappedTokensEst,
    });
    const report = buildEndlessModeReport([
      record('s1', '2026-10-01T00:00:01Z', 100, 100),
      record('s1', '2026-10-01T00:00:02Z', 900, 100),
      record('s1', '2026-10-01T00:00:03Z', 0, 800, 500),
      record('s1', '2026-10-01T00:00:04Z', 800, 0, 500),
      record('s2', '2026-10-01T00:00:05Z', 50, 50),
    ]);
    expect(report).toEqual([{
      agentId: 'codex',
      conversationsSwapped: 1,
      requestsSwapped: 2,
      beforeFirstSwap: { requests: 2, cacheRead: 1000, cacheWrite: 200, readWriteRatio: 5 },
      afterFirstSwap: { requests: 2, cacheRead: 800, cacheWrite: 800, readWriteRatio: 1 },
      tokensSaved: 1000,
    }]);
    expect(formatEndlessModeReport(report, 7).join('\n')).toContain('codex: 1 conversations, 2 requests with swaps, ~1000 tokens saved');
    expect(formatEndlessModeReport([], 7)[0]).toContain('no swaps');
  });
});

describe('Endless Mode settings', () => {
  it('are validated at start', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'yes' })).toContain('ENDLESS_MODE');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS: '-1' })).toContain('MIN_AGE_TURNS');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS: '0' })).toBeNull();
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES: '-1' })).toContain('MIN_RESULT_BYTES');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'true', CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS: '3', CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES: '2048' })).toBeNull();
  });
});
