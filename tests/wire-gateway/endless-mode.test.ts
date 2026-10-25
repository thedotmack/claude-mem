import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute, readWireGatewayRoutesFile, setWireGatewayRouteFeature } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger, conversationKeyOf } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { WireUsageLedger } from '../../src/services/wire-gateway/metrics/usage-ledger.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { startsUserTurn } from '../../src/services/wire-gateway/identity/turn-start.js';
import { TIMELINE_CLOSE_TAG, TIMELINE_OPEN_TAG, userWordsInMessage, userWordsInText } from '../../src/services/wire-gateway/identity/user-words.js';
import { decodeValue, getSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { toolPairingProblem } from '../../src/services/wire-gateway/rewrite/tool-pairing.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import {
  WireObservationLookup,
  fetchToolObservationsFromWorker,
  type WireToolObservation,
  type WireToolObservationQuery,
} from '../../src/services/wire-gateway/endless/observation-lookup.js';
import { TIMELINE_INTRO, timelineBlockTextsOf, timelineRowsBlockText } from '../../src/services/wire-gateway/endless/endless-mode-stage.js';
import { buildEndlessModeReport, formatEndlessModeReport, readEndlessModeReport } from '../../src/services/wire-gateway/endless/endless-report.js';
import { validateWireGatewayListenSettings } from '../../src/services/wire-gateway/config.js';
import { ENDLESS_TIMELINE_ROW_FORMATS, endlessTimelineRowFormatOf } from '../../src/shared/endless-timeline-row-format.js';
import { stripMemoryTags } from '../../src/utils/tag-stripping.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { expectMatchesGoldenFile } from './golden/golden-harness.js';

// Endless Mode v2, one growing timeline, through the real relay: per
// protocol, a conversation born under the gateway goes upstream as
// [timeline][live tail]. A finished turn folds into the timeline as rows
// (its prompt, its observations, its final reply); inside the current turn,
// covered tool calls fold as their observations land. Every growth leaves
// each byte before the timeline's end as it was, on every later request and
// after a restart.

const testRoot = join(WIRE_GATEWAY_DIR, 'endless-mode-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const usageDirectory = join(testRoot, 'usage');
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

/** How long a turn-start request waits for observations here: short, so the hanging-worker test stays quick. */
const CONTEXT_TIMEOUT_MS = 200;
const ENDLESS_SETTINGS = { CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE: 'true', CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS: String(CONTEXT_TIMEOUT_MS) };

// ---------------------------------------------------------------------------
// The fake worker behind the observation lookup

type FetcherMode = 'table' | 'hang' | 'down';
let fetcherMode: FetcherMode = 'table';
/** tool_use_id → the observations of its batch. */
const observationsByToolUseId = new Map<string, WireToolObservation[]>();
const pendingLookups = new Set<Promise<unknown>>();
const askedRowFormats: string[] = [];
/** When set, every tool use asked about has these observations (for ids the test cannot know, such as Gemini's derived ones). */
let observationsForEveryToolUse: WireToolObservation[] | null = null;

async function fakeFetchToolObservations(query: WireToolObservationQuery): Promise<Map<string, WireToolObservation[]>> {
  askedRowFormats.push(query.rowFormat);
  if (fetcherMode === 'hang') return new Promise(() => undefined);
  if (fetcherMode === 'down') throw new Error('connect ECONNREFUSED');
  const found = new Map<string, WireToolObservation[]>();
  for (const toolUseId of query.toolUseIds) {
    const observations = observationsForEveryToolUse ?? observationsByToolUseId.get(toolUseId);
    if (observations) found.set(toolUseId, observations.map(observation => ({ ...observation, row: `${observation.row}${query.rowFormat === 'timeline' ? '' : ` [${query.rowFormat}]`}` })));
  }
  return found;
}

function trackedFetcher(query: WireToolObservationQuery): Promise<Map<string, WireToolObservation[]>> {
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
  return { observationId, row: `#${observationId} 3:04p 🔵 File ${observationId} read <b> & "q" é` };
}
const rowOf = (observationId: number) => observationFor(observationId).row;
const observe = (callId: string, ...observationIds: number[]) => observationsByToolUseId.set(callId, observationIds.map(observationFor));

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
    body: items => JSON.stringify({ model: 'gpt-x', messages: [{ role: 'system', content: 'You are careful.' }, ...items] }),
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
    body: items => JSON.stringify({ model: 'gpt-x', instructions: 'You are careful.', input: items }),
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
  },
];
const anthropicCase = protocolCases[0];

/** A conversation built item by item, and each request's body. */
class Conversation {
  readonly items: unknown[] = [];
  constructor(readonly protocolCase: ProtocolCase) {}

