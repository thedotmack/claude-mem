import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import type { HookSpoolKind, HookSpoolPayloadByKind } from '../../src/shared/hook-spool.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { OTLP_PROTOBUF_REFUSAL, OtlpTraceReceiver, anyValueToJs, createOtlpTracesHandler, protocolOfRequestBody } from '../../src/services/wire-gateway/ingest/otlp-receiver.js';
import { FOREIGN_SOURCE_SETTLE_MS, WireForeignCapture, type CaptureSourceRuleOptions } from '../../src/services/wire-gateway/ingest/foreign-capture.js';
import { logger } from '../../src/utils/logger.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Plan Phase 13 task 2: POST /v1/traces. Verification: OTLP fixtures —
// opentelemetry-proto examples/trace.json, synthesized magpie spans carrying
// langfuse.* bodies, a GenAI-messages span → expected spool events; protobuf
// gets 415.

const testRoot = join(WIRE_GATEWAY_DIR, 'ways-in-otlp-test');
const routesFilePath = join(testRoot, 'routes.json');
const sandboxHome = join(testRoot, 'home');
const fixturesDirectory = join(import.meta.dir, 'fixtures', 'otlp');
const TURN_QUIET_MS_FOR_TEST = 50;

type SpooledEvent = { kind: HookSpoolKind; payload: HookSpoolPayloadByKind[HookSpoolKind] };
let events: SpooledEvent[] = [];
let gateway: StartedWireGateway;
const spies: Array<ReturnType<typeof spyOn>> = [];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function eventsOf(kind: HookSpoolKind): Array<Record<string, unknown>> {
  return events.filter(event => event.kind === kind).map(event => event.payload as unknown as Record<string, unknown>);
}

async function postTraces(body: string | Uint8Array, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<{ status: number; json: any }> {
  const response = await fetch(`${gateway.baseUrl}/v1/traces`, { method: 'POST', headers, body });
  return { status: response.status, json: await response.json() };
}

const string = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

function exportOf(serviceName: string, spans: unknown[]): string {
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [string('service.name', serviceName)] }, scopeSpans: [{ scope: { name: 'test' }, spans }] }] });
}

let spanCounter = 0;
function span(name: string, attributes: unknown[], kind = 3): Record<string, unknown> {
  spanCounter++;
  return {
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: `eee19b7ec3c1b${String(spanCounter).padStart(3, '0')}`,
    name, kind, startTimeUnixNano: '1544712660000000000', endTimeUnixNano: '1544712661000000000', attributes,
  };
}

// magpie's gateway span (internal/gateway/otel.go attempt + usage/otel_wire.go traces): an Anthropic request and its JSON reply.
const anthropicRequest = {
  model: 'claude-sonnet-5', max_tokens: 1024, system: 'You are a coding agent.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'fix the failing test' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: 'test.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'expect(1).toBe(2)' }] },
  ],
};
const anthropicReply = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'The test expected 2; fixed.' }],
  stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 8 },
};
function magpieGatewaySpan(agent: string): Record<string, unknown> {
  return span('chat claude-sonnet-5', [
    string('gen_ai.operation.name', 'chat'), string('gen_ai.provider.name', 'anthropic'), string('gen_ai.request.model', 'claude-sonnet-5'),
    string('magpie.agent', agent), int('http.response.status_code', 200), int('gen_ai.usage.input_tokens', 30),
    string('langfuse.observation.input', JSON.stringify(anthropicRequest)),
    string('langfuse.observation.output', JSON.stringify(anthropicReply)),
    string('langfuse.observation.type', 'generation'),
  ]);
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(sandboxHome, { recursive: true });
  // A wire route for "crush": magpie's crush spans must be skipped (one capture source per agent).
  addWireGatewayRoute({ routeId: 'crush', agentId: 'crush', upstreamBaseUrl: 'https://api.example.test' }, routesFilePath);
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    capture: {
      eventSink: { emit: (kind, payload) => { events.push({ kind, payload }); } },
      turnQuietMs: TURN_QUIET_MS_FOR_TEST,
      staleSweepIntervalMs: 0,
    },
    ingest: { captureSourceRule: { routesFilePath, environment: { home: sandboxHome, env: {}, platform: process.platform } } },
  });
});

