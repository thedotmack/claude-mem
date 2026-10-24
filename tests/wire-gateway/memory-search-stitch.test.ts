import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { arrayElements, getSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { NO_MORE_SEARCHES_TEXT } from '../../src/services/wire-gateway/memory/stitch/hidden-tool-loop.js';
import type { MemorySearchQuery } from '../../src/services/wire-gateway/memory/memory-worker-client.js';
import type { RelayObserver } from '../../src/services/wire-gateway/relay/relay.js';
import { isRecursiveMemoryTool } from '../../src/shared/memory-retrieval-tools.js';
import { OutboundRedactionPlaceholders } from '../../src/services/wire-gateway/privacy/outbound-redaction.js';
import { startFakeUpstream, type FakeUpstream, type FakeUpstreamScript } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { expectDiffersOnlyInsideDeclaredSpans } from './golden/golden-harness.js';
import {
  STITCH_PROTOCOL_CASES,
  parseClientSse,
  scriptedRounds,
  type ClientSseEvent,
  type ScriptedRound,
  type StitchProtocolCase,
} from './helpers/stitch-scripts.js';

// The hidden memory_search loop (plan Phase 12 task 2) through the real
// relay, per protocol, against scripted vendor rounds: the agent gets one
// coherent reply with contiguous indexes and merged usage; mixed calls end
// with the model's own stop; the round cap holds; whole (non-stream) replies
// merge; keepalives go out the protocol's way, and never to Gemini.

const testRoot = join(WIRE_GATEWAY_DIR, 'memory-search-stitch-test');
const routesFilePath = join(testRoot, 'routes.json');
const decoder = new TextDecoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

const KEEPALIVE_INTERVAL_MS = 25;

let searchDelayMs = 0;
const searchQueries: MemorySearchQuery[] = [];
async function fakeSearcher(query: MemorySearchQuery) {
  searchQueries.push(query);
  if (searchDelayMs > 0) await new Promise(resolve => setTimeout(resolve, searchDelayMs));
  return { text: `memories about ${query.query}: #12 the token refresh race`, isError: false };
}

/** What the relay observers (capture) were handed of each reply. */
const capturedReplyText: string[] = [];
let captureFinished: () => void = () => undefined;
const captureObserver: RelayObserver = {
  onResponseChunk: (_exchange, chunk) => capturedReplyText.push(decoder.decode(chunk)),
  onExchangeFinished: () => captureFinished(),
};

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

const routeOf = (testCase: StitchProtocolCase, kind: 'on' | 'off' | 'redacted') => `search-${kind}-${testCase.protocol}`;

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream();
  for (const testCase of STITCH_PROTOCOL_CASES) {
    addWireGatewayRoute({ routeId: routeOf(testCase, 'on'), agentId: testCase.agentId, upstreamBaseUrl: upstream.url, captureSource: 'wire', features: { memorySearchTool: true, memoryInjection: false } }, routesFilePath);
    addWireGatewayRoute({ routeId: routeOf(testCase, 'off'), agentId: testCase.agentId, upstreamBaseUrl: upstream.url, captureSource: 'wire', features: { memoryInjection: false } }, routesFilePath);
    addWireGatewayRoute({ routeId: routeOf(testCase, 'redacted'), agentId: testCase.agentId, upstreamBaseUrl: upstream.url, captureSource: 'wire', features: { memorySearchTool: true, memoryInjection: false, outboundRedaction: true } }, routesFilePath);
  }
  gateway = await startWireGatewayForTest({
    routesFilePath,
    conversationLedger: new WireConversationLedger({ directory: join(testRoot, 'ledger') }),
    rewriteSettings: { CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL: 'false' },
    memory: { search: { searcher: fakeSearcher, keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS } },
    relayObserver: captureObserver,
    outboundRedactionPlaceholders: new OutboundRedactionPlaceholders({ keyFilePath: join(testRoot, 'redact.key') }),
  });
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

let sessionCounter = 0;

interface Exchange {
  clientText: string;
  /** Bodies the vendor got, in order. */
  upstreamBodies: Uint8Array[];
}

async function converse(
  testCase: StitchProtocolCase,
  routeKind: 'on' | 'off' | 'redacted',
  rounds: ScriptedRound[] | FakeUpstreamScript,
  stream: boolean,
  requestBody: string = testCase.requestBody(stream),
): Promise<Exchange> {
  upstream.setReply(Array.isArray(rounds) ? scriptedRounds(testCase, rounds, stream) : rounds);
  const before = upstream.requests.length;
  searchQueries.length = 0;
  capturedReplyText.length = 0;
  const finished = new Promise<void>(resolve => {
    captureFinished = resolve;
  });
  const response = await fetch(`${gateway.baseUrl}/r/${routeOf(testCase, routeKind)}${stream ? testCase.streamPath : testCase.wholePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'x-claude-mem-session': `stitch-${++sessionCounter}` },
    body: requestBody,
  });
  expect(response.status).toBe(200);
  const clientText = await response.text();
  // Observers get their copy off the client's path; the exchange's end comes after every chunk.
  await finished;
  return { clientText, upstreamBodies: upstream.requests.slice(before).map(request => request.body) };
}

const USAGE_1 = { input: 100, output: 20, cacheRead: 1000 };
const USAGE_2 = { input: 7, output: 30, cacheRead: 1150 };
const searchCall = (n: number) => ({ id: `call_mem_${n}`, name: 'memory_search', args: { query: `auth bug ${n}`, limit: 3 } });
const readCall = { id: 'call_read_1', name: 'Read', args: { path: '/work/app/auth.ts' } };

const HIDDEN_ROUND: ScriptedRound = { thinking: 'I should look this up.', text: 'Let me check.', calls: [searchCall(1)], usage: USAGE_1 };
const FINAL_ROUND: ScriptedRound = { thinking: 'Now I know.', text: 'Found it.', calls: [], usage: USAGE_2 };

// ---------------------------------------------------------------------------
// What the client got, per protocol

interface ClientView {
  /** The visible text, in order. */
  text: string;
  /** The agent's own tool calls the client saw, by name. */
  callNames: string[];
  /** The protocol's stop, as the client read it. */
  stop: string | null;
  usage: { input: number; output: number; cacheRead: number };
}

function anthropicView(exchange: Exchange, stream: boolean): ClientView {
  if (!stream) {
    const message = JSON.parse(exchange.clientText);
    return {
      text: message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
      callNames: message.content.filter((block: any) => block.type === 'tool_use').map((block: any) => block.name),
      stop: message.stop_reason,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens, cacheRead: message.usage.cache_read_input_tokens },
    };
  }
  const events = parseClientSse(exchange.clientText).filter(event => event.json && event.name !== 'ping');
  expect(events.filter(event => event.name === 'message_start')).toHaveLength(1);
  expect(events.filter(event => event.name === 'message_stop')).toHaveLength(1);
  expect(events[events.length - 1].name).toBe('message_stop');
  // Indexes run 0, 1, 2… and every delta and stop belongs to a started block.
  const starts = events.filter(event => event.name === 'content_block_start');
  expect(starts.map(event => event.json!.index)).toEqual(starts.map((_, index) => index));
  for (const event of events.filter(event => event.name === 'content_block_delta' || event.name === 'content_block_stop')) {
    expect(event.json!.index).toBeLessThan(starts.length);
  }
  const delta = events.filter(event => event.name === 'message_delta');
  expect(delta).toHaveLength(1);
  const start = events[0].json!.message.usage;
  const final = delta[0].json!.usage;
  return {
    text: events.filter(event => event.json!.delta?.type === 'text_delta').map(event => event.json!.delta.text).join(''),
    callNames: starts.filter(event => event.json!.content_block.type === 'tool_use').map(event => event.json!.content_block.name),
    stop: delta[0].json!.delta.stop_reason,
    usage: { input: final.input_tokens ?? start.input_tokens, output: final.output_tokens, cacheRead: final.cache_read_input_tokens ?? start.cache_read_input_tokens },
  };
}

function chatView(exchange: Exchange, stream: boolean): ClientView {
  if (!stream) {
    const completion = JSON.parse(exchange.clientText);
    const message = completion.choices[0].message;
    return {
      text: message.content ?? '',
      callNames: (message.tool_calls ?? []).map((call: any) => call.function.name),
      stop: completion.choices[0].finish_reason,
      usage: { input: completion.usage.prompt_tokens - completion.usage.prompt_tokens_details.cached_tokens, output: completion.usage.completion_tokens, cacheRead: completion.usage.prompt_tokens_details.cached_tokens },
    };
  }
  const events = parseClientSse(exchange.clientText).filter(event => event.name !== ':');
  expect(events.filter(event => event.data === '[DONE]')).toHaveLength(1);
  expect(events[events.length - 1].data).toBe('[DONE]');
  const chunks = events.filter(event => event.json);
  const finishes = chunks.map(event => event.json!.choices?.[0]?.finish_reason).filter(Boolean);
  expect(finishes).toHaveLength(1);
  // The agent's calls are numbered from 0 with no gap.
  const callIndexes = new Map<number, string>();
  for (const event of chunks) {
    for (const call of event.json!.choices?.[0]?.delta?.tool_calls ?? []) {
      if (call.function?.name) callIndexes.set(call.index, call.function.name);
      else expect(callIndexes.has(call.index)).toBe(true);
    }
  }
  expect([...callIndexes.keys()]).toEqual([...callIndexes.keys()].map((_, index) => index));
  const usageChunks = chunks.filter(event => event.json!.usage);
  expect(usageChunks).toHaveLength(1);
  const usage = usageChunks[0].json!.usage;
  return {
    text: chunks.map(event => event.json!.choices?.[0]?.delta?.content ?? '').join(''),
    callNames: [...callIndexes.values()],
    stop: finishes[0],
    usage: { input: usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens, output: usage.completion_tokens, cacheRead: usage.prompt_tokens_details.cached_tokens },
  };
}

function responsesView(exchange: Exchange, stream: boolean): ClientView {
  const viewOf = (response: any) => {
    const usage = response.usage;
    return {
      text: response.output.filter((item: any) => item.type === 'message').map((item: any) => item.content.map((part: any) => part.text).join('')).join(''),
      callNames: response.output.filter((item: any) => item.type === 'function_call').map((item: any) => item.name),
      stop: response.status,
      usage: { input: usage.input_tokens - usage.input_tokens_details.cached_tokens, output: usage.output_tokens, cacheRead: usage.input_tokens_details.cached_tokens },
    };
  };
  if (!stream) return viewOf(JSON.parse(exchange.clientText));
  const events = parseClientSse(exchange.clientText).filter(event => event.json);
  // sequence_number runs 0, 1, 2… over everything the client got.
  expect(events.map(event => event.json!.sequence_number)).toEqual(events.map((_, index) => index));
  expect(events.filter(event => event.name === 'response.created')).toHaveLength(1);
  const completed = events.filter(event => event.name === 'response.completed');
  expect(completed).toHaveLength(1);
  expect(events[events.length - 1].name).toBe('response.completed');
  const added = events.filter(event => event.name === 'response.output_item.added');
  expect(added.map(event => event.json!.output_index)).toEqual(added.map((_, index) => index));
  for (const event of events.filter(event => event.json!.output_index !== undefined)) {
    expect(event.json!.output_index).toBeLessThan(added.length);
  }
  const view = viewOf(completed[0].json!.response);
  // What the deltas said is what the final output says.
  expect(events.filter(event => event.name === 'response.output_text.delta').map(event => event.json!.delta).join('')).toBe(view.text);
  return view;
}

function geminiView(exchange: Exchange, stream: boolean): ClientView {
  const chunks: any[] = stream ? parseClientSse(exchange.clientText).map(event => {
    expect(event.name).not.toBe(':');
    return event.json;
  }) : [JSON.parse(exchange.clientText)];
  const parts = chunks.flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? []);
  const finishes = chunks.map(chunk => chunk.candidates?.[0]?.finishReason).filter(Boolean);
  expect(finishes).toHaveLength(1);
  const usage = chunks[chunks.length - 1].usageMetadata;
  return {
    text: parts.filter((part: any) => part.text !== undefined && !part.thought).map((part: any) => part.text).join(''),
    callNames: parts.filter((part: any) => part.functionCall).map((part: any) => part.functionCall.name),
    stop: finishes[0],
    usage: { input: usage.promptTokenCount - usage.cachedContentTokenCount, output: usage.candidatesTokenCount, cacheRead: usage.cachedContentTokenCount },
  };
}

const VIEWS: Record<string, (exchange: Exchange, stream: boolean) => ClientView> = {
  anthropic: anthropicView, 'openai-chat': chatView, 'openai-responses': responsesView, gemini: geminiView,
};
const PLAIN_STOP: Record<string, string> = { anthropic: 'end_turn', 'openai-chat': 'stop', 'openai-responses': 'completed', gemini: 'STOP' };
const TOOL_STOP: Record<string, string> = { anthropic: 'tool_use', 'openai-chat': 'tool_calls', 'openai-responses': 'completed', gemini: 'STOP' };

const sumUsage = (...usages: Array<{ input: number; output: number; cacheRead: number }>) => usages.reduce(
  (total, usage) => ({ input: total.input + usage.input, output: total.output + usage.output, cacheRead: total.cacheRead + usage.cacheRead }),
  { input: 0, output: 0, cacheRead: 0 },
);

/** Where the agent's turns are in a request body. */
const TURNS_KEY: Record<string, string> = { anthropic: 'messages', 'openai-chat': 'messages', 'openai-responses': 'input', gemini: 'contents' };

function lastTurnEnd(body: Uint8Array, protocol: string): number {
  const turns = [...arrayElements(body, getSpan(body, [TURNS_KEY[protocol]])!)];
  return turns[turns.length - 1].end;
}

/** What round 2's request appended after round 1's turns. */
function appendedTurns(exchange: Exchange, protocol: string): string {
  const [first, second] = exchange.upstreamBodies;
  const insertAt = lastTurnEnd(first, protocol);
  return textOf(second.subarray(insertAt, second.length - (first.length - insertAt)));
}

/** Every JSON object the client got: its stream's events, or the one whole reply. */
function clientObjects(exchange: Exchange, stream: boolean): Array<Record<string, any>> {
  return stream ? parseClientSse(exchange.clientText).flatMap(event => (event.json ? [event.json] : [])) : [JSON.parse(exchange.clientText)];
}

const caseOf = (protocol: string) => STITCH_PROTOCOL_CASES.find(testCase => testCase.protocol === protocol)!;

// ---------------------------------------------------------------------------

describe('hidden memory_search: one coherent reply per protocol', () => {
  for (const testCase of STITCH_PROTOCOL_CASES) {
    for (const stream of [true, false]) {
      it(`${testCase.protocol} ${stream ? 'stream' : 'non-stream'}: a search round then an answer reach the agent as one reply`, async () => {
        const exchange = await converse(testCase, 'on', [HIDDEN_ROUND, FINAL_ROUND], stream);
        expect(exchange.upstreamBodies).toHaveLength(2);
        expect(exchange.clientText).not.toContain('memory_search');
        expect(exchange.clientText).not.toContain('memories about');
        const view = VIEWS[testCase.protocol](exchange, stream);
        // Text after a search goes on after a blank line (each Responses round is its own message item).
        expect(view.text).toBe(testCase.protocol === 'openai-responses' ? 'Let me check.Found it.' : 'Let me check.\n\nFound it.');
        expect(view.callNames).toEqual([]);
        expect(view.stop).toBe(PLAIN_STOP[testCase.protocol]);
        expect(view.usage).toEqual(sumUsage(USAGE_1, USAGE_2));

        // The search ran with what the model asked, in the agent's folder.
        expect(searchQueries.map(({ signal: _signal, ...query }) => query)).toEqual([{ query: 'auth bug 1', limit: 3, workDir: '/work/app', timeoutMs: 5000 }]);
        // The search stops with the agent's request.
        expect(searchQueries[0].signal).toBeInstanceOf(AbortSignal);

        // Round 1 carried the tool at the end of the agent's tools.
        const [first, second] = exchange.upstreamBodies;
        expect(textOf(first)).toContain('"memory_search"');
        // Round 2 is round 1's bytes with the turns appended after the last one, nothing else changed.
        const insertAt = lastTurnEnd(first, testCase.protocol);
        expectDiffersOnlyInsideDeclaredSpans(first, second, [{ start: insertAt, end: insertAt }]);
        const appended = textOf(second.subarray(insertAt, second.length - (first.length - insertAt)));
        expect(appended).toContain('memories about auth bug 1: #12 the token refresh race');
        expect(appended).toContain('call_mem_1');
        // The assistant turn as it came: sealed reasoning kept.
        if (testCase.protocol === 'anthropic') expect(appended).toContain('"signature":"sig-1"');
        if (testCase.protocol === 'openai-responses') expect(appended).toContain('"encrypted_content":"ZW5j-1"');
        if (testCase.protocol === 'gemini') expect(appended).toContain('"thoughtSignature":"c2ln-1"');

        // Capture saw what the agent saw, never the hidden calls.
        if (stream) expect(capturedReplyText.join('')).toBe(exchange.clientText);
      });
    }
  }

  it('memory_search and its renamed forms are never captured as tool uses', () => {
    expect(isRecursiveMemoryTool('memory_search')).toBe(true);
    expect(isRecursiveMemoryTool('claude_mem_memory_search')).toBe(true);
    expect(isRecursiveMemoryTool('claude_mem_memory_search_2')).toBe(true);
  });
});

describe('hidden memory_search: mixed calls', () => {
  for (const testCase of STITCH_PROTOCOL_CASES) {
    for (const stream of [true, false]) {
      it(`${testCase.protocol} ${stream ? 'stream' : 'non-stream'}: hidden and agent calls together end with the model's own stop; the hidden ones are neither shown nor run`, async () => {
        const mixed: ScriptedRound = { text: 'Two things.', calls: [searchCall(1), readCall], usage: USAGE_1 };
        const exchange = await converse(testCase, 'on', [mixed], stream);
        expect(exchange.upstreamBodies).toHaveLength(1);
        expect(searchQueries).toHaveLength(0);
        expect(exchange.clientText).not.toContain('memory_search');
        const view = VIEWS[testCase.protocol](exchange, stream);
        expect(view.callNames).toEqual(['Read']);
        expect(view.text).toBe('Two things.');
        expect(view.stop).toBe(TOOL_STOP[testCase.protocol]);
        expect(view.usage).toEqual(USAGE_1);
        if (testCase.protocol === 'gemini') {
          // Gemini signed the step's first call, the hidden one: the agent's call carries the signature now.
          const callParts = clientObjects(exchange, stream).flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? []).filter((part: any) => part.functionCall);
          expect(callParts).toEqual([{ functionCall: { id: readCall.id, name: 'Read', args: readCall.args }, thoughtSignature: 'c2ln-1' }]);
        }
      });
    }
  }
});