  add(items: unknown[]): this {
    this.items.push(...items);
    return this;
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
async function send(protocolCase: ProtocolCase, body: string, session: string, routeId = protocolCase.routeId, to: StartedWireGateway = gateway): Promise<string> {
  const before = upstream.requests.length;
  const response = await fetch(`${to.baseUrl}/r/${routeId}${protocolCase.path}`, {
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
async function sendAndSettle(protocolCase: ProtocolCase, body: string, session: string, routeId?: string, to?: StartedWireGateway): Promise<string> {
  const sent = await send(protocolCase, body, session, routeId, to);
  await settleLookups();
  return sent;
}

function ledgerEntriesOf(agentId: string, session: string): Array<Record<string, unknown>> {
  const filePath = join(ledgerDirectory, `${conversationKeyOf({ agentId, sessionId: session })}.jsonl`);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>);
}
const foldsOf = (agentId: string, session: string) => ledgerEntriesOf(agentId, session).filter(entry => entry.type === 'timelineFold');

/** The JSON of the timeline's closing part, as each protocol writes it. */
function closingPartJsonOf(protocol: WireProtocol): string {
  const encoded = JSON.stringify(TIMELINE_CLOSE_TAG);
  if (protocol === 'gemini') return `{"text":${encoded}}`;
  if (protocol === 'openai-responses') return `{"type":"input_text","text":${encoded}}`;
  return `{"type":"text","text":${encoded}}`;
}

/** Breakpoint markers taken out: Anthropic's cache does not count them in the prefix, and the timeline's moves to its new last block. */
const withoutMarkers = (body: string) => body.replace(/,"cache_control":\{[^}]*\}/g, '');

/** The bytes of a sent body up to the end of its timeline's last rows block (markers out): what every later request must start with. */
function throughTimelineEnd(protocol: WireProtocol, body: string): string {
  const unmarked = withoutMarkers(body);
  const closingAt = unmarked.indexOf(`,${closingPartJsonOf(protocol)}`);
  expect(closingAt).toBeGreaterThan(0);
  return unmarked.slice(0, closingAt);
}

function expectGrowsOnlyAfterTimelineEnd(protocol: WireProtocol, earlier: string, later: string): void {
  expect(withoutMarkers(later).startsWith(throughTimelineEnd(protocol, earlier))).toBe(true);
}

/** The conversation as the vendor got it: each element's JSON. */
function conversationOf(protocolCase: ProtocolCase, sent: string): unknown[] {
  const bytes = encoder.encode(sent);
  return decodeValue(bytes, getSpan(bytes, [protocolCase.turnsKey])!) as unknown[];
}

/** The timeline's text blocks as sent (closing one included). */
function timelineBlocksOf(protocolCase: ProtocolCase, sent: string): string[] {
  // Chat bodies here open with a system message: the timeline follows it.
  const first = conversationOf(protocolCase, sent)[protocolCase.protocol === 'openai-chat' ? 1 : 0] as Record<string, unknown>;
  const parts = (protocolCase.protocol === 'gemini' ? first.parts : first.content) as Array<{ text: string }>;
  const closingIndex = parts.findIndex(part => part.text === TIMELINE_CLOSE_TAG);
  expect(closingIndex).toBeGreaterThan(0);
  return parts.slice(0, closingIndex + 1).map(part => part.text);
}

const blockOfRows = (...rows: string[]) => timelineRowsBlockText(rows);

function expectPairsWhole(protocolCase: ProtocolCase, original: string, rewritten: string): void {
  const parse = (body: string) => parseWireRequest(protocolCase.protocol, encoder.encode(body), protocolCase.path);
  const originalRequest = parse(original);
  const rewrittenRequest = parse(rewritten);
  expect(toolPairingProblem(originalRequest, rewrittenRequest)).toBeNull();
  expect(rewrittenRequest.system).toEqual(originalRequest.system);
  expect(rewrittenRequest.tools).toEqual(originalRequest.tools);
}

/** What the vendor gets after the timeline: the original items from `fromIndex` on (Gemini: the first user content's parts follow the timeline's). */
function expectTailIs(protocolCase: ProtocolCase, sent: string, originalItems: unknown[]): void {
  const sentItems = conversationOf(protocolCase, sent);
  const leading = protocolCase.protocol === 'openai-chat' ? 1 : 0;
  // Chat bodies here open with a system message (leading context): it stays in front of the timeline.
  expect(sentItems.slice(0, leading)).toEqual((JSON.parse(protocolCase.body([])) as Record<string, unknown[]>)[protocolCase.turnsKey].slice(0, leading));
  const afterTimeline = sentItems.slice(leading + 1);
  if (protocolCase.protocol === 'gemini' && (originalItems[0] as { role?: string } | undefined)?.role === 'user') {
    const merged = sentItems[leading] as { parts: unknown[] };
    const userParts = (originalItems[0] as { parts: unknown[] }).parts;
    expect(merged.parts.slice(-userParts.length)).toEqual(userParts);
    expect(afterTimeline).toEqual(originalItems.slice(1));
    return;
  }
  expect(afterTimeline).toEqual(originalItems);
}

// ---------------------------------------------------------------------------

describe('Endless Mode: one growing timeline, per protocol', () => {
  for (const protocolCase of protocolCases) {
    it(`${protocolCase.protocol}: across several turns, each finished turn folds into the timeline as its prompt, observations and reply; the tail is the current turn`, async () => {
      fetcherMode = 'table';
      const tag = `layout-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const callA = { id: `call_${tag}_a` };
      const callB = { id: `call_${tag}_b` };
      const callC = { id: `call_${tag}_c` };
      observe(callA.id, 101);
      observe(callB.id, 102);
      observe(callC.id, 103);
      const conversation = new Conversation(protocolCase).add(protocolCase.user(`${tag}: read two files`));
      const requests: string[] = [conversation.body()];
      conversation.add(protocolCase.calls([callA], true)).add(protocolCase.results([callA]));
      requests.push(conversation.body());
      conversation.add(protocolCase.calls([callB], true)).add(protocolCase.results([callB]));
      requests.push(conversation.body());
      const turn2Start = conversation.items.length + protocolCase.final('read both', true).length;
      conversation.add(protocolCase.final('read both', true)).add(protocolCase.user(`${tag}: now another`));
      requests.push(conversation.body());
      conversation.add(protocolCase.calls([callC], true)).add(protocolCase.results([callC]));
      requests.push(conversation.body());
      const turn3Start = conversation.items.length + protocolCase.final('read it', true).length;
      conversation.add(protocolCase.final('read it', true)).add(protocolCase.user(`${tag}: and finally`));
      requests.push(conversation.body());

      const sent: string[] = [];
      for (const body of requests) sent.push(await sendAndSettle(protocolCase, body, session));

      // From the first request: the timeline first (intro only: no memory injection here), then the turn as it came.
      expect(timelineBlocksOf(protocolCase, sent[0])).toEqual([...timelineBlockTextsOf(null, []), TIMELINE_CLOSE_TAG]);
      expect(timelineBlocksOf(protocolCase, sent[0])[0]).toBe(`${TIMELINE_OPEN_TAG}\n${TIMELINE_INTRO}`);
      // Mid-turn with reasoning: nothing folds, the tail is the whole turn.
      for (const index of [0, 1, 2]) {
        expectTailIs(protocolCase, sent[index], (JSON.parse(requests[index]) as Record<string, unknown[]>)[protocolCase.turnsKey].slice(protocolCase.protocol === 'openai-chat' ? 1 : 0));
      }

      // Turn 2's start folds turn 1 whole: prompt, both observations, reply. The tail is turn 2's prompt alone.
      expect(timelineBlocksOf(protocolCase, sent[3])).toEqual([
        ...timelineBlockTextsOf(null, [[`U: ${tag}: read two files`, rowOf(101), rowOf(102), 'A: read both']]), TIMELINE_CLOSE_TAG,
      ]);
      expectTailIs(protocolCase, sent[3], conversation.items.slice(turn2Start, turn2Start + protocolCase.user('x').length));
      for (const call of [callA, callB]) expect(sent[3]).not.toContain(call.id);
      expectMatchesGoldenFile(`endless-timeline-${protocolCase.protocol}`, encoder.encode(sent[3]));
      // Each growth leaves every byte through the timeline's end as it was.
      for (let index = 1; index < sent.length; index++) expectGrowsOnlyAfterTimelineEnd(protocolCase.protocol, sent[index - 1], sent[index]);

      // Turn 3's start folds turn 2: one more block, appended.
      expect(timelineBlocksOf(protocolCase, sent[5])).toEqual([
        ...timelineBlockTextsOf(null, [[`U: ${tag}: read two files`, rowOf(101), rowOf(102), 'A: read both'], [`U: ${tag}: now another`, rowOf(103), 'A: read it']]),
        TIMELINE_CLOSE_TAG,
      ]);
      expectTailIs(protocolCase, sent[5], conversation.items.slice(turn3Start));
      expect(sent[5]).not.toContain(callC.id);
      expectPairsWhole(protocolCase, requests[5], sent[5]);
      if (protocolCase.protocol === 'anthropic') expect(sent[5]).not.toContain('"type":"thinking"');
      // Sealed reasoning of the current turn is the agent's, untouched (mid-turn 4 kept turn 2's own).
      if (protocolCase.protocol === 'openai-responses') expect(sent[4]).toContain(`"encrypted_content":"enc-${callC.id}"`);
      if (protocolCase.protocol === 'gemini') expect(sent[4]).toContain(`"thoughtSignature":"ts-${callC.id}"`);

      const entries = ledgerEntriesOf(protocolCase.agentId, session);
      expect(foldsOf(protocolCase.agentId, session).map(fold => [fold.sequence, fold.throughTurnOrdinal, fold.throughCallId, fold.observationIds]))
        .toEqual([[0, 0, null, []], [1, 1, null, [101, 102]], [2, 2, null, [103]]]);
      if (protocolCase.protocol === 'anthropic') {
        // Recorded before the fold that needs it.
        const cutAt = entries.findIndex(entry => entry.type === 'thinkingCut' && entry.untilTurnOrdinal === 2);
        expect(cutAt).toBeGreaterThan(0);
        expect(cutAt).toBeLessThan(entries.findIndex(entry => entry.type === 'timelineFold' && entry.sequence === 1));
      }

      // A restart with an empty observation cache puts back the same bytes from the ledger.
      await gateway.stop();
      fetcherMode = 'down';
      await startGateway();
      expect(await send(protocolCase, requests[5], session)).toBe(sent[5]);
      expect(await send(protocolCase, requests[4], session)).toBe(sent[4]);
      fetcherMode = 'table';
    });

    it(`${protocolCase.protocol}: with reasoning off, the timeline eats into the current turn as observations land, never its latest call`, async () => {
      fetcherMode = 'table';
      const tag = `mid-turn-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const callA = { id: `call_${tag}_a` };
      const callB = { id: `call_${tag}_b` };
      const callC = { id: `call_${tag}_c` };
      observe(callA.id, 201);
      observe(callB.id, 202);
      const prompt = protocolCase.user(`${tag}: keep going`);
      const conversation = new Conversation(protocolCase).add(prompt);
      const sent = [await sendAndSettle(protocolCase, conversation.body(), session)];
      conversation.add(protocolCase.calls([callA], false)).add(protocolCase.results([callA]));
      // a's observation is asked for only now, so this request goes with the timeline as it was.
      sent.push(await sendAndSettle(protocolCase, conversation.body(), session));
      expect(sent[1]).toContain(callA.id);
      const callBItems = [...protocolCase.calls([callB], false), ...protocolCase.results([callB])];
      conversation.add(callBItems);
      // b is the in-flight loop's latest call: a folds (the prompt row first, the prompt itself stays raw), b stays.
      sent.push(await sendAndSettle(protocolCase, conversation.body(), session));
      expect(timelineBlocksOf(protocolCase, sent[2]).slice(1, -1)).toEqual([blockOfRows(`U: ${tag}: keep going`, rowOf(201))]);
      expectTailIs(protocolCase, sent[2], [...prompt, ...callBItems]);
      expectPairsWhole(protocolCase, conversation.body(), sent[2]);

      // The next step of the loop: b is no longer the latest, so it folds too, its row appended as a block of its own.
      const callCItems = [...protocolCase.calls([callC], false), ...protocolCase.results([callC])];
      conversation.add(callCItems);
      sent.push(await sendAndSettle(protocolCase, conversation.body(), session));
      expect(timelineBlocksOf(protocolCase, sent[3]).slice(1, -1)).toEqual([blockOfRows(`U: ${tag}: keep going`, rowOf(201)), blockOfRows(rowOf(202))]);
      expectTailIs(protocolCase, sent[3], [...prompt, ...callCItems]);
      expectPairsWhole(protocolCase, conversation.body(), sent[3]);
      for (let index = 1; index < sent.length; index++) expectGrowsOnlyAfterTimelineEnd(protocolCase.protocol, sent[index - 1], sent[index]);
      expect(foldsOf(protocolCase.agentId, session).map(fold => [fold.throughTurnOrdinal, fold.throughCallId, fold.observationIds]))
        .toEqual([[0, null, []], [1, callA.id, [201]], [1, callB.id, [202]]]);

      // The turn ends: the next turn start folds the rest of it (c had no observation, but nothing after it is
      // covered either, so it stays), and the same request again gives the same bytes.
      expect(await send(protocolCase, conversation.body(), session)).toBe(sent[3]);
    });

    it(`${protocolCase.protocol}: the in-flight loop is never folded, even sent twice with its latest call's observation cached`, async () => {
      fetcherMode = 'table';
      const tag = `in-flight-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const call = { id: `call_${tag}` };
      observe(call.id, 251);
      const conversation = new Conversation(protocolCase).add(protocolCase.user(`${tag}: go`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      conversation.add(protocolCase.calls([call], false)).add(protocolCase.results([call]));
      const first = await sendAndSettle(protocolCase, conversation.body(), session);
      // The observation is cached now; the same request (a retry) is still the loop the model is in.
      expect(await send(protocolCase, conversation.body(), session)).toBe(first);
      expect(first).toContain(call.id);
      expect(foldsOf(protocolCase.agentId, session)).toHaveLength(1);
    });

    it(`${protocolCase.protocol}: calls the observer skipped fold with the next covered call; a partly covered parallel-call message waits; every observation of a batch is a row`, async () => {
      fetcherMode = 'table';
      const tag = `coverage-${protocolCase.protocol}`;
      const session = nextSession(tag);
      const skipped = { id: `call_${tag}_skipped` };
      const covered = { id: `call_${tag}_covered` };
      const parallelA = { id: `call_${tag}_pa` };
      const parallelB = { id: `call_${tag}_pb` };
      // The covered call's batch stored two observations: both are rows.
      observe(covered.id, 301, 304);
      observe(parallelA.id, 302);
      const conversation = new Conversation(protocolCase).add(protocolCase.user(`${tag}: do it all`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      conversation
        .add(protocolCase.calls([skipped], true)).add(protocolCase.results([skipped]))
        .add(protocolCase.calls([covered], true)).add(protocolCase.results([covered]));
      const parallelItems = [...protocolCase.calls([parallelA, parallelB], true), ...protocolCase.results([parallelA, parallelB])];
      conversation.add(parallelItems);
      await sendAndSettle(protocolCase, conversation.body(), session);
      const reply = protocolCase.final('all done', true);
      const nextPrompt = protocolCase.user(`${tag}: next`);
      conversation.add(reply).add(nextPrompt);
      const turn2 = await sendAndSettle(protocolCase, conversation.body(), session);
      // Turn 1 folds through the covered call; the parallel message (b has no observation) and the rest of the turn stay
      // (Anthropic: with their thinking cut, as every turn start cuts the thinking before it).
      expect(timelineBlocksOf(protocolCase, turn2).slice(1, -1)).toEqual([blockOfRows(`U: ${tag}: do it all`, rowOf(301), rowOf(304))]);
      const thinkingCut = (items: unknown[]) => protocolCase.protocol !== 'anthropic' ? items : items.map(item => {
        const message = item as { role: string; content: unknown };
        return Array.isArray(message.content) ? { ...message, content: message.content.filter((block: { type: string }) => block.type !== 'thinking') } : item;
      });
      expectTailIs(protocolCase, turn2, [...thinkingCut([...parallelItems, ...reply]), ...nextPrompt]);
      expectPairsWhole(protocolCase, conversation.body(), turn2);

      // b's observation arrives; the next turn start folds the rest of turn 1 and turn 2.
      observe(parallelB.id, 303);
      conversation.add(protocolCase.final('ok', true)).add(protocolCase.user(`${tag}: and more`));
      await sendAndSettle(protocolCase, conversation.body(), session);
      const turn3 = await send(protocolCase, conversation.body(), session);
      expect(timelineBlocksOf(protocolCase, turn3).slice(1, -1)).toEqual([
        blockOfRows(`U: ${tag}: do it all`, rowOf(301), rowOf(304)),
        blockOfRows(rowOf(302), rowOf(303), 'A: all done', `U: ${tag}: next`, 'A: ok'),
      ]);
      expectTailIs(protocolCase, turn3, protocolCase.user(`${tag}: and more`));
      expectGrowsOnlyAfterTimelineEnd(protocolCase.protocol, turn2, turn3);
    });
  }

  it('anthropic: the thinking cut is contiguous from message 0 and never reaches the in-flight turn', async () => {
    fetcherMode = 'table';
    const tag = 'thinking-cut';
    const session = nextSession(tag);
    const callA = { id: `call_${tag}_a` };
    const callB = { id: `call_${tag}_b` };
    // a never gets an observation and nothing after it is covered until b: turn 1 waits, raw, with its thinking cut.
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: one`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add(anthropicCase.calls([callA], true)).add(anthropicCase.results([callA]))
      .add(anthropicCase.final('first', true)).add(anthropicCase.user(`${tag}: two`));
    const turn2 = await sendAndSettle(anthropicCase, conversation.body(), session);
    expect(turn2).toContain(callA.id);
    expect(turn2).not.toContain('"type":"thinking"');
    conversation.add(anthropicCase.calls([{ id: `call_${tag}_c` }], true)).add(anthropicCase.results([{ id: `call_${tag}_c` }]));
    const loop = await send(anthropicCase, conversation.body(), session);
    expect(loop).toContain(`"signature":"sig-call_${tag}_c"`);
    expect((loop.match(/"type":"thinking"/g) ?? []).length).toBe(1);
    expectGrowsOnlyAfterTimelineEnd('anthropic', turn2, loop);
    // b's observation covers a too: turn 3's start folds turns 1 and 2.
    observe(callB.id, 401);
    conversation.add(anthropicCase.calls([callB], true)).add(anthropicCase.results([callB])).add(anthropicCase.final('second', true)).add(anthropicCase.user(`${tag}: three`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    const turn3 = await send(anthropicCase, conversation.body(), session);
    expect(turn3).not.toContain(callA.id);
    expect(turn3).not.toContain('"type":"thinking"');
    expect(timelineBlocksOf(anthropicCase, turn3).at(-2)).toBe(blockOfRows(`U: ${tag}: one`, 'A: first', `U: ${tag}: two`, rowOf(401), 'A: second'));
  });

  it('openai-responses: a context item (a developer note sent again before a prompt, a web search) stays in the tail; the fold goes on around it', async () => {
    fetcherMode = 'table';
    const responsesCase = protocolCases[2];
    const tag = 'context-item';
    const session = nextSession(tag);
    const a = { id: `call_${tag}_a` };
    const b = { id: `call_${tag}_b` };
    observe(a.id, 281);
    observe(b.id, 282);
    const webSearch = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'kept query' } };
    // Codex sends its developer instructions again before some prompts (seen live, codex-cli 0.163.0).
    const developerNote = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>kept note</skills_instructions>' }] };
    const conversation = new Conversation(responsesCase).add(responsesCase.user(`${tag}: look it up`));
    await sendAndSettle(responsesCase, conversation.body(), session);
    conversation.add(responsesCase.calls([a], true)).add(responsesCase.results([a])).add([webSearch])
      .add(responsesCase.calls([b], true)).add(responsesCase.results([b]));
    await sendAndSettle(responsesCase, conversation.body(), session);
    const prompt2 = responsesCase.user(`${tag}: thanks`);
    conversation.add(responsesCase.final('found', true)).add([developerNote]).add(prompt2);
    const turn2 = await send(responsesCase, conversation.body(), session);
    expect(timelineBlocksOf(responsesCase, turn2).slice(1, -1)).toEqual([blockOfRows(`U: ${tag}: look it up`, rowOf(281), rowOf(282), 'A: found')]);
    expectTailIs(responsesCase, turn2, [webSearch, developerNote, ...prompt2]);
    for (const call of [a, b]) expect(turn2).not.toContain(call.id);
    // (The developer note now comes before any reply in the request, so the IR reads it as instructions; the vendor gets the item as the agent wrote it.)
    const parse = (body: string) => parseWireRequest('openai-responses', encoder.encode(body), responsesCase.path);
    expect(toolPairingProblem(parse(conversation.body()), parse(turn2))).toBeNull();
    // The next turn folds turn 2 too; the kept items stay, in order, after the timeline.
    conversation.add(responsesCase.final('welcome', true)).add(responsesCase.user(`${tag}: bye`));
    const turn3 = await send(responsesCase, conversation.body(), session);
    expectGrowsOnlyAfterTimelineEnd('openai-responses', turn2, turn3);
    expectTailIs(responsesCase, turn3, [webSearch, developerNote, ...responsesCase.user(`${tag}: bye`)]);
  });

  it('anthropic: every turn start cuts the thinking before it, fold or not', async () => {
    fetcherMode = 'table';
    const tag = 'every-turn-cut';
    const session = nextSession(tag);
    const call = { id: `call_${tag}` };
    observe(call.id, 299);
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: explain`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add(anthropicCase.final('explained', true)).add(anthropicCase.user(`${tag}: now read`));
    // Turn 1 had no tool: it folds whole at once (its prompt and reply), and turn 2's start records the cut.
    const turn2 = await sendAndSettle(anthropicCase, conversation.body(), session);
    expect(turn2).not.toContain('"type":"thinking"');
    expect(timelineBlocksOf(anthropicCase, turn2).at(-2)).toBe(blockOfRows(`U: ${tag}: explain`, 'A: explained'));
    expect(ledgerEntriesOf(anthropicCase.agentId, session).filter(entry => entry.type === 'thinkingCut')).toEqual([{ type: 'thinkingCut', untilTurnOrdinal: 2 }]);
    conversation.add(anthropicCase.calls([call], true)).add(anthropicCase.results([call]));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add(anthropicCase.final('read', true)).add(anthropicCase.user(`${tag}: next`));
    const turn3 = await send(anthropicCase, conversation.body(), session);
    expect(timelineBlocksOf(anthropicCase, turn3).at(-2)).toBe(blockOfRows(`U: ${tag}: now read`, rowOf(299), 'A: read'));
    expectGrowsOnlyAfterTimelineEnd('anthropic', turn2, turn3);
  });

  it('gemini: a turn whose calls have only position ids folds whole, never through one of them', async () => {
    fetcherMode = 'table';
    const geminiCase = protocolCases[3];
    const tag = 'positional';
    const session = nextSession(tag);
    observationsForEveryToolUse = [observationFor(295)];
    try {
      const conversation = new Conversation(geminiCase).add(geminiCase.user(`${tag}: read`));
      await sendAndSettle(geminiCase, conversation.body(), session);
      conversation.add([{ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'go.mod' } } }] }])
        .add([{ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'module x' } } }] }]);
      await sendAndSettle(geminiCase, conversation.body(), session);
      conversation.add([{ role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'go.sum' } } }] }])
        .add([{ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'sums' } } }] }]);
      // Mid-turn, thinking off, the first call covered: it has only a position id, so nothing folds.
      expect(await sendAndSettle(geminiCase, conversation.body(), session)).toContain('go.mod');
      conversation.add(geminiCase.final('read', false)).add(geminiCase.user(`${tag}: next`));
      const turn2 = await send(geminiCase, conversation.body(), session);
      expect(turn2).not.toContain('go.mod');
      expect(timelineBlocksOf(geminiCase, turn2).at(-2)).toBe(blockOfRows(`U: ${tag}: read`, rowOf(295), 'A: read'));
      expect(foldsOf(geminiCase.agentId, session).map(fold => fold.throughCallId)).toEqual([null, null]);
    } finally {
      observationsForEveryToolUse = null;
    }
  });

  it('a conversation the earlier per-turn layout culled, or Endless Mode v1 swapped, is suspended: sent as it came, never folded', async () => {
    fetcherMode = 'table';
    for (const [tag, legacyEntry] of [
      ['legacy-cull', { type: 'cull', turnOrdinal: 1, throughCallId: 'call_old', lines: ['#1 3:04p 🔵 x'], observationIds: [1], culledTokensEst: 40, linesPlacement: 'own-message-at-cull-point' }],
      ['v1-swapped', { type: 'swap', callId: 'old_call', replacementText: '[claude-mem: replaced]', firstRequestAt: '2026-10-01T00:00:01.000Z', observationId: 9 }],
    ] as const) {
      const session = nextSession(tag);
      mkdirSync(ledgerDirectory, { recursive: true });
      writeFileSync(join(ledgerDirectory, `${conversationKeyOf({ agentId: anthropicCase.agentId, sessionId: session })}.jsonl`),
        [{ type: 'born', at: '2026-10-01T00:00:00.000Z' }, legacyEntry].map(entry => JSON.stringify(entry)).join('\n') + '\n');
      const call = { id: `call_${tag}` };
      observe(call.id, 603);
      const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: one`))
        .add(anthropicCase.calls([call], true)).add(anthropicCase.results([call])).add(anthropicCase.final('done', true)).add(anthropicCase.user(`${tag}: two`));
      expect(await sendAndSettle(anthropicCase, conversation.body(), session)).toBe(conversation.body());
      expect(await send(anthropicCase, conversation.body(), session)).toBe(conversation.body());
      expect(ledgerEntriesOf(anthropicCase.agentId, session).filter(entry => entry.type === 'suspended').map(entry => entry.stage)).toEqual(['endless-mode']);
    }
  });

  it('a recorded fold the history no longer matches (a compaction, a rewind) suspends the conversation', async () => {
    fetcherMode = 'table';
    const tag = 'history-changed';
    const session = nextSession(tag);
    const call = { id: `call_${tag}` };
    observe(call.id, 296);
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: one`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add(anthropicCase.calls([call], false)).add(anthropicCase.results([call]));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add(anthropicCase.final('done', false)).add(anthropicCase.user(`${tag}: two`));
    expect(await send(anthropicCase, conversation.body(), session)).toContain('#296');
    // The agent compacted: turn 1 is gone, and so is the turn the fold went through.
    const compacted = anthropicCase.body([...anthropicCase.user(`${tag}: two`)]);
    expect(await send(anthropicCase, compacted, session)).toBe(compacted);
    expect(ledgerEntriesOf(anthropicCase.agentId, session).filter(entry => entry.type === 'suspended').map(entry => entry.stage)).toEqual(['endless-mode']);
    expect(await send(anthropicCase, conversation.body(), session)).toBe(conversation.body());
  });

  it('never folds in a conversation it first saw mid-way', async () => {
    fetcherMode = 'table';
    const tag = 'not-born';
    const session = nextSession(tag);
    const call = { id: `call_${tag}` };
    observe(call.id, 501);
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: hi`))
      .add(anthropicCase.calls([call], true)).add(anthropicCase.results([call]));
    expect(await sendAndSettle(anthropicCase, conversation.body(), session)).toBe(conversation.body());
    conversation.add(anthropicCase.final('done', true)).add(anthropicCase.user(`${tag}: next`));
    expect(await sendAndSettle(anthropicCase, conversation.body(), session)).toBe(conversation.body());
  });

