import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute, setWireGatewayRouteFeature } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { arrayElements, getSpan, rawText, type JsonSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { appendArrayItems } from '../../src/services/wire-gateway/memory/stitch/stitch-events.js';
import { fetchMemoryContextFromWorker, type MemoryContextQuery } from '../../src/services/wire-gateway/memory/memory-worker-client.js';
import { memoryContextBlock } from '../../src/services/wire-gateway/memory/memory-injection-stage.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { expectDiffersOnlyInsideDeclaredSpans, expectMatchesGoldenFile, type DeclaredSpan } from './golden/golden-harness.js';

// Memory injection at the wire (plan Phase 12 task 1), through the real
// relay: claude-mem's context goes once into a conversation born under the
// gateway, at the end of its system prompt, and every later request — and a
// restarted gateway — puts back the same bytes. Golden bytes per protocol;
// only the appended span differs from what the agent sent.

const testRoot = join(WIRE_GATEWAY_DIR, 'memory-injection-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

const GOLDEN_INPUTS = join(import.meta.dir, 'golden', 'inputs');
const readBornInput = (protocol: WireProtocol) => new Uint8Array(readFileSync(join(GOLDEN_INPUTS, `${protocol}-born.json`)));

/** The context the fake worker answers: HTML-ish, quotes, non-ASCII, emoji — all kept as they are. */
const CONTEXT_TEXT = '# claude-mem\n- #12 fixed the <auth> bug & "retry" é 😀';

let contextAnswer: string | Error = CONTEXT_TEXT;
const contextQueries: MemoryContextQuery[] = [];
async function fakeFetchContext(query: MemoryContextQuery): Promise<string> {
  contextQueries.push(query);
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
  /** A reply and the user's next words, as items of that array. */
  laterTurns: string[];
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
    protocol: 'anthropic', routeId: 'inject-anthropic', agentId: 'claude-code', path: '/v1/messages', turnsKey: 'messages',
    laterTurns: [
      '{"role":"assistant","content":[{"type":"thinking","thinking":"ok","signature":"c2ln"},{"type":"text","text":"done"}]}',
      '{"role":"user","content":"and now?"}',
    ],
    systemPath: ['system'],
    insertionPoint: body => lastElementEnd(body, ['system']),
  },
  {
    protocol: 'openai-chat', routeId: 'inject-chat', agentId: 'opencode', path: '/v1/chat/completions', turnsKey: 'messages',
    laterTurns: ['{"role":"assistant","content":"done"}', '{"role":"user","content":"and now?"}'],
    systemPath: ['messages', 0],
    insertionPoint: body => spanAt(body, ['messages', 0, 'content']).end - 1,
  },
  {
    protocol: 'openai-responses', routeId: 'inject-responses', agentId: 'codex', path: '/v1/responses', turnsKey: 'input',
    laterTurns: [
      '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}',
      '{"type":"message","role":"user","content":[{"type":"input_text","text":"and now?"}]}',
    ],
    systemPath: ['instructions'],
    insertionPoint: body => spanAt(body, ['instructions']).end - 1,
  },
  {
    protocol: 'gemini', routeId: 'inject-gemini', agentId: 'gemini-cli', path: '/v1beta/models/gemini-x:streamGenerateContent?alt=sse', turnsKey: 'contents',
    laterTurns: ['{"role":"model","parts":[{"text":"done"}]}', '{"role":"user","parts":[{"text":"and now?"}]}'],
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
    rewriteSettings: { CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: 'true' },
    memory: { injection: { fetchContext: fakeFetchContext } },
  });
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
  for (const testCase of protocolCases) {
    addWireGatewayRoute({ routeId: testCase.routeId, agentId: testCase.agentId, upstreamBaseUrl: upstream.url, captureSource: 'wire' }, routesFilePath);
  }
  addWireGatewayRoute({ routeId: 'inject-native', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  gateway = await startGateway();
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

let sessionCounter = 0;
const nextSession = (tag: string) => `inject-${tag}-${++sessionCounter}`;

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

function withLaterTurns(testCase: ProtocolCase, body: Uint8Array): Uint8Array {
  return appendArrayItems(body, spanAt(body, [testCase.turnsKey]), testCase.laterTurns);
}

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

describe('memory injection: golden bytes per protocol, frozen across requests and a restart', () => {
  for (const testCase of protocolCases) {
    it(`${testCase.protocol}: appended at the end of the system prompt, the same on every request`, async () => {
      contextAnswer = CONTEXT_TEXT;
      contextQueries.length = 0;
      const session = nextSession(testCase.protocol);
      const first = readBornInput(testCase.protocol);
      const sentFirst = await send(testCase.routeId, testCase.path, first, session);

      expectMatchesGoldenFile(`memory-injection-${testCase.protocol}`, sentFirst);
      const insertAt = testCase.insertionPoint(first);
      const declared: DeclaredSpan[] = [{ start: insertAt, end: insertAt }];
      expectDiffersOnlyInsideDeclaredSpans(first, sentFirst, declared);
      expect(textOf(sentFirst)).toContain(textOf(encoder.encode(JSON.stringify(memoryContextBlock(CONTEXT_TEXT)).slice(1, -1))));
      expect(contextQueries).toEqual([{ workDir: '/work/app', platformSource: testCase.agentId, timeoutMs: 1500 }]);

      // A later request of the conversation: same system bytes, no new fetch.
      contextAnswer = 'something else entirely';
      const later = withLaterTurns(testCase, first);
      const sentLater = await send(testCase.routeId, testCase.path, later, session);
      expect(rawText(sentLater, spanAt(sentLater, testCase.systemPath))).toBe(rawText(sentFirst, spanAt(sentFirst, testCase.systemPath)));
      expectDiffersOnlyInsideDeclaredSpans(later, sentLater, [{ start: insertAt, end: insertAt }]);
      expect(contextQueries).toHaveLength(1);

      // After a restart the ledger puts back the very same bytes.
      await gateway.stop();
      gateway = await startGateway();
      const sentAfterRestart = await send(testCase.routeId, testCase.path, later, session);
      expect(textOf(sentAfterRestart)).toBe(textOf(sentLater));
      expect(contextQueries).toHaveLength(1);
    });
  }

  it('anthropic: the attribution block stays first and byte-identical; the timeline block gets the head\'s one breakpoint (≤4)', async () => {
    contextAnswer = CONTEXT_TEXT;
    const first = readBornInput('anthropic');
    const sent = await send('inject-anthropic', '/v1/messages', first, nextSession('attribution'));
    expect(rawText(sent, spanAt(sent, ['system', 0]))).toBe(rawText(first, spanAt(first, ['system', 0])));
    expect(rawText(sent, spanAt(sent, ['system', 0, 'text']))).toStartWith('"x-anthropic-billing-header:');
    // The input uses 3 breakpoints, all 5-minute: the head's own makes 4, the most Anthropic allows, also 5-minute.
    const breakpoints = countOf(textOf(sent), '"cache_control"');
    expect(breakpoints).toBe(countOf(textOf(first), '"cache_control"') + 1);
    expect(breakpoints).toBeLessThanOrEqual(4);
    const systemBlocks = [...arrayElements(sent, spanAt(sent, ['system']))];
    const appended = rawText(sent, systemBlocks[systemBlocks.length - 1]);
    expect(appended).toStartWith('{"type":"text","text":"<claude-mem-context>');
    expect(appended).toEndWith(',"cache_control":{"type":"ephemeral"}}');
  });

  it('anthropic: a string system prompt is appended to before its closing quote, its own escapes kept', async () => {
    contextAnswer = CONTEXT_TEXT;
    const body = encoder.encode('{"model":"claude-x","max_tokens":32000,"system":"be \\u00e9 \\/ careful","messages":[{"role":"user","content":"<cwd>/work/app</cwd> hi"}]}');
    const sent = await send('inject-anthropic', '/v1/messages', body, nextSession('string-system'));
    const closingQuote = spanAt(body, ['system']).end - 1;
    expectDiffersOnlyInsideDeclaredSpans(body, sent, [{ start: closingQuote, end: closingQuote }]);
    expect(textOf(sent)).toContain('"system":"be \\u00e9 \\/ careful\\n\\n<claude-mem-context>\\n# claude-mem');
  });

  it('openai-chat: with no system message, one is put first', async () => {
    contextAnswer = CONTEXT_TEXT;
    const body = encoder.encode('{"model":"gpt-x","messages":[{"role":"user","content":"<cwd>/work/app</cwd> hi"}]}');
    const sent = await send('inject-chat', '/v1/chat/completions', body, nextSession('chat-no-system'));
    const firstMessageStart = spanAt(body, ['messages', 0]).start;
    expectDiffersOnlyInsideDeclaredSpans(body, sent, [{ start: firstMessageStart, end: firstMessageStart }]);
    expect(textOf(sent)).toStartWith('{"model":"gpt-x","messages":[{"role":"system","content":"<claude-mem-context>');
  });
});

describe('memory injection: when it does not happen', () => {
  it('a conversation not born under the gateway is never injected (and its context is never fetched)', async () => {
    contextAnswer = CONTEXT_TEXT;
    contextQueries.length = 0;
    const testCase = protocolCases[0];
    const midway = withLaterTurns(testCase, readBornInput('anthropic'));
    const sent = await send(testCase.routeId, testCase.path, midway, nextSession('not-born'));
    expect(textOf(sent)).toBe(textOf(midway));
    expect(contextQueries).toHaveLength(0);
  });

  it('the worker down: the request goes as it came, and the conversation stays without memory', async () => {
    contextAnswer = new Error('connect ECONNREFUSED');
    contextQueries.length = 0;
    for (const testCase of protocolCases) {
      const session = nextSession(`down-${testCase.protocol}`);
      const first = readBornInput(testCase.protocol);
      expect(textOf(await send(testCase.routeId, testCase.path, first, session))).toBe(textOf(first));
      contextAnswer = CONTEXT_TEXT;
      const later = withLaterTurns(testCase, first);
      expect(textOf(await send(testCase.routeId, testCase.path, later, session))).toBe(textOf(later));
      contextAnswer = new Error('connect ECONNREFUSED');
    }
    expect(contextQueries).toHaveLength(protocolCases.length);
  });

  it('a system prompt that already holds <claude-mem-context> is left alone', async () => {
    contextAnswer = CONTEXT_TEXT;
    const body = encoder.encode('{"model":"claude-x","max_tokens":32000,"system":"<claude-mem-context>native</claude-mem-context>","messages":[{"role":"user","content":"<cwd>/work/app</cwd> hi"}]}');
    expect(textOf(await send('inject-anthropic', '/v1/messages', body, nextSession('marker')))).toBe(textOf(body));
  });

  it('an unknown folder: nothing to ask the worker for, nothing injected', async () => {
    contextQueries.length = 0;
    const body = encoder.encode('{"model":"claude-x","max_tokens":32000,"messages":[{"role":"user","content":"hi"}]}');
    expect(textOf(await send('inject-anthropic', '/v1/messages', body, nextSession('no-folder')))).toBe(textOf(body));
    expect(contextQueries).toHaveLength(0);
  });

  it('a native route gets it only when its route asks; the per-route kill switch suspends a conversation for good', async () => {
    contextAnswer = CONTEXT_TEXT;
    const first = readBornInput('anthropic');
    expect(textOf(await send('inject-native', '/v1/messages', first, nextSession('native-default')))).toBe(textOf(first));

    setWireGatewayRouteFeature('inject-native', 'memoryInjection', true, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const session = nextSession('native-on');
    const injected = await send('inject-native', '/v1/messages', first, session);
    expect(textOf(injected)).toContain('<claude-mem-context>');

    // Off for one request: that request goes without it ...
    setWireGatewayRouteFeature('inject-native', 'memoryInjection', false, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const later = withLaterTurns(protocolCases[0], first);
    expect(textOf(await send('inject-native', '/v1/messages', later, session))).toBe(textOf(later));
    // ... and turned back on, the conversation is not injected again (its system prompt would change mid-way).
    setWireGatewayRouteFeature('inject-native', 'memoryInjection', true, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(textOf(await send('inject-native', '/v1/messages', later, session))).toBe(textOf(later));
  }, 15_000);
});

describe('memory injection: the worker client', () => {
  it('asks GET /api/context/inject with the folder and agent, over a direct socket', async () => {
    const seen: string[] = [];
    const worker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname + new URL(request.url).search);
        return new Response('  remembered things \n', { headers: { 'content-type': 'text/plain' } });
      },
    });
    try {
      const text = await fetchMemoryContextFromWorker(
        { workDir: '/work/a b', platformSource: 'codex', timeoutMs: 1_000 },
        apiPath => `http://127.0.0.1:${worker.port}${apiPath}`,
      );
      expect(text).toBe('remembered things');
      expect(seen).toEqual(['/api/context/inject?cwd=%2Fwork%2Fa+b&platformSource=codex']);
    } finally {
      worker.stop(true);
    }
  });

  it('throws when the worker refuses or does not answer', async () => {
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope', { status: 503 }) });
    const urlOf = (apiPath: string) => `http://127.0.0.1:${worker.port}${apiPath}`;
    let refused: unknown = null;
    try {
      await fetchMemoryContextFromWorker({ workDir: '/w', platformSource: 'codex', timeoutMs: 1_000 }, urlOf);
    } catch (error) {
      refused = error;
    } finally {
      worker.stop(true);
    }
    expect(String(refused)).toContain('503');
    let unreachable: unknown = null;
    try {
      await fetchMemoryContextFromWorker({ workDir: '/w', platformSource: 'codex', timeoutMs: 300 }, urlOf);
    } catch (error) {
      unreachable = error;
    }
    expect(String(unreachable)).toContain('did not answer');
  });
});
