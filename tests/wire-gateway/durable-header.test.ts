import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute, setWireGatewayRouteFeature } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger, conversationKeyOf } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { arrayElements, getSpan, rawText, type JsonSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { appendArrayItems } from '../../src/services/wire-gateway/memory/stitch/stitch-events.js';
import { MY_RULES_FILE_MARKER, durableHeaderBlock } from '../../src/services/wire-gateway/header/durable-header-stage.js';
import { fetchDurableHeaderFromWorker, type DurableHeaderAnswer, type DurableHeaderQuery } from '../../src/services/wire-gateway/memory/memory-worker-client.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import { stripMemoryTags } from '../../src/utils/tag-stripping.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { expectDiffersOnlyInsideDeclaredSpans, expectMatchesGoldenFile, type DeclaredSpan } from './golden/golden-harness.js';

// The durable header (Endless Mode v2 plan Phase 3), through the real relay:
// the owner's rules go into the system prompt of a conversation born under
// the gateway, before the memory context, the same bytes on every request
// and after a restart. A changed rule reaches the conversation at the very
// next user-turn start (never mid tool-loop), and on Anthropic the thinking
// signed against the old system prompt is cut on that same request.
// Golden bytes per protocol; only the declared splices differ.

const testRoot = join(WIRE_GATEWAY_DIR, 'durable-header-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

const GOLDEN_INPUTS = join(import.meta.dir, 'golden', 'inputs');
const readBornInput = (protocol: WireProtocol) => new Uint8Array(readFileSync(join(GOLDEN_INPUTS, `${protocol}-born.json`)));

/** The rules the fake worker answers: markdown, HTML-ish, quotes, non-ASCII, emoji — all kept as they are. */
const RULES_A: DurableHeaderAnswer = { text: '# My Rules\n\n## Everywhere\n\n- Keep <b> & "quotes" é 😀', hash: 'a'.repeat(64) };
const RULES_B: DurableHeaderAnswer = { text: '# My Rules\n\n## Everywhere\n\n- A changed rule', hash: 'b'.repeat(64) };

let headerAnswer: DurableHeaderAnswer | Error = RULES_A;
const headerQueries: DurableHeaderQuery[] = [];
async function fakeFetchHeader(query: DurableHeaderQuery): Promise<DurableHeaderAnswer> {
  headerQueries.push(query);
  if (headerAnswer instanceof Error) throw headerAnswer;
  return headerAnswer;
}

const CONTEXT_TEXT = 'the timeline';
let contextAnswer: string | Error = new Error('no context in this test');
async function fakeFetchContext(): Promise<string> {
  if (contextAnswer instanceof Error) throw contextAnswer;
  return contextAnswer;
}

interface ProtocolCase {
  protocol: WireProtocol;
  routeId: string;
  agentId: string;
  path: string;
  /** The array a later request appends its turns to. */
  turnsKey: string;
  /** A tool call and its result: a request within the turn (mid tool-loop). */
  toolLoop(n: number): string[];
  /** The model's reply and the user's next words: a request that starts a turn. */
  nextTurn(n: number): string[];
  /** Where the system prompt sits (compared byte for byte across requests). */
  systemPath: Array<string | number>;
  /** Where the block goes in the agent's first body: an insertion point. */
  insertionPoint(body: Uint8Array): number;
}

const spanAt = (body: Uint8Array, path: Array<string | number>): JsonSpan => {
  const span = getSpan(body, path);
  if (!span) throw new Error(`no ${path.join('.')}`);
  return span;
};
const lastElementEnd = (body: Uint8Array, path: Array<string | number>) => {
  const elements = [...arrayElements(body, spanAt(body, path))];
  return elements[elements.length - 1].end;
};

const protocolCases: ProtocolCase[] = [
  {
    protocol: 'anthropic', routeId: 'header-anthropic', agentId: 'claude-code', path: '/v1/messages', turnsKey: 'messages',
    toolLoop: n => [
      `{"role":"assistant","content":[{"type":"thinking","thinking":"look ${n}","signature":"c2ln${n}"},{"type":"tool_use","id":"toolu_${n}","name":"Read","input":{"path":"a"}}]}`,
      `{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_${n}","content":"file ${n}"}]}`,
    ],
    nextTurn: n => [
      `{"role":"assistant","content":[{"type":"thinking","thinking":"ok ${n}","signature":"c2ln"},{"type":"text","text":"done ${n}"}]}`,
      `{"role":"user","content":"and now ${n}?"}`,
    ],
    systemPath: ['system'],
    insertionPoint: body => lastElementEnd(body, ['system']),
  },
  {
    protocol: 'openai-chat', routeId: 'header-chat', agentId: 'opencode', path: '/v1/chat/completions', turnsKey: 'messages',
    toolLoop: n => [
      `{"role":"assistant","content":null,"tool_calls":[{"id":"call_${n}","type":"function","function":{"name":"Read","arguments":"{}"}}]}`,
      `{"role":"tool","tool_call_id":"call_${n}","content":"file ${n}"}`,
    ],
    nextTurn: n => [`{"role":"assistant","content":"done ${n}"}`, `{"role":"user","content":"and now ${n}?"}`],
    systemPath: ['messages', 0],
    insertionPoint: body => spanAt(body, ['messages', 0, 'content']).end - 1,
  },
  {
    protocol: 'openai-responses', routeId: 'header-responses', agentId: 'codex', path: '/v1/responses', turnsKey: 'input',
    toolLoop: n => [
      `{"type":"function_call","call_id":"call_${n}","name":"Read","arguments":"{}"}`,
      `{"type":"function_call_output","call_id":"call_${n}","output":"file ${n}"}`,
    ],
    nextTurn: n => [
      `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done ${n}"}]}`,
      `{"type":"message","role":"user","content":[{"type":"input_text","text":"and now ${n}?"}]}`,
    ],
    systemPath: ['instructions'],
    insertionPoint: body => spanAt(body, ['instructions']).end - 1,
  },
  {
    protocol: 'gemini', routeId: 'header-gemini', agentId: 'gemini-cli', path: '/v1beta/models/gemini-x:streamGenerateContent?alt=sse', turnsKey: 'contents',
    toolLoop: () => [
      '{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{}}}]}',
      '{"role":"user","parts":[{"functionResponse":{"name":"read_file","response":{"output":"file"}}}]}',
    ],
    nextTurn: n => [`{"role":"model","parts":[{"text":"done ${n}"}]}`, `{"role":"user","parts":[{"text":"and now ${n}?"}]}`],
    systemPath: ['systemInstruction'],
    insertionPoint: body => lastElementEnd(body, ['systemInstruction', 'parts']),
  },
];

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

async function startGateway(): Promise<StartedWireGateway> {
  return startWireGatewayForTest({
    routesFilePath,
    conversationLedger: new WireConversationLedger({ directory: ledgerDirectory }),
    rewriteSettings: { CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER: 'true' },
    memory: { header: { fetchHeader: fakeFetchHeader }, injection: { fetchContext: fakeFetchContext } },
  });
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
  for (const testCase of protocolCases) {
    addWireGatewayRoute({ routeId: testCase.routeId, agentId: testCase.agentId, upstreamBaseUrl: upstream.url, captureSource: 'wire' }, routesFilePath);
  }
  addWireGatewayRoute({ routeId: 'header-switch', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'wire' }, routesFilePath);
  gateway = await startGateway();
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

let sessionCounter = 0;
const nextSession = (tag: string) => `header-${tag}-${++sessionCounter}`;

/** Sends `body` on the route and returns what the vendor got. */
async function send(routeId: string, path: string, body: Uint8Array, session: string): Promise<Uint8Array> {
  const before = upstream.requests.length;
  const response = await fetch(`${gateway.baseUrl}/r/${routeId}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'x-claude-mem-session': session },
    body,
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(upstream.requests.length).toBe(before + 1);
  return upstream.requests[upstream.requests.length - 1].body;
}

const withTurns = (testCase: ProtocolCase, body: Uint8Array, items: string[]) => appendArrayItems(body, spanAt(body, [testCase.turnsKey]), items);
const escapedInJson = (text: string) => JSON.stringify(text).slice(1, -1);
const countOf = (text: string, needle: string) => text.split(needle).length - 1;
const systemText = (testCase: ProtocolCase, body: Uint8Array) => rawText(body, spanAt(body, testCase.systemPath));

/** The ledger lines of a conversation, as written. */
function ledgerEntriesOf(agentId: string, session: string): Array<Record<string, unknown>> {
  const filePath = join(ledgerDirectory, `${conversationKeyOf({ agentId, sessionId: session })}.jsonl`);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>);
}

/** Each Anthropic assistant thinking block before `untilMessageIndex`, as a span that takes its trailing comma too (what a drop removes). */
function thinkingSpansBefore(body: Uint8Array, untilMessageIndex: number): DeclaredSpan[] {
  const spans: DeclaredSpan[] = [];
  const messages = [...arrayElements(body, spanAt(body, ['messages']))];
  messages.slice(0, untilMessageIndex).forEach((_, messageIndex) => {
    const contentSpan = getSpan(body, ['messages', messageIndex, 'content']);
    if (contentSpan?.type !== 'array') return;
    const blocks = [...arrayElements(body, contentSpan)];
    blocks.forEach((block, blockIndex) => {
      if (!rawText(body, block).startsWith('{"type":"thinking"')) return;
      spans.push({ start: block.start, end: blockIndex + 1 < blocks.length ? blocks[blockIndex + 1].start : block.end });
    });
  });
  return spans;
}

describe('durable header: golden bytes per protocol, frozen, changed only at a turn start', () => {
  for (const testCase of protocolCases) {
    it(`${testCase.protocol}: first request fetches; mid-loop requests never ask; a changed rule lands at the very next turn start`, async () => {
      headerAnswer = RULES_A;
      headerQueries.length = 0;
      const session = nextSession(testCase.protocol);
      const first = readBornInput(testCase.protocol);
      const insertAt = testCase.insertionPoint(first);
      const atInsertion: DeclaredSpan[] = [{ start: insertAt, end: insertAt }];

      // First request: the rules, appended at the end of the system prompt.
      const sentFirst = await send(testCase.routeId, testCase.path, first, session);
      expectMatchesGoldenFile(`durable-header-${testCase.protocol}`, sentFirst);
      expectDiffersOnlyInsideDeclaredSpans(first, sentFirst, atInsertion);
      expect(textOf(sentFirst)).toContain(escapedInJson(durableHeaderBlock(RULES_A.text as string)));
      expect(headerQueries).toEqual([{ workDir: '/work/app', timeoutMs: 1500 }]);

      // The rules change; a mid-loop request neither asks nor changes.
      headerAnswer = RULES_B;
      const loop1 = withTurns(testCase, first, testCase.toolLoop(1));
      const sentLoop1 = await send(testCase.routeId, testCase.path, loop1, session);
      expect(systemText(testCase, sentLoop1)).toBe(systemText(testCase, sentFirst));
      expectDiffersOnlyInsideDeclaredSpans(loop1, sentLoop1, atInsertion);
      expect(headerQueries).toHaveLength(1);

      // The very next turn start asks, within the same budget, and takes the new rules up.
      const turn2 = withTurns(testCase, loop1, testCase.nextTurn(2));
      const sentTurn2 = await send(testCase.routeId, testCase.path, turn2, session);
      expect(headerQueries).toEqual([{ workDir: '/work/app', timeoutMs: 1500 }, { workDir: '/work/app', timeoutMs: 1500 }]);
      expect(textOf(sentTurn2)).toContain(escapedInJson(durableHeaderBlock(RULES_B.text as string)));
      expect(textOf(sentTurn2)).not.toContain(escapedInJson(RULES_A.text as string));
      const turnStartIndex = [...arrayElements(turn2, spanAt(turn2, [testCase.turnsKey]))].length - 1;
      const cut = testCase.protocol === 'anthropic' ? thinkingSpansBefore(turn2, turnStartIndex) : [];
      expect(cut.length).toBe(testCase.protocol === 'anthropic' ? 2 : 0);
      expectMatchesGoldenFile(`durable-header-${testCase.protocol}-changed`, sentTurn2);
      expectDiffersOnlyInsideDeclaredSpans(turn2, sentTurn2, [...atInsertion, ...cut]);

      // Mid-loop after it: the new header and the cut, byte for byte; the new turn keeps its thinking.
      const loop2 = withTurns(testCase, turn2, testCase.toolLoop(3));
      const sentLoop2 = await send(testCase.routeId, testCase.path, loop2, session);
      expect(systemText(testCase, sentLoop2)).toBe(systemText(testCase, sentTurn2));
      expectDiffersOnlyInsideDeclaredSpans(loop2, sentLoop2, [...atInsertion, ...cut]);
      if (testCase.protocol === 'anthropic') expect(textOf(sentLoop2)).toContain('"thinking":"look 3"');
      expect(headerQueries).toHaveLength(2);

      // The next turn start asks again; unchanged rules change nothing.
      const turn3 = withTurns(testCase, loop2, testCase.nextTurn(4));
      const sentTurn3 = await send(testCase.routeId, testCase.path, turn3, session);
      expect(systemText(testCase, sentTurn3)).toBe(systemText(testCase, sentTurn2));
      expect(headerQueries).toHaveLength(3);

      const entries = ledgerEntriesOf(testCase.agentId, session);
      expect(entries.filter(entry => entry.type === 'header').map(entry => [entry.hash, entry.sequence, entry.turnOrdinal]))
        .toEqual([[RULES_A.hash, 0, 1], [RULES_B.hash, 1, 2]]);
      const cutEntries = entries.filter(entry => entry.type === 'thinkingCut');
      expect(cutEntries).toEqual(testCase.protocol === 'anthropic' ? [{ type: 'thinkingCut', untilTurnOrdinal: 2 }] : []);
      if (testCase.protocol === 'anthropic') {
        // Written before the header that needs it: held writes commit in order, with no rollback.
        const cutAt = entries.findIndex(entry => entry.type === 'thinkingCut');
        const headerAt = entries.findIndex(entry => entry.type === 'header' && entry.sequence === 1);
        expect(cutAt).toBeGreaterThan(-1);
        expect(cutAt).toBeLessThan(headerAt);
      }

      // After a restart the ledger puts back the very same bytes.
      await gateway.stop();
      gateway = await startGateway();
      const sentAfterRestart = await send(testCase.routeId, testCase.path, loop2, session);
      expect(textOf(sentAfterRestart)).toBe(textOf(sentLoop2));
    });
  }

  it('anthropic: the rules go before the memory context, each its own system block with no new breakpoint', async () => {
    headerAnswer = RULES_A;
    contextAnswer = CONTEXT_TEXT;
    try {
      const first = readBornInput('anthropic');
      const sent = await send('header-anthropic', '/v1/messages', first, nextSession('order'));
      const blocks = [...arrayElements(sent, spanAt(sent, ['system']))].map(block => rawText(sent, block));
      expect(blocks).toHaveLength(4);
      expect(blocks[2]).toStartWith('{"type":"text","text":"<claude-mem-rules>');
      expect(blocks[3]).toStartWith('{"type":"text","text":"<claude-mem-context>');
      expect(countOf(textOf(sent), '"cache_control"')).toBe(countOf(textOf(first), '"cache_control"'));
    } finally {
      contextAnswer = new Error('no context in this test');
    }
  });

  it('anthropic: an assistant message that is only thinking is removed whole by the cut', async () => {
    headerAnswer = RULES_A;
    const testCase = protocolCases[0];
    const session = nextSession('thinking-only');
    const first = readBornInput('anthropic');
    await send(testCase.routeId, testCase.path, first, session);
    headerAnswer = RULES_B;
    const thinkingOnly = '{"role":"assistant","content":[{"type":"thinking","thinking":"only","signature":"c2ln"}]}';
    const turn2 = withTurns(testCase, first, [thinkingOnly, '{"role":"user","content":"go on"}']);
    const sentTurn2 = await send(testCase.routeId, testCase.path, turn2, session);
    expect(textOf(sentTurn2)).toContain(escapedInJson(durableHeaderBlock(RULES_B.text as string)));
    expect(textOf(sentTurn2)).not.toContain('"thinking"');
    expect([...arrayElements(sentTurn2, spanAt(sentTurn2, ['messages']))]).toHaveLength(2);
    const insertAt = testCase.insertionPoint(first);
    const firstMessageEnd = spanAt(turn2, ['messages', 0]).end;
    const goOnStart = spanAt(turn2, ['messages', 2]).start;
    expectDiffersOnlyInsideDeclaredSpans(turn2, sentTurn2, [{ start: insertAt, end: insertAt }, { start: firstMessageEnd, end: goOnStart }]);
  });

  it('anthropic: a history the agent shortened keeps the in-flight loop\'s thinking', async () => {
    headerAnswer = RULES_A;
    const testCase = protocolCases[0];
    const session = nextSession('rewind');
    const first = readBornInput('anthropic');
    await send(testCase.routeId, testCase.path, first, session);
    headerAnswer = RULES_B;
    const turn2 = withTurns(testCase, first, [...testCase.toolLoop(1), ...testCase.nextTurn(2)]);
    await send(testCase.routeId, testCase.path, turn2, session);
    expect(ledgerEntriesOf(testCase.agentId, session).filter(entry => entry.type === 'thinkingCut')).toEqual([{ type: 'thinkingCut', untilTurnOrdinal: 2 }]);

    // Rewound to the first turn, mid-loop: the cut reaches no message of the in-flight loop.
    const rewound = withTurns(testCase, first, testCase.toolLoop(9));
    const sentRewound = await send(testCase.routeId, testCase.path, rewound, session);
    expect(textOf(sentRewound)).toContain('"thinking":"look 9"');
    expect(textOf(sentRewound)).toContain(escapedInJson(durableHeaderBlock(RULES_B.text as string)));
    const insertAt = testCase.insertionPoint(first);
    expectDiffersOnlyInsideDeclaredSpans(rewound, sentRewound, [{ start: insertAt, end: insertAt }]);
  });

  it('openai-chat with no system message: a header that goes from none to rules mid-conversation puts one first', async () => {
    const testCase = protocolCases[1];
    headerAnswer = { text: null, hash: 'n'.repeat(64) };
    const session = nextSession('chat-null');
    const first = encoder.encode('{"model":"gpt-x","messages":[{"role":"user","content":"<cwd>/work/chat</cwd> hi"}]}');
    expect(textOf(await send(testCase.routeId, testCase.path, first, session))).toBe(textOf(first));

    headerAnswer = RULES_A;
    const turn2 = withTurns(testCase, first, testCase.nextTurn(2));
    const sentTurn2 = await send(testCase.routeId, testCase.path, turn2, session);
    expect(textOf(sentTurn2)).toStartWith(`{"model":"gpt-x","messages":[{"role":"system","content":${JSON.stringify(durableHeaderBlock(RULES_A.text as string))}},`);
    const firstMessageStart = spanAt(turn2, ['messages', 0]).start;
    expectDiffersOnlyInsideDeclaredSpans(turn2, sentTurn2, [{ start: firstMessageStart, end: firstMessageStart }]);

    // The inserted message shifts every index; turn ordinals hold, so later requests are the same bytes plus their own.
    const loop = withTurns(testCase, turn2, testCase.toolLoop(3));
    const sentLoop = await send(testCase.routeId, testCase.path, loop, session);
    expectDiffersOnlyInsideDeclaredSpans(loop, sentLoop, [{ start: firstMessageStart, end: firstMessageStart }]);
    const turn3 = withTurns(testCase, loop, testCase.nextTurn(4));
    const sentTurn3 = await send(testCase.routeId, testCase.path, turn3, session);
    expectDiffersOnlyInsideDeclaredSpans(turn3, sentTurn3, [{ start: firstMessageStart, end: firstMessageStart }]);
    expect(ledgerEntriesOf(testCase.agentId, session).filter(entry => entry.type === 'header').map(entry => [entry.text === null, entry.sequence, entry.turnOrdinal]))
      .toEqual([[true, 0, 1], [false, 1, 2]]);
  });
});

describe('durable header: when it adds nothing', () => {
  it('a request that already holds the My Rules file gets no header, and its rules are never fetched', async () => {
    headerAnswer = RULES_A;
    headerQueries.length = 0;
    const body = encoder.encode(`{"model":"claude-x","max_tokens":32000,"system":"be careful","messages":[{"role":"user","content":"<cwd>/work/app</cwd> # My Rules\\n\\nHow I want agents to work. ${MY_RULES_FILE_MARKER} in My Rules. hi"}]}`);
    const session = nextSession('my-rules');
    expect(textOf(await send('header-anthropic', '/v1/messages', body, session))).toBe(textOf(body));
    const turn2 = withTurns(protocolCases[0], body, protocolCases[0].nextTurn(2));
    expect(textOf(await send('header-anthropic', '/v1/messages', turn2, session))).toBe(textOf(turn2));
    expect(headerQueries).toHaveLength(0);
  });

  it('the worker down on the first request: the request goes as it came; the next turn start takes the rules up', async () => {
    headerAnswer = new Error('connect ECONNREFUSED');
    const testCase = protocolCases[2];
    const session = nextSession('down');
    const first = encoder.encode(textOf(readBornInput(testCase.protocol)).replace('<cwd>/work/app</cwd>', '<cwd>/work/down</cwd>'));
    expect(textOf(await send(testCase.routeId, testCase.path, first, session))).toBe(textOf(first));
    headerAnswer = RULES_A;
    const turn2 = withTurns(testCase, first, testCase.nextTurn(2));
    const sentTurn2 = await send(testCase.routeId, testCase.path, turn2, session);
    expect(textOf(sentTurn2)).toContain(escapedInJson(durableHeaderBlock(RULES_A.text as string)));
    const insertAt = testCase.insertionPoint(first);
    expectDiffersOnlyInsideDeclaredSpans(turn2, sentTurn2, [{ start: insertAt, end: insertAt }]);
  });

  it('turned off for one request after adding rules: suspended for good', async () => {
    headerAnswer = RULES_A;
    const testCase = protocolCases[0];
    const session = nextSession('switch');
    const first = readBornInput('anthropic');
    expect(textOf(await send('header-switch', testCase.path, first, session))).toContain('<claude-mem-rules>');

    setWireGatewayRouteFeature('header-switch', 'durableHeader', false, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const turn2 = withTurns(testCase, first, testCase.nextTurn(2));
    expect(textOf(await send('header-switch', testCase.path, turn2, session))).toBe(textOf(turn2));

    setWireGatewayRouteFeature('header-switch', 'durableHeader', true, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const turn3 = withTurns(testCase, turn2, testCase.nextTurn(3));
    expect(textOf(await send('header-switch', testCase.path, turn3, session))).toBe(textOf(turn3));
    expect(ledgerEntriesOf(testCase.agentId, session).some(entry => entry.type === 'suspended' && entry.stage === 'durable-header')).toBe(true);
  }, 15_000);

  it('capture strips the <claude-mem-rules> block', () => {
    expect(stripMemoryTags(`before ${durableHeaderBlock('a rule')} after`)).toBe('before  after');
  });
});

describe('durable header: the worker client', () => {
  it('asks GET /api/wire/header with the folder over a direct socket, and reads text and hash', async () => {
    const seen: string[] = [];
    let answer: unknown = { text: '  rules \n', hash: 'c'.repeat(64) };
    const worker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname + new URL(request.url).search);
        return Response.json(answer);
      },
    });
    const urlOf = (apiPath: string) => `http://127.0.0.1:${worker.port}${apiPath}`;
    try {
      expect(await fetchDurableHeaderFromWorker({ workDir: '/work/a b', timeoutMs: 1_000 }, urlOf)).toEqual({ text: 'rules', hash: 'c'.repeat(64) });
      expect(seen).toEqual(['/api/wire/header?cwd=%2Fwork%2Fa+b']);
      answer = { text: null, hash: 'd'.repeat(64) };
      expect(await fetchDurableHeaderFromWorker({ workDir: '/w', timeoutMs: 1_000 }, urlOf)).toEqual({ text: null, hash: 'd'.repeat(64) });
      answer = { text: 'no hash' };
      let malformed: unknown = null;
      try {
        await fetchDurableHeaderFromWorker({ workDir: '/w', timeoutMs: 1_000 }, urlOf);
      } catch (error) {
        malformed = error;
      }
      expect(String(malformed)).toContain('not a header');
    } finally {
      worker.stop(true);
    }
  });

  it('throws when the worker refuses or does not answer', async () => {
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope', { status: 403 }) });
    const urlOf = (apiPath: string) => `http://127.0.0.1:${worker.port}${apiPath}`;
    let refused: unknown = null;
    try {
      await fetchDurableHeaderFromWorker({ workDir: '/w', timeoutMs: 1_000 }, urlOf);
    } catch (error) {
      refused = error;
    } finally {
      worker.stop(true);
    }
    expect(String(refused)).toContain('403');
    let unreachable: unknown = null;
    try {
      await fetchDurableHeaderFromWorker({ workDir: '/w', timeoutMs: 300 }, urlOf);
    } catch (error) {
      unreachable = error;
    }
    expect(String(unreachable)).toContain('did not answer');
  });
});