  it('with the worker down or hanging, nothing folds; mid-loop requests never wait, turn starts at most CONTEXT_TIMEOUT_MS', async () => {
    const timeConversation = async (routeId: string, tag: string) => {
      const session = nextSession(tag);
      const conversation = new Conversation(anthropicCase);
      let loopMs = 0;
      let slowestTurnStartMs = 0;
      for (let n = 1; n <= 4; n++) {
        const call = { id: `call_${tag}_${n}` };
        conversation.add(anthropicCase.user(`${tag}: task ${n}`));
        let started = performance.now();
        const sentAtStart = await send(anthropicCase, conversation.body(), session, routeId);
        slowestTurnStartMs = Math.max(slowestTurnStartMs, performance.now() - started);
        conversation.add(anthropicCase.calls([call], false)).add(anthropicCase.results([call]));
        started = performance.now();
        const sentInLoop = await send(anthropicCase, conversation.body(), session, routeId);
        loopMs += performance.now() - started;
        // No observation, no fold: every call stays.
        expect(sentInLoop).toContain(call.id);
        if (n > 1) expect(sentAtStart).toContain(`call_${tag}_${n - 1}`);
        conversation.add(anthropicCase.final(`done ${n}`, false));
      }
      return { loopMs, slowestTurnStartMs };
    };
    fetcherMode = 'hang';
    await timeConversation('endless-off', 'warm-off');
    await timeConversation(anthropicCase.routeId, 'warm-on');
    const baseline = await timeConversation('endless-off', 'baseline');
    const hanging = await timeConversation(anthropicCase.routeId, 'worker-hangs');
    fetcherMode = 'down';
    const down = await timeConversation(anthropicCase.routeId, 'worker-down');
    fetcherMode = 'table';
    // Four mid-loop requests each: a lookup that hangs forever costs them nothing noticeable
    // (250 ms: one request stage budget, REQUEST_STAGE_BUDGET_MS).
    expect(hanging.loopMs).toBeLessThan(baseline.loopMs + 250);
    expect(down.loopMs).toBeLessThan(baseline.loopMs + 250);
    // A turn start waits for a hanging worker no longer than CONTEXT_TIMEOUT_MS (plus that same 250 ms of leeway).
    expect(hanging.slowestTurnStartMs).toBeGreaterThanOrEqual(CONTEXT_TIMEOUT_MS - 5);
    expect(hanging.slowestTurnStartMs).toBeLessThan(baseline.slowestTurnStartMs + CONTEXT_TIMEOUT_MS + 250);
    expect(down.slowestTurnStartMs).toBeLessThan(baseline.slowestTurnStartMs + 250);
  });

