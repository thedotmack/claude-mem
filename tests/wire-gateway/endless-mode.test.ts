import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute, readWireGatewayRoutesFile, setWireGatewayRouteFeature } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger, conversationKeyOf } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { WireUsageLedger } from '../../src/services/wire-gateway/metrics/usage-ledger.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { startsUserTurn } from '../../src/services/wire-gateway/identity/turn-start.js';
import { userWordsInText } from '../../src/services/wire-gateway/identity/user-words.js';
import { arrayElements, getSpan, rawText, type JsonSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { toolPairingProblem } from '../../src/services/wire-gateway/rewrite/tool-pairing.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import {
  WireObservationLookup,
  fetchToolObservationsFromWorker,
  type WireToolObservation,
  type WireToolObservationQuery,
} from '../../src/services/wire-gateway/endless/observation-lookup.js';
import { culledWorkBlock } from '../../src/services/wire-gateway/endless/endless-mode-stage.js';
import { buildEndlessModeReport, formatEndlessModeReport, readEndlessModeReport } from '../../src/services/wire-gateway/endless/endless-report.js';
import { validateWireGatewayListenSettings } from '../../src/services/wire-gateway/config.js';
import { stripMemoryTags } from '../../src/utils/tag-stripping.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { expectDiffersOnlyInsideDeclaredSpans, expectMatchesGoldenFile, type DeclaredSpan } from './golden/golden-harness.js';

// Endless Mode v2 (plan Phase 4), through the real relay: per protocol, a
// conversation born under the gateway has each finished stretch of tool
// work whose observation exists culled (whole messages out, the
// observations' timeline lines appended to the turn's user message), at a
// turn start, or mid-turn when the turn holds no reasoning; the result is
// the same bytes on every later request and after a restart.

const testRoot = join(WIRE_GATEWAY_DIR, 'endless-mode-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const usageDirectory = join(testRoot, 'usage');
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

const ENDLESS_SETTINGS = { CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'true' };

// ---------------------------------------------------------------------------
// The fake worker behind the observation lookup

type FetcherMode = 'table' | 'hang' | 'down';
let fetcherMode: FetcherMode = 'table';
/** tool_use_id → observation. */
const observationsByToolUseId = new Map<string, WireToolObservation>();
const pendingLookups = new Set<Promise<unknown>>();
/** When set, every tool use asked about has this observation (for ids the test cannot know, such as Gemini's derived ones). */
let observationForEveryToolUse: WireToolObservation | null = null;

async function fakeFetchToolObservations(query: WireToolObservationQuery): Promise<Map<string, WireToolObservation>> {
  if (fetcherMode === 'hang') return new Promise(() => undefined);
  if (fetcherMode === 'down') throw new Error('connect ECONNREFUSED');
  const found = new Map<string, WireToolObservation>();
  for (const toolUseId of query.toolUseIds) {
    const observation = observationForEveryToolUse ?? observationsByToolUseId.get(toolUseId);
    if (observation) found.set(toolUseId, observation);
  }
  return found;
}

function trackedFetcher(query: WireToolObservationQuery): Promise<Map<string, WireToolObservation>> {
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

/** An observation as the worker answers it; the title has markup, quotes and non-ASCII, kept as they are. */
function observationFor(observationId: number): WireToolObservation {
  const title = `File ${observationId} read <b> & "q" é`;
  return { observationId, timelineLine: `#${observationId} 3:04p 🔵 ${title}` };
}
const lineOf = (observationId: number) => observationFor(observationId).timelineLine;

// ---------------------------------------------------------------------------
// Conversations in each protocol

interface Call {
  id: string;
  resultText?: string;
}

interface ProtocolCase {
  protocol: WireProtocol;
  routeId: string;
  agentId: string;
  path: string;
  /** The array each item below is an element of. */
  turnsKey: string;
  user(text: string): unknown[];
  /** One model message making these calls at once; with `reasoning`, it carries thinking / sealed reasoning / a signature. */
  calls(calls: Call[], reasoning: boolean): unknown[];
  results(calls: Call[]): unknown[];
  final(text: string, reasoning: boolean): unknown[];
  body(items: unknown[]): string;
  /** Where the turn's user message at element `index` takes appended text (its content string or block array). */
  userContentPath(index: number): Array<string | number>;
}

const resultTextOf = (call: Call) => call.resultText ?? `contents of ${call.id} <x>\n${'lorem ipsum '.repeat(20)}`;

const protocolCases: ProtocolCase[] = [
  {
    protocol: 'anthropic', routeId: 'endless-anthropic', agentId: 'claude-code', path: '/v1/messages', turnsKey: 'messages',
    user: text => [{ role: 'user', content: text }],
    calls: (calls, reasoning) => [{ role: 'assistant', content: [
      ...(reasoning ? [{ type: 'thinking', thinking: `thinking before ${calls[0].id}`, signature: `sig-${calls[0].id}` }] : []),
      ...calls.map(call => ({ type: 'tool_use', id: call.id, name: 'read_file', input: { path: `/repo/${call.id}` } })),
    ] }],
    results: calls => [{ role: 'user', content: calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: resultTextOf(call) })) }],
    final: (text, reasoning) => [{ role: 'assistant', content: [
      ...(reasoning ? [{ type: 'thinking', thinking: `wrapping up: ${text}`, signature: `sig-final-${text}` }] : []),
      { type: 'text', text },
    ] }],
    body: items => JSON.stringify({ model: 'claude-x', max_tokens: 8192, system: [{ type: 'text', text: 'You are careful.' }], messages: items }),
    userContentPath: index => ['messages', index, 'content'],
  },
  {
    protocol: 'openai-chat', routeId: 'endless-chat', agentId: 'opencode', path: '/v1/chat/completions', turnsKey: 'messages',
    user: text => [{ role: 'user', content: text }],
    calls: (calls, reasoning) => [{
      role: 'assistant', content: null,
      ...(reasoning ? { reasoning_content: `thinking before ${calls[0].id}` } : {}),
      tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `/repo/${call.id}` }) } })),
    }],
    results: calls => calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: resultTextOf(call) })),
    final: (text, reasoning) => [{ role: 'assistant', content: text, ...(reasoning ? { reasoning_content: `wrapping up: ${text}` } : {}) }],
    body: items => JSON.stringify({ model: 'gpt-x', messages: items }),
    userContentPath: index => ['messages', index, 'content'],
  },
  {
    protocol: 'openai-responses', routeId: 'endless-responses', agentId: 'codex', path: '/v1/responses', turnsKey: 'input',
    user: text => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    calls: (calls, reasoning) => [
      ...(reasoning ? [{ type: 'reasoning', id: `rs_${calls[0].id}`, summary: [], encrypted_content: `enc-${calls[0].id}` }] : []),
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: 'read_file', arguments: JSON.stringify({ path: `/repo/${call.id}` }) })),
    ],
    results: calls => calls.map(call => ({ type: 'function_call_output', call_id: call.id, output: resultTextOf(call) })),
    final: (text, reasoning) => [
      ...(reasoning ? [{ type: 'reasoning', id: `rs_final_${text.length}`, summary: [], encrypted_content: `enc-final-${text}` }] : []),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ],
    body: items => JSON.stringify({ model: 'gpt-x', input: items }),
    userContentPath: index => ['input', index, 'content'],
  },
  {
    protocol: 'gemini', routeId: 'endless-gemini', agentId: 'gemini-cli', path: '/v1beta/models/gemini-x:generateContent', turnsKey: 'contents',
    user: text => [{ role: 'user', parts: [{ text }] }],
    calls: (calls, reasoning) => [{ role: 'model', parts: calls.map((call, index) => ({
      functionCall: { id: call.id, name: 'read_file', args: { path: `/repo/${call.id}` } },
      ...(reasoning && index === 0 ? { thoughtSignature: `ts-${call.id}` } : {}),
    })) }],
    results: calls => [{ role: 'user', parts: calls.map(call => ({ functionResponse: { id: call.id, name: 'read_file', response: { output: resultTextOf(call) } } })) }],
    final: (text, reasoning) => [{ role: 'model', parts: [{ text, ...(reasoning ? { thoughtSignature: `ts-final-${text}` } : {}) }] }],
    body: items => JSON.stringify({ contents: items }),
    userContentPath: index => ['contents', index, 'parts'],
  },
];
const anthropicCase = protocolCases[0];