afterAll(async () => {
  await gateway.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // A turn an earlier test ended is summarized after its quiet: let it land before this test looks.
  await sleep(TURN_QUIET_MS_FOR_TEST * 4);
  events = [];
  spies.push(spyOn(logger, 'debug').mockImplementation(() => {}), spyOn(logger, 'warn').mockImplementation(() => {}));
});

afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore());
});

describe('OTLP/HTTP JSON receiver', () => {
  it('opentelemetry-proto examples/trace.json: 200 {} and no events (a metadata-only span)', async () => {
    const answer = await postTraces(readFileSync(join(fixturesDirectory, 'trace.json'), 'utf8'));
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({});
    expect(events).toEqual([]);
  });

  it('protobuf, or any content type but JSON, gets 415 with the fix', async () => {
    for (const contentType of ['application/x-protobuf', 'application/protobuf', 'text/plain']) {
      const answer = await postTraces(new Uint8Array([0x0a, 0x00]), { 'content-type': contentType });
      expect(answer.status).toBe(415);
      expect(answer.json.message).toBe(OTLP_PROTOBUF_REFUSAL);
    }
  });

  it('a magpie gateway span with langfuse bodies → session_init, observation, then summarize after the turn\'s quiet', async () => {
    const answer = await postTraces(exportOf('magpie', [magpieGatewaySpan('hermes')]));
    expect(answer.json).toEqual({});
    const [init] = eventsOf('session_init');
    expect(init).toMatchObject({ platformSource: 'hermes', prompt: 'fix the failing test', project: 'hermes-unattributed' });
    expect(eventsOf('observation')).toEqual([{
      contentSessionId: init.contentSessionId, platformSource: 'hermes', toolName: 'Read', toolInput: { path: 'test.ts' },
      toolResponse: 'expect(1).toBe(2)', toolUseId: 'toolu_01', project: 'hermes-unattributed',
    }]);
    await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    expect(eventsOf('summarize')).toEqual([{ contentSessionId: init.contentSessionId, platformSource: 'hermes', lastAssistantMessage: 'The test expected 2; fixed.' }]);

    // The same span again (a retried export) adds nothing.
    events = [];
    await postTraces(exportOf('magpie', [magpieGatewaySpan('hermes')]));
    expect(eventsOf('session_init')).toEqual([]);
    expect(eventsOf('observation')).toEqual([]);
  });

  it('gzip is accepted', async () => {
    const answer = await postTraces(gzipSync(Buffer.from(exportOf('magpie', [magpieGatewaySpan('hermes')]))), {
      'content-type': 'application/json', 'content-encoding': 'gzip',
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({});
  });

  it('magpie session-poller spans (otel_sessions.go): a tool span → an observation, the interaction span → session_init and summarize', async () => {
    const sessionAttributes = (type: string) => [string('magpie.agent', 'hermes'), string('langfuse.session.id', 'hermes-session-9'), string('langfuse.trace.name', 'hermes interaction'), string('langfuse.observation.type', type), string('magpie.timing.source', 'recorded')];
    const toolSpan = span('Bash', [...sessionAttributes('tool'), string('langfuse.observation.input', '{"command":"ls"}'), string('langfuse.observation.output', 'a.ts\nb.ts')], 1);
    const rootSpan = span('hermes interaction', [...sessionAttributes('span'), string('langfuse.observation.input', 'list the files'), string('langfuse.observation.output', 'Two files.')], 1);
    const answer = await postTraces(exportOf('magpie', [toolSpan, rootSpan]));
    expect(answer.json).toEqual({});
    expect(eventsOf('observation')).toEqual([{
      contentSessionId: 'hermes-session-9', platformSource: 'hermes', toolName: 'Bash', toolInput: { command: 'ls' },
      toolResponse: 'a.ts\nb.ts', toolUseId: `magpie-${toolSpan.spanId}`, project: 'hermes-unattributed',
    }]);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 'hermes-session-9', platformSource: 'hermes', prompt: 'list the files' }]);
    await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    expect(eventsOf('summarize')).toEqual([{ contentSessionId: 'hermes-session-9', platformSource: 'hermes', lastAssistantMessage: 'Two files.' }]);
  });

  it('a GenAI-messages span (gen_ai.input.messages / gen_ai.output.messages) → session_init, observation and summarize', async () => {
    const genAiSpan = span('chat gpt-6', [
      string('gen_ai.operation.name', 'chat'), string('gen_ai.provider.name', 'openai'), string('gen_ai.request.model', 'gpt-6'),
      string('gen_ai.conversation.id', 'conv-42'),
      string('gen_ai.input.messages', JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'what is 2+2' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_9', name: 'calc', arguments: { expr: '2+2' } }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_9', response: '4' }] },
      ])),
      string('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'It is 4.' }], finish_reason: 'stop' }])),
    ]);
    expect((await postTraces(exportOf('my-agent', [genAiSpan]))).json).toEqual({});
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 'conv-42', platformSource: 'my-agent', prompt: 'what is 2+2' }]);
    expect(eventsOf('observation')).toEqual([{
      contentSessionId: 'conv-42', platformSource: 'my-agent', toolName: 'calc', toolInput: { expr: '2+2' },
      toolResponse: '4', toolUseId: 'call_9', project: 'my-agent-unattributed',
    }]);
    await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    expect(eventsOf('summarize')).toEqual([{ contentSessionId: 'conv-42', platformSource: 'my-agent', lastAssistantMessage: 'It is 4.' }]);
  });

  it('accepts the deprecated GenAI names (indexed gen_ai.prompt.N / gen_ai.completion.N, gen_ai.system)', async () => {
    const deprecatedSpan = span('chat old-model', [
      string('gen_ai.system', 'openai'), string('gen_ai.conversation.id', 'conv-old'),
      string('gen_ai.prompt.0.role', 'user'), string('gen_ai.prompt.0.content', 'say hello'),
      string('gen_ai.completion.0.role', 'assistant'), string('gen_ai.completion.0.content', 'hello'),
    ]);
    expect((await postTraces(exportOf('old-agent', [deprecatedSpan]))).json).toEqual({});
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 'conv-old', platformSource: 'old-agent', prompt: 'say hello' }]);
  });

  it('skips an agent captured another way: a wire route (crush), claude-mem\'s native integration (magpie "claude" = Claude Code, always on hooks)', async () => {
    const answer = await postTraces(exportOf('magpie', [magpieGatewaySpan('crush'), magpieGatewaySpan('claude')]));
    expect(answer.json).toEqual({});
    await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    expect(events).toEqual([]);
  });

  it('a span whose bodies cannot be read is rejected: 200 with partialSuccess, the rest still captured', async () => {
    const unreadable = span('chat x', [string('magpie.agent', 'hermes'), string('langfuse.observation.input', '{"model": "x", "messages": [ ... cut'), string('langfuse.observation.output', 'partial')]);
    const answer = await postTraces(exportOf('magpie', [unreadable, magpieGatewaySpan('pi-like-agent')]));
    expect(answer.status).toBe(200);
    expect(answer.json.partialSuccess.rejectedSpans).toBe('1');
    expect(answer.json.partialSuccess.errorMessage).toContain('not valid JSON');
    expect(eventsOf('session_init')).toHaveLength(1);
  });

  it('a body that is not an export is a 400 google.rpc.Status', async () => {
    const answer = await postTraces('[1, 2]');
    expect(answer.status).toBe(400);
    expect(answer.json.code).toBe(3);
  });
});