  it('a turn start waits for the observations of earlier turns, so the fold lands on that request', async () => {
    fetcherMode = 'table';
    const tag = 'lands-on-turn-start';
    const session = nextSession(tag);
    const call = { id: `call_${tag}` };
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: one`));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation.add(anthropicCase.calls([call], true)).add(anthropicCase.results([call]));
    await sendAndSettle(anthropicCase, conversation.body(), session);
    // The observer finishes after the loop request; the turn start asks again and waits for the answer.
    observe(call.id, 298);
    conversation.add(anthropicCase.final('done', true)).add(anthropicCase.user(`${tag}: two`));
    const turn2 = await send(anthropicCase, conversation.body(), session);
    expect(timelineBlocksOf(anthropicCase, turn2).at(-2)).toBe(blockOfRows(`U: ${tag}: one`, rowOf(298), 'A: done'));
    expect(turn2).not.toContain(call.id);
  });

  it('anthropic: Claude Code\'s system notes fold with their turn; the current turn\'s own stay raw', async () => {
    fetcherMode = 'table';
    const tag = 'system-notes';
    const session = nextSession(tag);
    // The shapes Claude Code 2.1.310 sends (Phase 6 tee'd bodies, path sanitized).
    const tokensLeft = (left: number) => ({ role: 'system', content: `<total_tokens>${left} tokens left</total_tokens>` });
    const fileNote = { role: 'system', content: 'Note: /repo/main.py changed on disk since you last read it. That\'s usually deliberate, so take it as the current state rather than reverting it.' };
    const calls = ['a', 'b', 'c'].map(name => ({ id: `call_${tag}_${name}` }));
    for (const [index, call] of calls.entries()) observe(call.id, 310 + index);
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: make main.py`)).add([tokensLeft(15000000)]);
    const turnStart1 = await sendAndSettle(anthropicCase, conversation.body(), session);
    conversation
      .add(anthropicCase.calls([calls[0]], true)).add(anthropicCase.results([calls[0]])).add([tokensLeft(14999832)])
      .add(anthropicCase.calls([calls[1]], true)).add(anthropicCase.results([calls[1]])).add([fileNote, tokensLeft(14999800)])
      .add(anthropicCase.calls([calls[2]], true)).add(anthropicCase.results([calls[2]])).add([tokensLeft(14999217)]);
    await sendAndSettle(anthropicCase, conversation.body(), session);
    const nextTurn = [...anthropicCase.user(`${tag}: next`), tokensLeft(15000001)];
    conversation.add(anthropicCase.final('made it', true)).add(nextTurn);
    const turn2 = await send(anthropicCase, conversation.body(), session);
    expect(timelineBlocksOf(anthropicCase, turn2).at(-2)).toBe(blockOfRows(`U: ${tag}: make main.py`, rowOf(310), rowOf(311), rowOf(312), 'A: made it'));
    for (const text of [...calls.map(call => call.id), '14999832', '14999800', 'changed on disk', '14999217', '15000000 tokens']) expect(turn2).not.toContain(text);
    expectTailIs(anthropicCase, turn2, nextTurn);
    expectGrowsOnlyAfterTimelineEnd('anthropic', turnStart1, turn2);
    expectPairsWhole(anthropicCase, conversation.body(), turn2);
  });

  /** A finished turn 1 with one covered call, and the bodies of the next turn. */
  function killSwitchConversation(tag: string, observationId: number) {
    const call = { id: `call_${tag}` };
    observe(call.id, observationId);
    const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: one`));
    const bodies = [conversation.body()];
    conversation.add(anthropicCase.calls([call], true)).add(anthropicCase.results([call]));
    bodies.push(conversation.body());
    conversation.add(anthropicCase.final('done', true)).add(anthropicCase.user(`${tag}: two`));
    bodies.push(conversation.body());
    const nextCall = { id: `call_${tag}_next` };
    conversation.add(anthropicCase.calls([nextCall], true)).add(anthropicCase.results([nextCall]));
    bodies.push(conversation.body());
    conversation.add(anthropicCase.final('done again', true)).add(anthropicCase.user(`${tag}: three`));
    bodies.push(conversation.body());
    return bodies;
  }

  it('a route switched off stops at once, and never resumes a conversation it went without the timeline in', async () => {
    fetcherMode = 'table';
    const tag = 'kill-switch';
    const session = nextSession(tag);
    const bodies = killSwitchConversation(tag, 601);
    for (const body of bodies.slice(0, 2)) await sendAndSettle(anthropicCase, body, session, 'endless-kill');
    expect(await send(anthropicCase, bodies[2], session, 'endless-kill')).toContain('#601');
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', false, routesFilePath)).toBe(true);
    expect(readWireGatewayRoutesFile(routesFilePath).routes['endless-kill'].features.endlessMode).toBe(false);
    expect(await send(anthropicCase, bodies[3], session, 'endless-kill')).toBe(bodies[3]);
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', true, routesFilePath)).toBe(true);
    expect(await send(anthropicCase, bodies[4], session, 'endless-kill')).toBe(bodies[4]);
    expect(setWireGatewayRouteFeature('endless-kill', 'endlessMode', undefined, routesFilePath)).toBe(true);
    expect(readWireGatewayRoutesFile(routesFilePath).routes['endless-kill'].features).toEqual({});
  });

  it('switched off and on with no request between, keeps putting the same timeline back', async () => {
    fetcherMode = 'table';
    const tag = 'kill-switch-idle';
    const session = nextSession(tag);
    const bodies = killSwitchConversation(tag, 602);
    for (const body of bodies.slice(0, 2)) await sendAndSettle(anthropicCase, body, session, 'endless-kill');
    const folded = await send(anthropicCase, bodies[2], session, 'endless-kill');
    expect(folded).toContain('#602');
    setWireGatewayRouteFeature('endless-kill', 'endlessMode', false, routesFilePath);
    setWireGatewayRouteFeature('endless-kill', 'endlessMode', undefined, routesFilePath);
    expectGrowsOnlyAfterTimelineEnd('anthropic', folded, await send(anthropicCase, bodies[3], session, 'endless-kill'));
  });

  it('records each fold\'s tokens once, on the request that recorded it, which status --endless adds up', async () => {
    const newlyFoldedTokensOf = (agentId: string, session: string) =>
      foldsOf(agentId, session).reduce((sum, fold) => sum + (fold.culledTokensEst as number), 0);
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
      if (conversations.length > 0 && conversations.every(({ agent, session, recorded }) => recorded === newlyFoldedTokensOf(agent, session))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const conversations = conversationsOf(records);
    expect(conversations.length).toBeGreaterThan(0);
    for (const { agent, session, recorded, requests } of conversations) {
      expect(recorded).toBe(newlyFoldedTokensOf(agent, session));
      expect(requests).toBeLessThanOrEqual(foldsOf(agent, session).length);
    }
    const report = buildEndlessModeReport(records);
    expect(report.map(agent => agent.agentId)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini-cli', 'opencode']));
  });
});

describe('the timeline\'s row formats', () => {
  for (const rowFormat of ENDLESS_TIMELINE_ROW_FORMATS) {
    it(`${rowFormat}: the gateway asks the worker for rows in that format and puts them in the timeline as they come`, async () => {
      const formatLedgerDirectory = join(testRoot, `ledger-${rowFormat}`);
      const formatGateway = await startWireGatewayForTest({
        routesFilePath,
        routesReloadCheckIntervalMs: 0,
        rewriteSettings: { ...ENDLESS_SETTINGS, CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: rowFormat },
        observationLookup: new WireObservationLookup({ fetchToolObservations: trackedFetcher, missBackoffBaseMs: 0 }),
        conversationLedger: new WireConversationLedger({ directory: formatLedgerDirectory }),
      });
      try {
        fetcherMode = 'table';
        const tag = `format-${rowFormat}`;
        const session = nextSession(tag);
        const call = { id: `call_${tag}` };
        observe(call.id, 701);
        askedRowFormats.length = 0;
        const conversation = new Conversation(anthropicCase).add(anthropicCase.user(`${tag}: one`));
        await sendAndSettle(anthropicCase, conversation.body(), session, undefined, formatGateway);
        conversation.add(anthropicCase.calls([call], true)).add(anthropicCase.results([call]));
        await sendAndSettle(anthropicCase, conversation.body(), session, undefined, formatGateway);
        conversation.add(anthropicCase.final('done', true)).add(anthropicCase.user(`${tag}: two`));
        const turn2 = await send(anthropicCase, conversation.body(), session, undefined, formatGateway);
        expect(new Set(askedRowFormats)).toEqual(new Set([rowFormat]));
        const row = rowFormat === 'timeline' ? rowOf(701) : `${rowOf(701)} [${rowFormat}]`;
        expect(timelineBlocksOf(anthropicCase, turn2).at(-2)).toBe(blockOfRows(`U: ${tag}: one`, row, 'A: done'));
      } finally {
        await formatGateway.stop();
      }
    });
  }

  it('an unknown format fails loudly: the gateway refuses to start, and the stage never falls back', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: 'full' })).toContain('CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT must be one of');
    for (const rowFormat of ENDLESS_TIMELINE_ROW_FORMATS) expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: rowFormat })).toBeNull();
    expect(() => endlessTimelineRowFormatOf('full')).toThrow('unknown Endless Mode row format');
    expect(endlessTimelineRowFormatOf(undefined)).toBe('timeline');
  });
});

describe('the timeline block', () => {
  it('is never the user\'s words: it neither starts nor hides a turn, and capture strips it', () => {
    const span = { start: 0, end: 0, type: 'string' as const };
    const message = (...texts: string[]) => ({ role: 'user' as const, parts: texts.map(text => ({ kind: 'text' as const, text, span })), span });
    const blocks = [...timelineBlockTextsOf('<claude-mem-context>\nrows\n</claude-mem-context>', [['U: fix it', '#1 3:04p 🔵 Read', 'A: fixed']]), TIMELINE_CLOSE_TAG];
    expect(startsUserTurn(message(...blocks))).toBe(false);
    // Gemini: the timeline's parts first, then the prompt's, in one content.
    expect(startsUserTurn(message(...blocks, 'go on'))).toBe(true);
    expect(userWordsInMessage(message(...blocks, 'go on'))).toBe('go on');
    expect(userWordsInText(`${TIMELINE_OPEN_TAG}\nrows\n${TIMELINE_CLOSE_TAG}`)).toBe('');
    expect(stripMemoryTags(`before ${TIMELINE_OPEN_TAG}x${TIMELINE_CLOSE_TAG} after`)).toBe('before  after');
  });
});

describe('the observation lookup', () => {
  it('never waits, dedupes a lookup in flight, and caches no failure', async () => {
    let now = 0;
    let calls = 0;
    let answer: 'fail' | Map<string, WireToolObservation[]> = 'fail';
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
    const query = { contentSessionId: 's', platformSource: 'codex', toolUseIds: ['a', 'b'], rowFormat: 'timeline' as const };
    const first = lookup.requestRefresh('conversation', query);
    expect(lookup.requestRefresh('conversation', query)).toBe(first);
    expect(calls).toBe(1);
    release();
    await first;
    expect(lookup.cached('conversation', 'a')).toBeUndefined();
    await lookup.requestRefresh('conversation', query);
    expect(calls).toBe(1);
    now = 1_000;
    answer = new Map([['a', [observationFor(9)]]]);
    const second = lookup.requestRefresh('conversation', query);
    expect(calls).toBe(2);
    release();
    await second;
    expect(lookup.cached('conversation', 'a')?.map(observation => observation.observationId)).toEqual([9]);
    expect(lookup.cached('conversation', 'b')).toBeUndefined();
  });

  it('asks again about a missing observation less and less often, and never about a found one', async () => {
    let now = 0;
    const asked: Array<{ at: number; ids: string[] }> = [];
    let found = new Map<string, WireToolObservation[]>([['a', [observationFor(9)]]]);
    const lookup = new WireObservationLookup({
      missBackoffBaseMs: 5_000,
      now: () => now,
      fetchToolObservations: async query => { asked.push({ at: now, ids: query.toolUseIds }); return found; },
    });
    const query = { contentSessionId: 's', platformSource: 'codex', toolUseIds: ['a', 'b'], rowFormat: 'timeline' as const };
    for (const at of [0, 1_000, 5_000, 9_000, 15_000, 35_000]) {
      now = at;
      await lookup.requestRefresh('c', query);
    }
    expect(asked).toEqual([
      { at: 0, ids: ['a', 'b'] },
      { at: 5_000, ids: ['b'] },
      { at: 15_000, ids: ['b'] },
      { at: 35_000, ids: ['b'] },
    ]);
    found = new Map([['b', [observationFor(10)]]]);
    now = 200_000;
    await lookup.requestRefresh('c', query);
    expect(lookup.cached('c', 'b')?.map(observation => observation.observationId)).toEqual([10]);
  });

  it('reads every observation of each tool use\'s batch, as rows in the asked format, from the worker\'s /api/wire/tool-observations', async () => {
    const worker = await startFakeUpstream(request => request.path === '/api/wire/tool-observations'
      ? { kind: 'json', body: { observations: [
        { toolUseId: 'toolu_1', observationId: 43, title: 'Tests run', narrative: '', facts: [], timelineLine: '#43 3:05p 🔵 Tests run', row: '#43 3:05p 🔵 Tests run\nfacts' },
        { toolUseId: 'toolu_1', observationId: 42, title: 'Parser read', narrative: 'It parses.', facts: ['one', 'two'], timelineLine: '#42 3:04p 🔵 Parser read', row: '#42 3:04p 🔵 Parser read\nfacts' },
        // A worker older than the row formats sends no row: taken as no observation.
        { toolUseId: 'toolu_2', observationId: 44, title: 'Old worker', narrative: '', facts: [], timelineLine: '#44 3:06p 🔵 Old worker' },
      ] } }
      : { kind: 'json', status: 404, body: { error: 'not found' } });
    try {
      const found = await fetchToolObservationsFromWorker(
        { contentSessionId: 'session-1', platformSource: 'claude-code', toolUseIds: ['toolu_1', 'toolu_2'], rowFormat: 'observation' },
        apiPath => `${worker.url}${apiPath}`,
      );
      expect([...found.entries()]).toEqual([['toolu_1', [
        { observationId: 42, row: '#42 3:04p 🔵 Parser read\nfacts' },
        { observationId: 43, row: '#43 3:05p 🔵 Tests run\nfacts' },
      ]]]);
      expect(worker.requests.map(request => [request.path, JSON.parse(textOf(request.body))])).toEqual([
        ['/api/wire/tool-observations', { platformSource: 'claude-code', contentSessionId: 'session-1', toolUseIds: ['toolu_1', 'toolu_2'], rowFormat: 'observation' }],
      ]);
      // (Caught by hand: `expect(promise).rejects` crashes Bun 1.3.9 here.)
      const failure = await fetchToolObservationsFromWorker(
        { contentSessionId: 's', platformSource: 'p', toolUseIds: ['x'], rowFormat: 'timeline' },
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
  const replayed = ['endless-mode'];

  it('splits each conversation at its first fold and counts each fold\'s tokens once, per agent', () => {
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
    expect(text).toContain('~800 tokens saved');
    expect(text).not.toMatch(/swap/i);
  });

  it('reads only the usage day files the retention keeps, and old lines as no folds', () => {
    const directory = join(testRoot, 'status-endless-usage');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const nowMs = Date.parse('2026-10-24T12:00:00.000Z');
    const linesOf = (...records: object[]) => records.map(line => JSON.stringify(line)).join('\n') + '\n';
    writeFileSync(join(directory, '2026-10-10.jsonl'), linesOf(record('old', '2026-10-10T00:00:01Z', 0, 0, 9_000, replayed)));
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