/** A conversation built item by item, with the element range each step added, and each request's body. */
class Conversation {
  readonly items: unknown[] = [];
  private readonly rangeByLabel = new Map<string, { first: number; last: number }>();
  constructor(readonly protocolCase: ProtocolCase) {}

  add(label: string, items: unknown[]): this {
    this.rangeByLabel.set(label, { first: this.items.length, last: this.items.length + items.length - 1 });
    this.items.push(...items);
    return this;
  }

  range(label: string): { first: number; last: number } {
    const range = this.rangeByLabel.get(label);
    if (!range) throw new Error(`no step ${label}`);
    return range;
  }

  body(): string {
    return this.protocolCase.body(this.items);
  }
}

// ---------------------------------------------------------------------------
// The gateway

let upstream: FakeUpstream;
let gateway: StartedWireGateway;
let observationLookup: WireObservationLookup;

async function startGateway(): Promise<void> {
  observationLookup = new WireObservationLookup({ fetchToolObservations: trackedFetcher, missBackoffBaseMs: 0 });
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    rewriteSettings: ENDLESS_SETTINGS,
    observationLookup,
    conversationLedger: new WireConversationLedger({ directory: ledgerDirectory }),
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

let sessionCounter = 0;
const nextSession = (tag: string) => `endless-${tag}-${++sessionCounter}`;

/** Sends `body` and returns what the vendor got. */
async function send(protocolCase: ProtocolCase, body: string, session: string, routeId = protocolCase.routeId): Promise<string> {
  const before = upstream.requests.length;
  const response = await fetch(`${gateway.baseUrl}/r/${routeId}${protocolCase.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'x-claude-mem-session': session },
    body,
  });
  await response.arrayBuffer();
  expect(response.status).toBe(200);
  expect(upstream.requests.length).toBe(before + 1);
  return textOf(upstream.requests.at(-1)!.body);
}

/** Sends `body`, then lets the lookups it asked for finish. */
async function sendAndSettle(protocolCase: ProtocolCase, body: string, session: string, routeId?: string): Promise<string> {
  const sent = await send(protocolCase, body, session, routeId);
  await settleLookups();
  return sent;
}

/** A body's conversation array (it is the body's last member), open at its end. */
function prefixOf(body: string): string {
  expect(body.endsWith(']}')).toBe(true);
  return body.slice(0, -2);
}

function ledgerEntriesOf(agentId: string, session: string): Array<Record<string, unknown>> {
  const filePath = join(ledgerDirectory, `${conversationKeyOf({ agentId, sessionId: session })}.jsonl`);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>);
}

const escapedInJson = (text: string) => JSON.stringify(text).slice(1, -1);
const workBlockOf = (...observationIds: number[]) => culledWorkBlock(observationIds.map(lineOf));

const spanAt = (body: Uint8Array, path: Array<string | number>): JsonSpan => {
  const span = getSpan(body, path);
  if (!span) throw new Error(`no ${path.join('.')}`);
  return span;
};
const elementsOf = (body: Uint8Array, path: Array<string | number>) => [...arrayElements(body, spanAt(body, path))];

/** Where a user message's content takes appended text: before a string's closing quote, after an array's last element. */
function appendPointOf(body: Uint8Array, contentPath: Array<string | number>): DeclaredSpan {
  const span = spanAt(body, contentPath);
  const at = span.type === 'string' ? span.end - 1 : elementsOf(body, contentPath).at(-1)!.end;
  return { start: at, end: at };
}

/** The bytes a cull of elements first..last removes: from the end of the element before them to the end of the last. */
function removedRangeOf(body: Uint8Array, protocolCase: ProtocolCase, range: { first: number; last: number }): DeclaredSpan {
  const elements = elementsOf(body, [protocolCase.turnsKey]);
  return { start: elements[range.first - 1].end, end: elements[range.last].end };
}

/** Each Anthropic thinking block in messages[from..until), as a span that takes its trailing comma too (what a cut removes). */
function anthropicThinkingSpans(body: Uint8Array, from: number, until: number): DeclaredSpan[] {
  const spans: DeclaredSpan[] = [];
  for (let messageIndex = from; messageIndex < until; messageIndex++) {
    const contentSpan = getSpan(body, ['messages', messageIndex, 'content']);
    if (contentSpan?.type !== 'array') continue;
    const blocks = [...arrayElements(body, contentSpan)];
    blocks.forEach((block, blockIndex) => {
      if (!rawText(body, block).startsWith('{"type":"thinking"')) return;
      spans.push({ start: block.start, end: blockIndex + 1 < blocks.length ? blocks[blockIndex + 1].start : block.end });
    });
  }
  return spans;
}

function expectPairsWhole(protocolCase: ProtocolCase, original: string, rewritten: string): void {
  const parse = (body: string) => parseWireRequest(protocolCase.protocol, encoder.encode(body), protocolCase.path);
  const originalRequest = parse(original);
  const rewrittenRequest = parse(rewritten);
  expect(toolPairingProblem(originalRequest, rewrittenRequest)).toBeNull();
  expect(rewrittenRequest.system).toEqual(originalRequest.system);
  expect(rewrittenRequest.tools).toEqual(originalRequest.tools);
}

// ---------------------------------------------------------------------------

describe('Endless Mode v2 per protocol', () => {
  for (const protocolCase of protocolCases) {
    it(`${protocolCase.protocol}: a finished turn is culled at the next turn start (none mid-turn with reasoning on), frozen across requests and a restart`, async () => {
      fetcherMode = 'table';
      const tag = `finished-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const callA = { id: `call_${tag}_a` };
      const callB = { id: `call_${tag}_b` };
      const callC = { id: `call_${tag}_c` };
      observationsByToolUseId.set(callA.id, observationFor(101));
      observationsByToolUseId.set(callB.id, observationFor(102));
      const conversation = new Conversation(protocolCase).add('u1', protocolCase.user(`${tag}: read two files`));
      const requests: string[] = [conversation.body()];
      conversation.add('ca', protocolCase.calls([callA], true)).add('ra', protocolCase.results([callA]));
      requests.push(conversation.body());
      conversation.add('cb', protocolCase.calls([callB], true)).add('rb', protocolCase.results([callB]));
      requests.push(conversation.body());
      conversation.add('f1', protocolCase.final('read both', true)).add('u2', protocolCase.user(`${tag}: now another`));
      requests.push(conversation.body());
      conversation.add('cc', protocolCase.calls([callC], true)).add('rc', protocolCase.results([callC]));
      requests.push(conversation.body());
      conversation.add('f2', protocolCase.final('read it', true)).add('u3', protocolCase.user(`${tag}: and finally`));
      requests.push(conversation.body());

      const sent: string[] = [];
      for (const body of requests) sent.push(await sendAndSettle(protocolCase, body, session));

      // Nothing before the turn start, mid-turn included: the turn holds reasoning bound to the prefix.
      for (const index of [0, 1, 2]) expect(sent[index]).toBe(requests[index]);

      // The turn start culls turn 1's work whole and appends its lines to turn 1's user message.
      const culled = sent[3];
      expect(culled).toContain(escapedInJson(workBlockOf(101, 102)));
      for (const call of [callA, callB]) expect(culled).not.toContain(call.id);
      expect(culled).toContain('read both');
      expect(culled.indexOf('<claude-mem-work>')).toBeGreaterThan(culled.indexOf(`${tag}: read two files`));
      expect(culled.indexOf('<claude-mem-work>')).toBeLessThan(culled.indexOf('read both'));
      const input3 = encoder.encode(requests[3]);
      const declared: DeclaredSpan[] = [
        appendPointOf(input3, protocolCase.userContentPath(conversation.range('u1').first)),
        removedRangeOf(input3, protocolCase, { first: conversation.range('ca').first, last: conversation.range('rb').last }),
        // Anthropic: the thinking of turn 1's final reply is cut too (the rest went with the culled messages).
        ...(protocolCase.protocol === 'anthropic' ? anthropicThinkingSpans(input3, conversation.range('f1').first, conversation.range('f1').last + 1) : []),
      ];
      expectMatchesGoldenFile(`endless-cull-${protocolCase.protocol}`, encoder.encode(culled));
      expectDiffersOnlyInsideDeclaredSpans(input3, encoder.encode(culled), declared);

      // Every later request starts with the one before; call c has no observation, so nothing more is culled.
      expect(sent[4].startsWith(prefixOf(sent[3]))).toBe(true);
      expect(sent[5].startsWith(prefixOf(sent[4]))).toBe(true);
      expect(sent[5]).toContain(callC.id);
      expectPairsWhole(protocolCase, requests[5], sent[5]);

      // Sealed reasoning outside the culled work is kept.
      if (protocolCase.protocol === 'openai-responses') expect(sent[5]).toContain(`"encrypted_content":"enc-${callC.id}"`);
      if (protocolCase.protocol === 'gemini') expect(sent[5]).toContain(`"thoughtSignature":"ts-${callC.id}"`);

      const entries = ledgerEntriesOf(protocolCase.agentId, session);
      const culls = entries.filter(entry => entry.type === 'cull');
      expect(culls).toHaveLength(1);
      expect(culls[0]).toMatchObject({ turnOrdinal: 1, throughCallId: callB.id, lines: [lineOf(101), lineOf(102)], observationIds: [101, 102] });
      expect(culls[0].culledTokensEst as number).toBeGreaterThan(0);
      if (protocolCase.protocol === 'anthropic') {
        // Recorded before the cull that needs it.
        const cutAt = entries.findIndex(entry => entry.type === 'thinkingCut');
        expect(entries[cutAt]).toEqual({ type: 'thinkingCut', untilTurnOrdinal: 2 });
        expect(cutAt).toBeLessThan(entries.findIndex(entry => entry.type === 'cull'));
      }

      // A restart with an empty observation cache puts back the same bytes from the ledger.
      await gateway.stop();
      fetcherMode = 'down';
      await startGateway();
      expect(await send(protocolCase, requests[5], session)).toBe(sent[5]);
      expect(await send(protocolCase, requests[4], session)).toBe(sent[4]);
      fetcherMode = 'table';
    });

    it(`${protocolCase.protocol}: with reasoning off, culls the current turn mid-loop, never its latest call`, async () => {
      fetcherMode = 'table';
      const tag = `mid-turn-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const callA = { id: `call_${tag}_a` };
      const callB = { id: `call_${tag}_b` };
      const callC = { id: `call_${tag}_c` };
      observationsByToolUseId.set(callA.id, observationFor(201));
      observationsByToolUseId.set(callB.id, observationFor(202));
      const conversation = new Conversation(protocolCase).add('u1', protocolCase.user(`${tag}: keep going`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      conversation.add('ca', protocolCase.calls([callA], false)).add('ra', protocolCase.results([callA]));
      // a's observation is asked for only now, so this request goes as it came.
      expect(await sendAndSettle(protocolCase, conversation.body(), session)).toBe(conversation.body());
      conversation.add('cb', protocolCase.calls([callB], false)).add('rb', protocolCase.results([callB]));
      // b is the in-flight loop's latest call: a is culled, b stays even with its observation cached next time.
      const midTurn = await sendAndSettle(protocolCase, conversation.body(), session);
      expect(midTurn).toContain(escapedInJson(workBlockOf(201)));
      expect(midTurn).not.toContain(callA.id);
      expect(midTurn).toContain(callB.id);
      const input = encoder.encode(conversation.body());
      expectDiffersOnlyInsideDeclaredSpans(input, encoder.encode(midTurn), [
        appendPointOf(input, protocolCase.userContentPath(0)),
        removedRangeOf(input, protocolCase, { first: conversation.range('ca').first, last: conversation.range('ra').last }),
      ]);
      expectPairsWhole(protocolCase, conversation.body(), midTurn);

      // The next step of the loop: b is no longer the latest, so the cull grows through b, its lines kept and added to.
      conversation.add('cc', protocolCase.calls([callC], false)).add('rc', protocolCase.results([callC]));
      const grown = await sendAndSettle(protocolCase, conversation.body(), session);
      expect(grown).toContain(escapedInJson(workBlockOf(201, 202)));
      expect(grown).not.toContain(callB.id);
      expect(grown).toContain(callC.id);
      expectPairsWhole(protocolCase, conversation.body(), grown);
      const culls = ledgerEntriesOf(protocolCase.agentId, session).filter(entry => entry.type === 'cull');
      expect(culls.map(entry => [entry.throughCallId, entry.observationIds])).toEqual([[callA.id, [201]], [callB.id, [201, 202]]]);

      // The same request again gives the same bytes.
      expect(await send(protocolCase, conversation.body(), session)).toBe(grown);
    });

    it(`${protocolCase.protocol}: the in-flight loop is never culled, even sent twice with its latest call's observation cached`, async () => {
      fetcherMode = 'table';
      const tag = `in-flight-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const call = { id: `call_${tag}` };
      observationsByToolUseId.set(call.id, observationFor(251));
      const conversation = new Conversation(protocolCase).add('u1', protocolCase.user(`${tag}: go`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      conversation.add('c', protocolCase.calls([call], false)).add('r', protocolCase.results([call]));
      expect(await sendAndSettle(protocolCase, conversation.body(), session)).toBe(conversation.body());
      // The observation is cached now; the same request (a retry) is still the loop the model is in.
      expect(await send(protocolCase, conversation.body(), session)).toBe(conversation.body());
      expect(ledgerEntriesOf(protocolCase.agentId, session).filter(entry => entry.type === 'cull')).toEqual([]);
    });

    it(`${protocolCase.protocol}: calls the observer skipped go with the next covered call; a partly covered parallel-call message is kept`, async () => {
      fetcherMode = 'table';
      const tag = `coverage-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const skipped = { id: `call_${tag}_skipped` };
      const covered = { id: `call_${tag}_covered` };
      const parallelA = { id: `call_${tag}_pa` };
      const parallelB = { id: `call_${tag}_pb` };
      observationsByToolUseId.set(covered.id, observationFor(301));
      observationsByToolUseId.set(parallelA.id, observationFor(302));
      const conversation = new Conversation(protocolCase).add('u1', protocolCase.user(`${tag}: do it all`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      conversation
        .add('cs', protocolCase.calls([skipped], true)).add('rs', protocolCase.results([skipped]))
        .add('cv', protocolCase.calls([covered], true)).add('rv', protocolCase.results([covered]))
        .add('cp', protocolCase.calls([parallelA, parallelB], true)).add('rp', protocolCase.results([parallelA, parallelB]));
      await sendAndSettle(protocolCase, conversation.body(), session);
      conversation.add('f1', protocolCase.final('all done', true)).add('u2', protocolCase.user(`${tag}: next`));
      const turn2 = await sendAndSettle(protocolCase, conversation.body(), session);
      // The skipped call goes with the covered one, with no line of its own; the parallel message's b has no observation, so a stays too.
      expect(turn2).toContain(escapedInJson(workBlockOf(301)));
      expect(turn2).not.toContain(skipped.id);
      expect(turn2).not.toContain(covered.id);
      expect(turn2).toContain(parallelA.id);
      expect(turn2).toContain(parallelB.id);
      expect(turn2).not.toContain('#302');
      expectPairsWhole(protocolCase, conversation.body(), turn2);

      // b's observation arrives; the next turn start culls the parallel message too, the frozen line first.
      observationsByToolUseId.set(parallelB.id, observationFor(303));
      conversation.add('f2', protocolCase.final('ok', true)).add('u3', protocolCase.user(`${tag}: and more`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      const turn3 = await send(protocolCase, conversation.body(), session);
      expect(turn3).toContain(escapedInJson(workBlockOf(301, 302, 303)));
      expect(turn3).not.toContain(parallelA.id);
      expect(turn3).not.toContain(parallelB.id);
      expect(turn3).toContain('all done');
      expectPairsWhole(protocolCase, conversation.body(), turn3);
    });
  }

  it('anthropic: the thinking cut is contiguous from message 0 and never reaches the in-flight turn', async () => {
    fetcherMode = 'table';
    const tag = 'thinking-cut';
    const session = nextSession(tag);
    const callA = { id: `call_${tag}_a` };
    const callB = { id: `call_${tag}_b` };
    observationsByToolUseId.set(callB.id, observationFor(401));
    const conversation = new Conversation(anthropicCase).add('u1', anthropicCase.user(`${tag}: one`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add('ca', anthropicCase.calls([callA], true)).add('ra', anthropicCase.results([callA]))
      .add('f1', anthropicCase.final('first', true)).add('u2', anthropicCase.user(`${tag}: two`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add('cb', anthropicCase.calls([callB], true)).add('rb', anthropicCase.results([callB]));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add('f2', anthropicCase.final('second', true)).add('u3', anthropicCase.user(`${tag}: three`));
    const turn3 = await sendAndSettle(anthropicCase, conversation.body(), session);
    // Turn 2's work is culled; every thinking block before turn 3 is gone, turn 1's too (no gap).
    expect(turn3).toContain(escapedInJson(workBlockOf(401)));
    expect(turn3).not.toContain('"type":"thinking"');
    expect(turn3).toContain(callA.id);
    // The in-flight turn keeps its own thinking on every later request.
    conversation.add('cc', anthropicCase.calls([{ id: `call_${tag}_c` }], true));
    conversation.add('rc', anthropicCase.results([{ id: `call_${tag}_c` }]));
    const loop = await send(anthropicCase, conversation.body(), session);
    expect(loop.startsWith(prefixOf(turn3))).toBe(true);
    expect(loop).toContain(`"signature":"sig-call_${tag}_c"`);
    expect((loop.match(/"type":"thinking"/g) ?? []).length).toBe(1);
  });

  it('openai-chat: a run ends exactly on its last call\'s result, so every replay culls the same messages', async () => {
    fetcherMode = 'table';
    const chatCase = protocolCases[1];
    const tag = 'exact-end';
    const session = nextSession(tag);
    const c1 = { id: `call_${tag}_1` };
    const c2 = { id: `call_${tag}_2` };
    observationsByToolUseId.set(c1.id, observationFor(261));
    observationsByToolUseId.set(c2.id, observationFor(262));
    const conversation = new Conversation(chatCase).add('u1', chatCase.user(`${tag}: start`));
    await sendAndSettle(chatCase, conversation.body(), session);
    conversation.add('c1', chatCase.calls([c1], false)).add('r1', chatCase.results([c1]));
    await sendAndSettle(chatCase, conversation.body(), session);
    // A reminder the agent put in as the user, and a system message, between the two calls: neither may be culled.
    conversation.add('reminder', [{ role: 'user', content: '<system-reminder>files changed</system-reminder>' }])
      .add('system', [{ role: 'system', content: 'mid-run note' }])
      .add('c2', chatCase.calls([c2], false)).add('r2', chatCase.results([c2]));
    await sendAndSettle(chatCase, conversation.body(), session);
    conversation.add('f1', chatCase.final('done', false)).add('u2', chatCase.user(`${tag}: next`));
    const turn2 = await sendAndSettle(chatCase, conversation.body(), session);
    expect(turn2).not.toContain(c1.id);
    expect(turn2).toContain(c2.id);
    expect(turn2).toContain('files changed');
    expect(turn2).toContain('mid-run note');
    expect(ledgerEntriesOf(chatCase.agentId, session).filter(entry => entry.type === 'cull').map(entry => entry.throughCallId)).toEqual([c1.id]);
    // Replays rebuild the run from c1's result alone: the same bytes, then the same prefix.
    expect(await send(chatCase, conversation.body(), session)).toBe(turn2);
    conversation.add('c3', chatCase.calls([{ id: `call_${tag}_3` }], false)).add('r3', chatCase.results([{ id: `call_${tag}_3` }]));
    expect((await send(chatCase, conversation.body(), session)).startsWith(prefixOf(turn2))).toBe(true);
  });

  it('a cull grows past calls whose observation is already in its lines (one observation for a whole batch)', async () => {
    fetcherMode = 'table';
    const tag = 'batch';
    const session = nextSession(tag);
    const calls = [1, 2, 3].map(n => ({ id: `call_${tag}_${n}` }));
    for (const call of calls.slice(0, 2)) observationsByToolUseId.set(call.id, observationFor(271));
    const conversation = new Conversation(anthropicCase).add('u1', anthropicCase.user(`${tag}: go`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    for (const [index, call] of calls.entries()) {
      conversation.add(`c${index}`, anthropicCase.calls([call], false)).add(`r${index}`, anthropicCase.results([call]));
      await sendAndSettle(anthropicCase, conversation.body(), session);
    }
    const sent = await send(anthropicCase, conversation.body(), session);
    expect(sent).not.toContain(calls[0].id);
    expect(sent).not.toContain(calls[1].id);
    expect(sent).toContain(calls[2].id);
    expect(sent).toContain(escapedInJson(workBlockOf(271)));
    expect(ledgerEntriesOf(anthropicCase.agentId, session).filter(entry => entry.type === 'cull').map(entry => [entry.throughCallId, entry.observationIds]))
      .toEqual([[calls[0].id, [271]], [calls[1].id, [271]]]);
  });

  it('openai-responses: a run stops before a context item (a web search, a compaction)', async () => {
    fetcherMode = 'table';
    const responsesCase = protocolCases[2];
    const tag = 'context-item';
    const session = nextSession(tag);
    const a = { id: `call_${tag}_a` };
    const b = { id: `call_${tag}_b` };
    observationsByToolUseId.set(a.id, observationFor(281));
    observationsByToolUseId.set(b.id, observationFor(282));
    const conversation = new Conversation(responsesCase).add('u1', responsesCase.user(`${tag}: look it up`));
    await sendAndSettle(responsesCase, conversation.body(), session);
    conversation.add('ca', responsesCase.calls([a], true)).add('ra', responsesCase.results([a]))
      .add('search', [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'kept query' } }])
      .add('cb', responsesCase.calls([b], true)).add('rb', responsesCase.results([b]));
    await sendAndSettle(responsesCase, conversation.body(), session);
    conversation.add('f1', responsesCase.final('found', true)).add('u2', responsesCase.user(`${tag}: thanks`));
    const turn2 = await send(responsesCase, conversation.body(), session);
    expect(turn2).not.toContain(a.id);
    expect(turn2).toContain('kept query');
    expect(turn2).toContain(b.id);
    expect(turn2).toContain(escapedInJson(workBlockOf(281)));
  });

  it('anthropic: a run never removes anything that carries cache_control', async () => {
    fetcherMode = 'table';
    const tag = 'cache-control';
    const session = nextSession(tag);
    const call = { id: `call_${tag}` };
    observationsByToolUseId.set(call.id, observationFor(291));
    const conversation = new Conversation(anthropicCase).add('u1', anthropicCase.user(`${tag}: go`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add('c', anthropicCase.calls([call], true))
      .add('r', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'cached', cache_control: { type: 'ephemeral' } }] }]);
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add('f1', anthropicCase.final('done', true)).add('u2', anthropicCase.user(`${tag}: next`));
    expect(await send(anthropicCase, conversation.body(), session)).toBe(conversation.body());
  });

  it('gemini: a turn whose calls have only position ids is never culled', async () => {
    fetcherMode = 'table';
    const geminiCase = protocolCases[3];
    const tag = 'positional';
    const session = nextSession(tag);
    observationForEveryToolUse = observationFor(295);
    try {
      const conversation = new Conversation(geminiCase).add('u1', geminiCase.user(`${tag}: read`))
        .add('c', [{ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'go.mod' } } }] }])
        .add('r', [{ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'module x' } } }] }]);
      await sendAndSettle(geminiCase, geminiCase.body(conversation.items.slice(0, 1)), session);
      await sendAndSettle(geminiCase, conversation.body(), session);
      conversation.add('f1', geminiCase.final('read', false)).add('u2', geminiCase.user(`${tag}: next`));
      expect(await send(geminiCase, conversation.body(), session)).toBe(conversation.body());
      expect(ledgerEntriesOf(geminiCase.agentId, session).filter(entry => entry.type === 'cull')).toEqual([]);
    } finally {
      observationForEveryToolUse = null;
    }
  });

  it('a recorded cull whose lines no longer have a place suspends the conversation instead of failing on every request', async () => {
    fetcherMode = 'table';
    const tag = 'no-place';
    const session = nextSession(tag);
    const bodies = killSwitchConversation(tag, 296);
    for (const body of bodies.slice(0, 2)) await sendAndSettle(anthropicCase, body, session);
    expect(await send(anthropicCase, bodies[2], session)).toContain('#296');
    // The agent now sends turn 1's message already ending with the block: the frozen lines cannot be appended again.
    const block = workBlockOf(296);
    const altered = bodies[3].replace(`"${tag}: one"`, JSON.stringify(`${tag}: one\n\n${block}`));
    expect(altered).not.toBe(bodies[3]);
    expect(await send(anthropicCase, altered, session)).toBe(altered);
    expect(ledgerEntriesOf(anthropicCase.agentId, session).filter(entry => entry.type === 'suspended').map(entry => entry.stage)).toEqual(['endless-mode']);
    expect(await send(anthropicCase, bodies[4], session)).toBe(bodies[4]);
  });

  it('never culls in a conversation it first saw mid-way', async () => {
    fetcherMode = 'table';
    const tag = 'not-born';
    const session = nextSession(tag);
    const call = { id: `call_${tag}` };
    observationsByToolUseId.set(call.id, observationFor(501));
    const conversation = new Conversation(anthropicCase).add('u1', anthropicCase.user(`${tag}: hi`))
      .add('c', anthropicCase.calls([call], true)).add('r', anthropicCase.results([call]));
    expect(await sendAndSettle(anthropicCase, conversation.body(), session)).toBe(conversation.body());
    conversation.add('f1', anthropicCase.final('done', true)).add('u2', anthropicCase.user(`${tag}: next`));
    expect(await sendAndSettle(anthropicCase, conversation.body(), session)).toBe(conversation.body());
  });

  it('with the worker down or hanging, sends every request byte-identical and never waits for it', async () => {
    const timeConversation = async (routeId: string, tag: string) => {
      const session = nextSession(tag);
      const conversation = new Conversation(anthropicCase);
      const started = performance.now();
      for (let n = 1; n <= 4; n++) {
        const call = { id: `call_${tag}_${n}` };
        conversation.add(`u${n}`, anthropicCase.user(`${tag}: task ${n}`));
        expect(await send(anthropicCase, conversation.body(), session, routeId)).toBe(conversation.body());
        conversation.add(`c${n}`, anthropicCase.calls([call], true)).add(`r${n}`, anthropicCase.results([call]));
        expect(await send(anthropicCase, conversation.body(), session, routeId)).toBe(conversation.body());
        conversation.add(`f${n}`, anthropicCase.final(`done ${n}`, true));
      }
      return performance.now() - started;
    };
    fetcherMode = 'hang';
    await timeConversation('endless-off', 'warm-off');
    await timeConversation(anthropicCase.routeId, 'warm-on');
    const baselineMs = await timeConversation('endless-off', 'baseline');
    const hangingMs = await timeConversation(anthropicCase.routeId, 'worker-hangs');
    fetcherMode = 'down';
    const downMs = await timeConversation(anthropicCase.routeId, 'worker-down');
    fetcherMode = 'table';
    // Eight requests each; a lookup that hangs forever must cost none of them anything noticeable
    // (250 ms: one request stage budget, REQUEST_STAGE_BUDGET_MS).
    expect(hangingMs).toBeLessThan(baselineMs + 250);
    expect(downMs).toBeLessThan(baselineMs + 250);
  });

  /** A finished turn 1 with one covered call, and the bodies of the next turn. */
  function killSwitchConversation(tag: string, observationId: number) {
    const call = { id: `call_${tag}` };
    observationsByToolUseId.set(call.id, observationFor(observationId));
    const conversation = new Conversation(anthropicCase).add('u1', anthropicCase.user(`${tag}: one`));
    const bodies = [conversation.body()];
    conversation.add('c', anthropicCase.calls([call], true)).add('r', anthropicCase.results([call]));
    bodies.push(conversation.body());
    conversation.add('f1', anthropicCase.final('done', true)).add('u2', anthropicCase.user(`${tag}: two`));
    bodies.push(conversation.body());
    const nextCall = { id: `call_${tag}_next` };
    conversation.add('c2', anthropicCase.calls([nextCall], true)).add('r2', anthropicCase.results([nextCall]));
    bodies.push(conversation.body());
    conversation.add('f2', anthropicCase.final('done again', true)).add('u3', anthropicCase.user(`${tag}: three`));
    bodies.push(conversation.body());
    return bodies;
  }

  it('a route switched off stops culling at once, and never resumes a conversation it went unculled in', async () => {
    fetcherMode = 'table';
    const tag = 'kill-switch';
    const session = nextSession(tag);
    const bodies = killSwitchConversation(tag, 601);
    for (const body of bodies.slice(0, 2)) await sendAndSettle(anthropicCase, body, session, 'endless-kill');
    expect(await send(anthropicCase, bodies[2], session, 'endless-kill')).toContain('#601');
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', false, routesFilePath)).toBe(true);
    expect(readWireGatewayRoutesFile(routesFilePath).routes['endless-kill'].features.endlessMode).toBe(false);
    // Off: the history goes as the agent wrote it, mid tool-loop included.
    expect(await send(anthropicCase, bodies[3], session, 'endless-kill')).toBe(bodies[3]);
    // On again: the model has answered the original history since, so this conversation stays unculled.
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', true, routesFilePath)).toBe(true);
    expect(await send(anthropicCase, bodies[4], session, 'endless-kill')).toBe(bodies[4]);
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', undefined, routesFilePath)).toBe(true);
    expect(readWireGatewayRoutesFile(routesFilePath).routes['endless-kill'].features).toEqual({});
    expect(setWireGatewayRouteFeature('no-such-route', 'endlessMode', false, routesFilePath)).toBe(false);
  });

  it('switched off and on with no request between, keeps putting the same culls back', async () => {
    fetcherMode = 'table';
    const tag = 'kill-switch-idle';
    const session = nextSession(tag);
    const bodies = killSwitchConversation(tag, 602);
    for (const body of bodies.slice(0, 2)) await sendAndSettle(anthropicCase, body, session, 'endless-kill');
    const culled = await send(anthropicCase, bodies[2], session, 'endless-kill');
    expect(culled).toContain('#602');
    setWireGatewayRouteFeature('endless-kill', 'endlessMode', false, routesFilePath);
    setWireGatewayRouteFeature('endless-kill', 'endlessMode', undefined, routesFilePath);
    expect((await send(anthropicCase, bodies[3], session, 'endless-kill')).startsWith(prefixOf(culled))).toBe(true);
  });

  it('a conversation Endless Mode v1 swapped is suspended: sent as it came, never culled', async () => {
    fetcherMode = 'table';
    const tag = 'v1-swapped';
    const session = nextSession(tag);
    const bodies = killSwitchConversation(tag, 603);
    mkdirSync(ledgerDirectory, { recursive: true });
    const ledgerFile = join(ledgerDirectory, `${conversationKeyOf({ agentId: anthropicCase.agentId, sessionId: session })}.jsonl`);
    writeFileSync(ledgerFile, [
      { type: 'born', at: '2026-10-01T00:00:00.000Z' },
      { type: 'swap', callId: 'old_call', replacementText: '[claude-mem: replaced]', firstRequestAt: '2026-10-01T00:00:01.000Z', observationId: 9 },
      { type: 'thinkingDrop', boundaryMessageIndex: 1, untilMessageIndex: 4 },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    for (const body of bodies) expect(await sendAndSettle(anthropicCase, body, session)).toBe(body);
    expect(ledgerEntriesOf(anthropicCase.agentId, session).filter(entry => entry.type === 'suspended').map(entry => entry.stage)).toEqual(['endless-mode']);
  });

  it('records each cull\'s tokens once, on the request that recorded or extended it, which status --endless adds up', async () => {
    // Per conversation, what the ledger's culls newly took out: an entry that extends a turn's cull adds only what it took out beyond the one before.
    const newlyCulledTokensOf = (agentId: string, session: string) => {
      const latestByTurn = new Map<number, number>();
      let total = 0;
      for (const entry of ledgerEntriesOf(agentId, session)) {
        if (entry.type !== 'cull') continue;
        const turnOrdinal = entry.turnOrdinal as number;
        total += Math.max(0, (entry.culledTokensEst as number) - (latestByTurn.get(turnOrdinal) ?? 0));
        latestByTurn.set(turnOrdinal, entry.culledTokensEst as number);
      }
      return total;
    };
    const conversationsOf = (records: ReturnType<WireUsageLedger['read']>) => {
      const recordedByConversation = new Map<string, { agent: string; session: string; recorded: number; requests: number }>();
      for (const record of records) {
        if (record.culledTokensEst <= 0) continue;
        const key = `${record.agent}\u0000${record.session}`;
        const conversation = recordedByConversation.get(key) ?? { agent: record.agent, session: record.session, recorded: 0, requests: 0 };
        conversation.recorded += record.culledTokensEst;
        conversation.requests++;
        recordedByConversation.set(key, conversation);
      }
      return [...recordedByConversation.values()];
    };
    let records: ReturnType<WireUsageLedger['read']> = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      records = new WireUsageLedger({ directory: usageDirectory }).read();
      const conversations = conversationsOf(records);
      if (conversations.length > 0 && conversations.every(({ agent, session, recorded }) => recorded === newlyCulledTokensOf(agent, session))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const conversations = conversationsOf(records);
    expect(conversations.length).toBeGreaterThan(0);
    for (const { agent, session, recorded, requests } of conversations) {
      // Replayed culls (every later request, and the requests sent again after a restart) add nothing.
      expect(recorded).toBe(newlyCulledTokensOf(agent, session));
      expect(requests).toBeLessThanOrEqual(ledgerEntriesOf(agent, session).filter(entry => entry.type === 'cull').length);
    }
    expect(records.find(record => record.culledTokensEst > 0)?.stages).toEqual(['endless-mode']);
    const report = buildEndlessModeReport(records);
    expect(report.map(agent => agent.agentId)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini-cli', 'opencode']));
    for (const agent of report) {
      expect(agent.tokensSaved).toBe(conversations.filter(conversation => conversation.agent === agent.agentId).reduce((sum, { recorded }) => sum + recorded, 0));
    }
  });
});

describe('the culled-work block', () => {
  it('is never the user\'s words: it neither starts nor hides a turn, and capture strips it', () => {
    const block = workBlockOf(1, 2);
    expect(userWordsInText(block)).toBe('');
    expect(userWordsInText(`fix the bug\n\n${block}`)).toBe('fix the bug');
    expect(userWordsInText(`<claude-mem-rules>\nrules\n</claude-mem-rules>`)).toBe('');
    const span = { start: 0, end: 0, type: 'string' as const };
    const message = (text: string) => ({ role: 'user' as const, parts: [{ kind: 'text' as const, text, span }], span });
    expect(startsUserTurn(message(block))).toBe(false);
    expect(startsUserTurn(message(`go on\n\n${block}`))).toBe(true);
    expect(stripMemoryTags(`before ${block} after`)).toBe('before  after');
  });
});

describe('the observation lookup', () => {
  it('never waits, dedupes a lookup in flight, and caches no failure', async () => {
    let now = 0;
    let calls = 0;
    let answer: 'fail' | Map<string, WireToolObservation> = 'fail';
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
    let found = new Map<string, WireToolObservation>([['a', observationFor(9)]]);
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

  it('reads tool uses\' observations and timeline lines from the worker\'s /api/wire/tool-observations', async () => {
    const worker = await startFakeUpstream(request => request.path === '/api/wire/tool-observations'
      ? { kind: 'json', body: { observations: [
        { toolUseId: 'toolu_1', observationId: 42, title: 'Parser read', narrative: 'It parses.', facts: ['one', 'two'], timelineLine: '#42 3:04p 🔵 Parser read' },
        // A worker older than Endless Mode v2 sends no line: taken as no observation.
        { toolUseId: 'toolu_2', observationId: 43, title: 'Old worker', narrative: '', facts: [] },
      ] } }
      : { kind: 'json', status: 404, body: { error: 'not found' } });
    try {
      const found = await fetchToolObservationsFromWorker(
        { contentSessionId: 'session-1', platformSource: 'claude-code', toolUseIds: ['toolu_1', 'toolu_2'] },
        apiPath => `${worker.url}${apiPath}`,
      );
      expect([...found.entries()]).toEqual([['toolu_1', { observationId: 42, timelineLine: '#42 3:04p 🔵 Parser read' }]]);
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

describe('status --endless', () => {
  const record = (session: string, t: string, cacheRead: number, cacheWrite: number, culledTokensEst = 0, stages: string[] = []) => ({
    t, agent: 'codex', session, routeId: 'r', model: 'm', status: 200, in: 1, out: 1, cacheRead, cacheWrite, cacheWrite1h: 0,
    reasoning: 0, ms: 1, ttftMs: 1, kind: 'turn', stages, injectedTokensEst: 0, culledTokensEst,
  });
  // The cull stage applies on every request from the first cull on, but only a request that recorded a cull carries its tokens.
  const replayed = ['endless-mode'];

  it('splits each conversation at its first cull and counts each cull\'s tokens once, per agent', () => {
    const report = buildEndlessModeReport([
      record('s1', '2026-10-01T00:00:01Z', 100, 100),
      record('s1', '2026-10-01T00:00:02Z', 900, 100),
      record('s1', '2026-10-01T00:00:03Z', 0, 800, 500, replayed),
      record('s1', '2026-10-01T00:00:04Z', 800, 0, 0, replayed),
      record('s1', '2026-10-01T00:00:05Z', 700, 100, 300, replayed),
      record('s1', '2026-10-01T00:00:06Z', 800, 0, 0, replayed),
      record('s2', '2026-10-01T00:00:07Z', 50, 50),
    ]);
    expect(report).toEqual([{
      agentId: 'codex',
      conversationsCulled: 1,
      requestsWithNewCulls: 2,
      beforeFirstCull: { requests: 2, cacheRead: 1000, cacheWrite: 200, readWriteRatio: 5 },
      afterFirstCull: { requests: 4, cacheRead: 2300, cacheWrite: 900, readWriteRatio: 2300 / 900 },
      tokensSaved: 800,
    }]);
    const text = formatEndlessModeReport(report, 7).join('\n');
    expect(text).toContain('codex: 1 conversations, 2 requests with new culls, ~800 tokens saved');
    expect(text).toContain('cache before the first cull: 5.0:1');
    expect(text).not.toMatch(/swap/i);
    expect(formatEndlessModeReport([], 7)[0]).toBe('Endless Mode: no culls in the usage ledger\'s last 7 days.');
  });

  it('reads only the usage day files the retention keeps, and old lines as no culls', () => {
    const directory = join(testRoot, 'status-endless-usage');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const nowMs = Date.parse('2026-10-24T12:00:00.000Z');
    const linesOf = (...records: object[]) => records.map(line => JSON.stringify(line)).join('\n') + '\n';
    // Past a 7-day retention, not pruned yet (the gateway prunes at start and on a new UTC day).
    writeFileSync(join(directory, '2026-10-10.jsonl'), linesOf(record('old', '2026-10-10T00:00:01Z', 0, 0, 9_000, replayed)));
    // Written before v2: swappedTokensEst counted the swaps on every request that replayed them.
    const { culledTokensEst: _culledTokensEst, ...legacyRecord } = record('legacy', '2026-10-23T00:00:01Z', 0, 0);
    writeFileSync(join(directory, '2026-10-23.jsonl'), linesOf({ ...legacyRecord, stages: replayed, swappedTokensEst: 7_000 }));
    writeFileSync(join(directory, '2026-10-24.jsonl'), linesOf(
      record('s1', '2026-10-24T00:00:01Z', 0, 1000),
      record('s1', '2026-10-24T00:00:02Z', 0, 900, 400, replayed),
      record('s1', '2026-10-24T00:00:03Z', 900, 0, 0, replayed),
    ));
    const report = readEndlessModeReport(7, { directory, nowMs });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ agentId: 'codex', conversationsCulled: 1, requestsWithNewCulls: 1, tokensSaved: 400 });
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('Endless Mode settings', () => {
  it('are validated at start', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'yes' })).toContain('ENDLESS_MODE');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'true' })).toBeNull();
  });
});
