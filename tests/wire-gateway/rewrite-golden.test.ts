import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { arrayElements, decodeString, getSpan, type JsonSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { appendArrayItem, encodeJsonString, removeArrayItems, replaceSpan } from '../../src/services/wire-gateway/json/splice.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import type { WireRewriteStage } from '../../src/services/wire-gateway/rewrite/rewrite-stage.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import {
  expectDiffersOnlyInsideDeclaredSpans,
  expectMatchesGoldenFile,
  readGoldenInput,
  type DeclaredSpan,
} from './golden/golden-harness.js';

// Phase 10 task 3 through the real relay: what the vendor gets from a
// rewrite stage is saved golden bytes, differs from the agent's body only in
// the declared spans, comes out the same on every request, and an unchanged
// body (no edit, a failing stage, a broken tool pair) goes byte for byte.

const testRoot = join(WIRE_GATEWAY_DIR, 'rewrite-golden-test');
const routesFilePath = join(testRoot, 'routes.json');

const SUFFIX_BY_PROTOCOL: Record<WireProtocol, string> = {
  anthropic: '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  gemini: '/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
};

const INJECTED_CONTEXT = '<claude-mem-context>remembered é & <b>"quoted"</b> 😀</claude-mem-context>';

interface GoldenEdit {
  edited: Uint8Array;
  declared: DeclaredSpan[];
}

interface GoldenCase {
  name: string;
  protocol: WireProtocol;
  edit(body: Uint8Array): GoldenEdit;
}

const spanAt = (body: Uint8Array, ...path: Array<string | number>): JsonSpan => {
  const span = getSpan(body, path);
  if (!span) throw new Error(`no ${path.join('.')} in the golden input`);
  return span;
};

/** An insertion after an array's last element. */
function appendTo(body: Uint8Array, arraySpan: JsonSpan, itemJson: string): GoldenEdit {
  const elements = [...arrayElements(body, arraySpan)];
  const insertAt = elements[elements.length - 1].end;
  return { edited: appendArrayItem(body, arraySpan, itemJson), declared: [{ start: insertAt, end: insertAt }] };
}

function replaceAt(body: Uint8Array, span: JsonSpan, replacementJson: string): GoldenEdit {
  return { edited: replaceSpan(body, span, replacementJson), declared: [span] };
}

/** Appended once: a text that already ends with it is left alone (as Phase 12 skips a present marker). */
function appendToString(body: Uint8Array, span: JsonSpan, suffix: string): GoldenEdit {
  const text = decodeString(body, span);
  if (text.endsWith(suffix)) return { edited: body, declared: [] };
  return replaceAt(body, span, encodeJsonString(`${text}${suffix}`));
}

const goldenCases: GoldenCase[] = [
  {
    name: 'anthropic-append-system-block',
    protocol: 'anthropic',
    edit: body => appendTo(body, spanAt(body, 'system'), `{"type":"text","text":${encodeJsonString(INJECTED_CONTEXT)}}`),
  },
  {
    name: 'openai-chat-append-system',
    protocol: 'openai-chat',
    edit: body => appendToString(body, spanAt(body, 'messages', 0, 'content'), `\n\n${INJECTED_CONTEXT}`),
  },
  {
    name: 'openai-responses-append-instructions',
    protocol: 'openai-responses',
    edit: body => appendToString(body, spanAt(body, 'instructions'), `\n\n${INJECTED_CONTEXT}`),
  },
  {
    name: 'gemini-append-system-part',
    protocol: 'gemini',
    edit: body => appendTo(body, spanAt(body, 'systemInstruction', 'parts'), `{"text":${encodeJsonString(INJECTED_CONTEXT)}}`),
  },
];

const PROTOCOLS: WireProtocol[] = ['anthropic', 'openai-chat', 'openai-responses', 'gemini'];

/** Route ids are lowercase; one route per case, so each case's stage applies to its own route only. */
const routeIdOf = (name: string) => `golden-${name}`;

const stages: WireRewriteStage[] = [
  ...goldenCases.map((goldenCase): WireRewriteStage => ({
    name: goldenCase.name,
    appliesTo: context => context.routeId === routeIdOf(goldenCase.name),
    onRequest: (_context, body) => goldenCase.edit(body).edited,
  })),
  ...PROTOCOLS.map((protocol): WireRewriteStage => ({
    name: `noop-${protocol}`,
    appliesTo: context => context.routeId === routeIdOf(`noop-${protocol}`),
    onRequest: () => undefined,
  })),
  ...PROTOCOLS.map((protocol): WireRewriteStage => ({
    name: `throws-${protocol}`,
    appliesTo: context => context.routeId === routeIdOf(`throws-${protocol}`),
    onRequest: () => {
      throw new Error('a stage failed on purpose');
    },
  })),
  {
    name: 'breaks-a-pair',
    appliesTo: context => context.routeId === routeIdOf('breaks-a-pair'),
    // Drops the user message that answers toolu_1: the pairing check sends the original.
    onRequest: (_context, body) => removeArrayItems(body, spanAt(body, 'messages'), (_element, index) => index === 2),
  },
];

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
  const routeNames = [
    ...goldenCases.map(goldenCase => goldenCase.name),
    ...PROTOCOLS.flatMap(protocol => [`noop-${protocol}`, `throws-${protocol}`]),
    'breaks-a-pair',
  ];
  for (const name of routeNames) {
    addWireGatewayRoute({ routeId: routeIdOf(name), agentId: 'golden-agent', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  }
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    rewriteStages: stages,
    conversationLedger: new WireConversationLedger({ directory: join(testRoot, 'ledger') }),
  });
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

async function sendThroughGateway(routeName: string, protocol: WireProtocol, body: Uint8Array): Promise<Uint8Array> {
  const requestsBefore = upstream.requests.length;
  const response = await fetch(`${gateway.baseUrl}/r/${routeIdOf(routeName)}${SUFFIX_BY_PROTOCOL[protocol]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body,
  });
  await response.arrayBuffer();
  expect(response.status).toBe(200);
  expect(upstream.requests.length).toBe(requestsBefore + 1);
  return upstream.requests.at(-1)!.body;
}

describe('golden bytes through the rewrite seam', () => {
  for (const protocol of PROTOCOLS) {
    it(`sends a ${protocol} body a stage leaves alone byte for byte`, async () => {
      const input = readGoldenInput(protocol);
      expect(await sendThroughGateway(`noop-${protocol}`, protocol, input)).toEqual(input);
    });

    it(`sends a ${protocol} body byte for byte when its stage throws (fail open)`, async () => {
      const input = readGoldenInput(protocol);
      expect(await sendThroughGateway(`throws-${protocol}`, protocol, input)).toEqual(input);
    });
  }

  for (const goldenCase of goldenCases) {
    it(`${goldenCase.name}: golden bytes, changed only inside the declared spans, the same every time`, async () => {
      const input = readGoldenInput(goldenCase.protocol);
      const { edited, declared } = goldenCase.edit(input);
      const sent = await sendThroughGateway(goldenCase.name, goldenCase.protocol, input);
      expect(sent).toEqual(edited);
      expect(sent).not.toEqual(input);
      expectMatchesGoldenFile(goldenCase.name, sent);
      expectDiffersOnlyInsideDeclaredSpans(input, sent, declared);
      // The same request again gives the same bytes, and the edit applied to its own output changes nothing.
      expect(await sendThroughGateway(goldenCase.name, goldenCase.protocol, input)).toEqual(sent);
      expect(goldenCase.edit(sent).edited).toBe(sent);
    });
  }

  it('sends the original bytes when a rewrite would break a tool pair', async () => {
    const input = readGoldenInput('anthropic');
    expect(await sendThroughGateway('breaks-a-pair', 'anthropic', input)).toEqual(input);
    expect(gateway.service.rewriteSeam.health.states()['pairing-check']?.lastError).toContain('toolu_1');
  });
});

describe('the declared-span check itself', () => {
  const encoder = new TextEncoder();
  it('accepts edits inside the spans and refuses one outside', () => {
    const original = encoder.encode('{"a":"x","b":"y"}');
    const aSpan = getSpan(original, ['a'])!;
    expectDiffersOnlyInsideDeclaredSpans(original, encoder.encode('{"a":"changed","b":"y"}'), [aSpan]);
    expect(() => expectDiffersOnlyInsideDeclaredSpans(original, encoder.encode('{"a":"changed","b":"z"}'), [aSpan])).toThrow(/outside its declared spans/);
    expectDiffersOnlyInsideDeclaredSpans(original, original, []);
    expect(() => expectDiffersOnlyInsideDeclaredSpans(original, encoder.encode('{"a":"x","b":"y"} '), [])).toThrow(/outside/);
  });
});