describe('hidden memory_search: the round cap', () => {
  for (const testCase of STITCH_PROTOCOL_CASES) {
    it(`${testCase.protocol}: a model that never stops searching gets 6 rounds answered, then a plain stop on the 7th`, async () => {
      const searching: ScriptedRound = { text: 'Searching.', calls: [searchCall(9)], usage: { input: 1, output: 1, cacheRead: 0 } };
      const exchange = await converse(testCase, 'on', [searching], true);
      expect(exchange.upstreamBodies).toHaveLength(7);
      // Rounds 1–5 were searched; round 6 was told there would be no more.
      expect(searchQueries).toHaveLength(5);
      expect(textOf(exchange.upstreamBodies[5])).not.toContain(NO_MORE_SEARCHES_TEXT);
      expect(textOf(exchange.upstreamBodies[6])).toContain(NO_MORE_SEARCHES_TEXT);
      expect(exchange.clientText).not.toContain('memory_search');
      const view = VIEWS[testCase.protocol](exchange, true);
      expect(view.stop).toBe(PLAIN_STOP[testCase.protocol]);
      expect(view.callNames).toEqual([]);
      expect(view.usage).toEqual({ input: 7, output: 7, cacheRead: 0 });
    });
  }
});

describe('hidden memory_search: keepalives while the search runs', () => {
  for (const testCase of STITCH_PROTOCOL_CASES) {
    it(`${testCase.protocol}: ${testCase.protocol === 'gemini' ? 'no keepalive of any kind' : 'the protocol\'s own keepalive'}`, async () => {
      searchDelayMs = 150;
      let exchange: Exchange;
      try {
        exchange = await converse(testCase, 'on', [HIDDEN_ROUND, FINAL_ROUND], true);
      } finally {
        searchDelayMs = 0;
      }
      const events = parseClientSse(exchange.clientText);
      const upstreamEvents = [...testCase.streamRound(HIDDEN_ROUND, 1), ...testCase.streamRound(FINAL_ROUND, 2)].flatMap(chunk => parseClientSse(chunk));
      const count = (list: ClientSseEvent[], match: (event: ClientSseEvent) => boolean) => list.filter(match).length;
      switch (testCase.protocol) {
        case 'anthropic':
          // Each round's own ping, and keepalives beside them.
          expect(count(events, event => event.name === 'ping')).toBeGreaterThanOrEqual(count(upstreamEvents, event => event.name === 'ping') + 2);
          break;
        case 'openai-chat':
          expect(count(events, event => event.name === ':' && event.data === ': keepalive')).toBeGreaterThanOrEqual(2);
          expect(count(events, event => event.name !== ':' && event.data === '')).toBe(0);
          break;
        case 'openai-responses':
          // Beyond round 1's own in_progress; sequence numbers stay contiguous (checked in the view).
          expect(count(events, event => event.name === 'response.in_progress')).toBeGreaterThanOrEqual(3);
          break;
        case 'gemini':
          expect(exchange.clientText).not.toMatch(/(^|\n):/);
          expect(events.every(event => event.json !== null)).toBe(true);
          break;
      }
      const view = VIEWS[testCase.protocol](exchange, true);
      expect(view.usage).toEqual(sumUsage(USAGE_1, USAGE_2));
    });
  }
});