describe('OTLP helpers', () => {
  it('reads every AnyValue variant', () => {
    expect(anyValueToJs({ stringValue: 's' })).toBe('s');
    expect(anyValueToJs({ intValue: '10' })).toBe(10);
    expect(anyValueToJs({ doubleValue: 1.5 })).toBe(1.5);
    expect(anyValueToJs({ boolValue: true })).toBe(true);
    expect(anyValueToJs({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } })).toEqual(['a', 2]);
    expect(anyValueToJs({ kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } })).toEqual({ k: 'v' });
    expect(anyValueToJs({ bytesValue: 'AAE=' })).toBe('AAE=');
  });

  it('tells the protocol from a body\'s shape', () => {
    expect(protocolOfRequestBody({ contents: [] })).toBe('gemini');
    expect(protocolOfRequestBody({ model: 'gpt-6', input: [] })).toBe('openai-responses');
    expect(protocolOfRequestBody(anthropicRequest)).toBe('anthropic');
    expect(protocolOfRequestBody({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }] })).toBe('openai-chat');
    expect(protocolOfRequestBody({ messages: [{ role: 'user', content: 'y' }] }, 'anthropic')).toBe('anthropic');
    expect(protocolOfRequestBody({ messages: [{ role: 'user', content: 'y' }] })).toBe('openai-chat');
    expect(protocolOfRequestBody({ prompt: 'x' })).toBeNull();
  });
});