describe('hidden memory_search: when it stays out of the way', () => {
  for (const testCase of STITCH_PROTOCOL_CASES) {
    it(`${testCase.protocol}: a reply with no hidden call reaches the agent byte for byte`, async () => {
      const plain: ScriptedRound = { thinking: 'Easy.', text: 'Just answering.', calls: [readCall], usage: USAGE_1 };
      const exchange = await converse(testCase, 'on', [plain], true);
      expect(exchange.clientText).toBe(testCase.streamRound(plain, 1).join(''));
    });

    it(`${testCase.protocol}: with the feature off, request and reply relay byte for byte (even a call named memory_search)`, async () => {
      const exchange = await converse(testCase, 'off', [HIDDEN_ROUND, FINAL_ROUND], true);
      expect(exchange.upstreamBodies).toHaveLength(1);
      expect(textOf(exchange.upstreamBodies[0])).toBe(testCase.requestBody(true));
      expect(exchange.clientText).toBe(testCase.streamRound(HIDDEN_ROUND, 1).join(''));
      expect(searchQueries).toHaveLength(0);
    });
  }

  it('a later round that fails ends the reply without an end marker (a cut), after an error event', async () => {
    const testCase = STITCH_PROTOCOL_CASES[0];
    let played = 0;
    upstream.setReply(() => (played++ === 0
      ? { kind: 'sse', chunks: testCase.streamRound(HIDDEN_ROUND, 1) }
      : { kind: 'json', status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }));
    const response = await fetch(`${gateway.baseUrl}/r/${routeOf(testCase, 'on')}${testCase.streamPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'x-claude-mem-session': `stitch-${++sessionCounter}` },
      body: testCase.requestBody(true),
    });
    let clientText = '';
    let readFailed = false;
    try {
      clientText = await response.text();
    } catch {
      readFailed = true;
    }
    expect(readFailed || !clientText.includes('message_stop')).toBe(true);
    if (!readFailed) expect(clientText).toContain('Overloaded');
  }, 15_000);
});

describe('hidden memory_search: Gemini signatures when the hidden call is not first', () => {
  for (const stream of [true, false]) {
    it(`gemini ${stream ? 'stream' : 'non-stream'}: an agent call that was signed keeps its own signature`, async () => {
      // The agent's call is first and signed; the hidden one after it has none to give.
      const mixed: ScriptedRound = { text: 'Two things.', calls: [readCall, searchCall(1)], usage: USAGE_1 };
      const exchange = await converse(caseOf('gemini'), 'on', [mixed], stream);
      const callParts = clientObjects(exchange, stream).flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? []).filter((part: any) => part.functionCall);
      expect(callParts).toEqual([{ functionCall: { id: readCall.id, name: 'Read', args: readCall.args }, thoughtSignature: 'c2ln-1' }]);
    });
  }
});

describe('hidden memory_search: the reply keeps round 1\'s id', () => {
  const ID_OF: Record<string, (object: Record<string, any>) => unknown> = {
    'openai-chat': object => object.id,
    gemini: object => object.responseId,
    anthropic: object => object.id ?? object.message?.id,
  };
  for (const protocol of Object.keys(ID_OF)) {
    for (const stream of [true, false]) {
      it(`${protocol} ${stream ? 'stream' : 'non-stream'}: every id the client reads is round 1's`, async () => {
        const exchange = await converse(caseOf(protocol), 'on', [HIDDEN_ROUND, FINAL_ROUND], stream);
        expect(exchange.upstreamBodies).toHaveLength(2);
        const ids = clientObjects(exchange, stream).map(ID_OF[protocol]).filter(id => id !== undefined);
        expect(ids.length).toBeGreaterThan(0);
        const roundOneId = { 'openai-chat': 'chatcmpl-1', gemini: 'gem-resp-1', anthropic: 'msg_1' }[protocol];
        expect(new Set(ids)).toEqual(new Set([roundOneId]));
      });
    }
  }
});

describe('hidden memory_search: Responses reasoning and storage', () => {
  const responsesCase = caseOf('openai-responses');
  const storedCase: StitchProtocolCase = {
    ...responsesCase,
    requestBody: stream => JSON.stringify({ ...JSON.parse(responsesCase.requestBody(stream)), store: true }),
  };
  // Reasoning whose only following item is the hidden call.
  const THINK_THEN_SEARCH: ScriptedRound = { thinking: 'I should look this up.', calls: [searchCall(1)], usage: USAGE_1 };
  const finalResponseOf = (exchange: Exchange, stream: boolean) => (stream
    ? parseClientSse(exchange.clientText).find(event => event.name === 'response.completed')!.json!.response
    : JSON.parse(exchange.clientText));

  for (const stream of [true, false]) {
    it(`${stream ? 'stream' : 'non-stream'}, store:false: a reasoning item followed only by the hidden call is withheld with it, replayed with it, and without ids`, async () => {
      const exchange = await converse(responsesCase, 'on', [THINK_THEN_SEARCH, FINAL_ROUND], stream);
      expect(exchange.upstreamBodies).toHaveLength(2);
      // The client never sees round 1's reasoning (it would be replayed without its following item).
      expect(exchange.clientText).not.toContain('rs_1');
      expect(exchange.clientText).not.toContain('ZW5j-1');
      // Round 2's reasoning is followed by its message: shown.
      expect(exchange.clientText).toContain('ZW5j-2');
      const view = responsesView(exchange, stream);
      expect(view.text).toBe('Found it.');
      expect(finalResponseOf(exchange, stream).output.map((item: any) => item.type)).toEqual(['reasoning', 'message']);
      // The next round sends the reasoning and its call, as they came but without ids (nothing is stored to refer to).
      const appended = appendedTurns(exchange, 'openai-responses');
      expect(appended).toContain('"encrypted_content":"ZW5j-1"');
      expect(appended).toContain('"call_id":"call_mem_1"');
      expect(appended).not.toContain('"id":');
      // Nothing was stored upstream: the client keeps round 1's id.
      expect(finalResponseOf(exchange, stream).id).toBe('resp_1');
    });

    it(`${stream ? 'stream' : 'non-stream'}, store:true: items are replayed with their ids, and the reply carries the stored last round's id`, async () => {
      const exchange = await converse(storedCase, 'on', [THINK_THEN_SEARCH, FINAL_ROUND], stream);
      expect(exchange.upstreamBodies).toHaveLength(2);
      const appended = appendedTurns(exchange, 'openai-responses');
      expect(appended).toContain('"id":"rs_1"');
      expect(appended).toContain('"id":"fc_call_mem_1"');
      expect(finalResponseOf(exchange, stream).id).toBe('resp_2');
    });

    it(`${stream ? 'stream' : 'non-stream'}: reasoning → hidden call → the agent's call keeps the reasoning, so the agent's call goes out with the reasoning item it needs`, async () => {
      const mixed: ScriptedRound = { thinking: 'Two things to do.', calls: [searchCall(1), readCall], usage: USAGE_1 };
      const exchange = await converse(responsesCase, 'on', [mixed], stream);
      // A mixed round ends with the model's own stop: one upstream call.
      expect(exchange.upstreamBodies).toHaveLength(1);
      expect(exchange.clientText).not.toContain('memory_search');
      expect(exchange.clientText).toContain('ZW5j-1');
      const output = finalResponseOf(exchange, stream).output;
      expect(output.map((item: any) => [item.type, item.id])).toEqual([['reasoning', 'rs_1'], ['function_call', `fc_${readCall.id}`]]);
      if (stream) {
        // The reasoning goes out before the agent's call, at client index 0; the call at 1.
        const added = parseClientSse(exchange.clientText).filter(event => event.name === 'response.output_item.added').map(event => [event.json!.item.type, event.json!.output_index]);
        expect(added).toEqual([['reasoning', 0], ['function_call', 1]]);
      }
    });
  }
});