describe('OTLP off', () => {
  it('CLAUDE_MEM_WIRE_GATEWAY_OTLP=false: /v1/traces answers 404', async () => {
    const offGateway = await startWireGatewayForTest({ otlp: false });
    try {
      const response = await fetch(`${offGateway.baseUrl}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    } finally {
      await offGateway.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Routing and the one-source rule, at the receiver (review fixes P2-a, P2-b, P3-3, P3-4, P3-8)

describe('OTLP span routing and the one-source rule', () => {
  const unitRoot = join(testRoot, 'unit');
  const unitRoutesFilePath = join(unitRoot, 'routes.json');
  const sandboxEnvironment = { home: sandboxHome, env: {}, platform: process.platform };

  /** The real capture, over an assembler that only records what reached it. */
  function recordingCapture(clock?: { now: number }): { capture: WireForeignCapture; observed: Array<{ kind: 'exchange' | 'toolRun'; value: any }> } {
    const observed: Array<{ kind: 'exchange' | 'toolRun'; value: any }> = [];
    const assembler = {
      observeExchange: (value: unknown) => { observed.push({ kind: 'exchange', value }); },
      observeToolRun: (value: unknown) => { observed.push({ kind: 'toolRun', value }); },
    };
    const turnTracker = { begin: () => undefined, end: () => undefined };
    return { capture: new WireForeignCapture({ assembler: assembler as never, turnTracker: turnTracker as never, ...(clock ? { now: () => clock.now } : {}) }), observed };
  }

  /** A capture stub that records what the receiver hands it (no rule). */
  function stubCapture(): { capture: never; exchanges: any[]; toolRuns: any[] } {
    const exchanges: any[] = [];
    const toolRuns: any[] = [];
    const capture = {
      checkForBatch: () => () => null,
      observeExchange: (exchange: unknown) => { exchanges.push(exchange); return 'captured'; },
      observeToolRun: (run: unknown) => { toolRuns.push(run); return 'captured'; },
    };
    return { capture: capture as never, exchanges, toolRuns };
  }

  function receiverOf(capture: WireForeignCapture | never, rule: CaptureSourceRuleOptions = {}): OtlpTraceReceiver {
    return new OtlpTraceReceiver(capture, { routesFilePath: unitRoutesFilePath, environment: sandboxEnvironment, ...rule });
  }

  const sessionSpan = (agent: string, type: string, name: string, input: string, output: string, extra: unknown[] = []) => span(name, [
    string('magpie.agent', agent), string('langfuse.session.id', `${agent}-session`), string('langfuse.trace.name', `${agent} interaction`),
    string('langfuse.observation.type', type), string('magpie.timing.source', 'recorded'),
    string('langfuse.observation.input', input), string('langfuse.observation.output', output), ...extra,
  ], 1);
  const parsed = (text: string) => JSON.parse(text) as unknown;

  beforeEach(() => {
    rmSync(unitRoot, { recursive: true, force: true });
    mkdirSync(unitRoot, { recursive: true });
  });

  for (const args of ['{"command":"ls"}', '{"input":"*** Begin Patch"}', '{"instructions":"x"}', '{"messages":[{"role":"user","content":"x"}]}', '{"contents":[]}']) {
    it(`a magpie session tool span is a tool run, whatever its arguments hold (P2-a): ${args}`, () => {
      const { capture, exchanges, toolRuns } = stubCapture();
      const result = receiverOf(capture).export(parsed(exportOf('magpie', [sessionSpan('hermes', 'tool', 'apply_patch', args, 'ok')])));
      expect(result).toMatchObject({ captured: 1, rejected: 0 });
      expect(exchanges).toEqual([]);
      expect(toolRuns).toMatchObject([{ channel: 'magpie_session_span', agentId: 'hermes', sessionId: 'hermes-session', toolName: 'apply_patch', argsText: args, resultText: 'ok' }]);
    });
  }

  it('takes magpie\'s session and gateway spans alike, for every agent: magpie withholds a gateway span only for a call its session spans cover (P2)', () => {
    // magpie internal/gateway/otel.go:82-90: a session-traced agent's remote, keyed, via or helper call, or any call with session export
    // off, gets a gateway span and no session span; so codex's gateway span is its own exchange, not a copy of the session span.
    const { capture, observed } = recordingCapture();
    const receiver = receiverOf(capture);
    const result = receiver.export(parsed(exportOf('magpie', [
      magpieGatewaySpan('codex'),
      sessionSpan('codex', 'tool', 'Read', '{"path":"test.ts"}', 'expect(1).toBe(2)'),
      sessionSpan('codex', 'span', 'codex interaction', 'fix the failing test', 'The test expected 2; fixed.'),
      magpieGatewaySpan('opencode'),
      magpieGatewaySpan('hermes'),
    ])));
    expect(result).toMatchObject({ captured: 5, skippedOtherSource: 0, rejected: 0 });
    expect(observed.map(entry => entry.kind)).toEqual(['exchange', 'toolRun', 'exchange', 'exchange', 'exchange']);
    expect(observed.filter(entry => entry.kind === 'exchange').map(entry => entry.value.identity.agentId)).toEqual(['codex', 'codex', 'opencode', 'hermes']);
  });

  it('an agent that sends its own GenAI spans is taken from them; magpie\'s copies of it are skipped while they arrive (P2)', () => {
    const clock = { now: 1_000_000 };
    const { capture, observed } = recordingCapture(clock);
    const receiver = receiverOf(capture);
    const ownSpan = span('chat gpt-6', [string('gen_ai.input.messages', JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }]))]);
    expect(receiver.export(parsed(exportOf('kimi', [ownSpan])))).toMatchObject({ captured: 1, skippedOtherSource: 0 });
    // The same call through magpie, moments later: a copy.
    clock.now += 5_000;
    expect(receiver.export(parsed(exportOf('magpie', [magpieGatewaySpan('kimi'), sessionSpan('kimi', 'span', 'kimi interaction', 'hi', 'hello')])))).toMatchObject({ captured: 0, skippedOtherSource: 2 });
    // Another agent's magpie spans are not affected.
    expect(receiver.export(parsed(exportOf('magpie', [magpieGatewaySpan('hermes')])))).toMatchObject({ captured: 1, skippedOtherSource: 0 });
    // Once the agent's own spans have stopped for longer than the settle time, magpie's are its source again.
    clock.now += FOREIGN_SOURCE_SETTLE_MS + 1;
    expect(receiver.export(parsed(exportOf('magpie', [magpieGatewaySpan('kimi')])))).toMatchObject({ captured: 1, skippedOtherSource: 0 });
    expect(observed.map(entry => entry.value.identity.agentId)).toEqual(['kimi', 'hermes', 'kimi']);
  });

  it('skips every outside span while routes.json cannot be read (whether the agent is wired is unknown)', () => {
    writeFileSync(unitRoutesFilePath, '{ not json');
    const { capture, observed } = recordingCapture();
    expect(receiverOf(capture).export(parsed(exportOf('magpie', [magpieGatewaySpan('hermes')])))).toMatchObject({ captured: 0, skippedOtherSource: 1 });
    expect(observed).toEqual([]);
  });

  it('skips Claude Code (native, always on its hooks) for a request that is no helper call: its session span and a GenAI span with tools', () => {
    const { capture, observed } = recordingCapture();
    const receiver = new OtlpTraceReceiver(capture, { routesFilePath: unitRoutesFilePath, environment: sandboxEnvironment });
    const toolsRequest = span('chat claude-sonnet-5', [
      string('gen_ai.tool.definitions', JSON.stringify([{ name: 'Read' }])),
      string('gen_ai.input.messages', JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'fix the failing test in the parser and run the suite' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'toolu_9', name: 'Read', arguments: { path: 'parser.ts' } }] },
        { role: 'tool', parts: [{ type: 'tool_call_response', id: 'toolu_9', response: 'export function parse() {}' }] },
      ])),
      string('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Fixed.' }] }])),
    ]);
    const result = receiver.export(parsed(JSON.stringify({ resourceSpans: [
      { resource: { attributes: [string('service.name', 'magpie')] }, scopeSpans: [{ spans: [sessionSpan('claude', 'span', 'claude interaction', 'fix the failing test in the parser', 'Fixed.')] }] },
      { resource: { attributes: [string('service.name', 'claude-code')] }, scopeSpans: [{ spans: [toolsRequest] }] },
    ] })));
    expect(result).toMatchObject({ captured: 0, skippedOtherSource: 2, rejected: 0 });
    expect(observed).toEqual([]);
  });

  it('maps magpie\'s gen_ai.request.model to the model, and http.response.status_code to the status', () => {
    const { capture, exchanges } = stubCapture();
    const receiver = receiverOf(capture);
    const modelless = { ...anthropicRequest, model: undefined };
    const gateway = (status: number, output: string, model?: string) => span('chat', [
      string('magpie.agent', 'hermes'), string('gen_ai.provider.name', 'anthropic'), ...(model ? [string('gen_ai.request.model', model)] : []),
      int('http.response.status_code', status), string('langfuse.observation.input', JSON.stringify(modelless)), string('langfuse.observation.output', output),
    ]);
    receiver.export(parsed(exportOf('magpie', [
      gateway(200, 'All done.', 'claude-sonnet-5'),
      gateway(503, 'upstream overloaded', 'claude-sonnet-5'),
      sessionSpan('hermes', 'generation', 'chat', 'a prompt', 'a reply', [string('gen_ai.request.model', 'gpt-6'), int('http.response.status_code', 500)]),
    ])));
    expect(exchanges.map(exchange => exchange.request.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'gpt-6']);
    expect(exchanges[0]).toMatchObject({ replyIsWhole: true, reply: { text: 'All done.', endedCleanly: true } });
    expect(exchanges[0].reply.error).toBeUndefined();
    expect(exchanges[1]).toMatchObject({ replyIsWhole: false, finalReply: false, reply: { error: 'upstream overloaded', endedCleanly: false } });
    expect(exchanges[2]).toMatchObject({ replyIsWhole: false, reply: { endedCleanly: false } });
  });

  it('a fault in claude-mem (not a span it cannot read) is answered 503 and logged, never a rejected span (P3-3)', async () => {
    const errors: unknown[] = [];
    const errorSpy = spyOn(logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    try {
      const failing = { observeExchange: () => { throw new TypeError('a bug in capture'); }, observeToolRun: () => { throw new TypeError('a bug in capture'); } };
      const receiver = receiverOf(failing as never);
      let thrown: unknown;
      try {
        receiver.export(parsed(exportOf('magpie', [magpieGatewaySpan('hermes')])));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      const handler = createOtlpTracesHandler({ receiver });
      const response = await handler(new Request('http://127.0.0.1/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exportOf('magpie', [magpieGatewaySpan('hermes')]) }));
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe(14);
      expect(errors).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('never logs or answers text taken from a body that is not JSON (P3-4)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const warnings: unknown[] = [];
    const warnSpy = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    try {
      const { capture } = stubCapture();
      const receiver = receiverOf(capture);
      const handler = createOtlpTracesHandler({ receiver });
      const leaky = span('chat', [string('magpie.agent', 'hermes'), string('langfuse.observation.input', `${secret} {"messages"`), string('langfuse.observation.output', 'x')]);
      const answer = await handler(new Request('http://127.0.0.1/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exportOf('magpie', [leaky]) }));
      const answerText = await answer.text();
      expect(answerText).toContain('rejectedSpans');
      expect(answerText).toContain('not valid JSON');
      expect(answerText).not.toContain('ghp_');
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain('ghp_');
      const notJson = await handler(new Request('http://127.0.0.1/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"resourceSpans": ${secret}}` }));
      expect(notJson.status).toBe(400);
      expect(await notJson.text()).not.toContain('ghp_');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