describe('hidden memory_search: outbound redaction on later rounds', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  for (const protocol of ['anthropic', 'openai-chat']) {
    it(`${protocol}: a secret in a search result never reaches upstream, and the search runs on the real value`, async () => {
      const testCase = caseOf(protocol);
      const requestBody = testCase.requestBody(true).replace('fix the auth bug', `deploy with ${secret}`);
      expect(requestBody).toContain(secret);
      let played = 0;
      const script: FakeUpstreamScript = request => {
        played++;
        if (played > 1) return { kind: 'sse', chunks: testCase.streamRound(FINAL_ROUND, played) };
        // The model asks about the placeholder it was sent.
        const placeholder = textOf(request.body).match(/\{\{API_KEY_[a-z2-7]{8}\}\}/)![0];
        const call = { id: 'call_mem_1', name: 'memory_search', args: { query: `where is ${placeholder} used` } };
        return { kind: 'sse', chunks: testCase.streamRound({ text: 'Let me check.', calls: [call], usage: USAGE_1 }, played) };
      };
      const exchange = await converse(testCase, 'redacted', script, true, requestBody);
      expect(exchange.upstreamBodies).toHaveLength(2);
      // The search ran on what the user wrote, so its result holds the secret...
      expect(searchQueries.map(query => query.query)).toEqual([`where is ${secret} used`]);
      // ...and round 2, which carries that result, was masked as round 1 was.
      for (const body of exchange.upstreamBodies) expect(textOf(body)).not.toContain(secret);
      expect(textOf(exchange.upstreamBodies[1])).toMatch(/memories about where is \{\{API_KEY_[a-z2-7]{8}\}\} used/);
      expect(VIEWS[protocol](exchange, true).text).toBe('Let me check.\n\nFound it.');
    });
  }
});
