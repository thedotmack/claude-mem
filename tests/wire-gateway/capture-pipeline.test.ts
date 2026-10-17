import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { HookSpool, type HookSpoolEntry } from '../../src/shared/hook-spool.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { drainHookSpool } from '../../src/services/worker/hook-spool-drain.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { createHookSpoolCaptureEventSink } from '../../src/services/wire-gateway/capture/capture-event-sink.js';
import type { WireRecordingConsent } from '../../src/services/wire-gateway/capture/turn-recorder.js';
import { logger } from '../../src/utils/logger.js';
import { sse, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Phase 5 end to end: relayed exchanges become spooled neutral events that
// the worker's own drainer ingests into an in-memory store, exactly once.

const testRoot = join(WIRE_GATEWAY_DIR, 'capture-pipeline-test');
const routesFilePath = join(testRoot, 'routes.json');
const spoolDirectory = join(testRoot, 'hook-spool');
const recordingsDirectory = join(testRoot, 'recordings');
const TURN_QUIET_MS_FOR_TEST = 100;

let upstream: FakeUpstream;
let store: SessionStore;
let spool: HookSpool;
let sessionManager: Record<string, ReturnType<typeof mock>>;
const spies: Array<ReturnType<typeof spyOn>> = [];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startCapturingGateway(consent?: WireRecordingConsent): Promise<StartedWireGateway> {
  return startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    capture: {
      eventSink: createHookSpoolCaptureEventSink({ spool, nudgeWorker: () => undefined }),
      recordingsDirectory,
      turnQuietMs: TURN_QUIET_MS_FOR_TEST,
      staleSweepIntervalMs: 0,
      consent,
    },
  });
}

async function post(gateway: StartedWireGateway, path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  const response = await fetch(`${gateway.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return response;
}

function spooled(kind?: HookSpoolEntry['kind']): HookSpoolEntry[] {
  const entries = spool.entries();
  return kind ? entries.filter(entry => entry.kind === kind) : entries;
}

function countRows(table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS rowCount FROM ${table}`).get() as { rowCount: number }).rowCount;
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
}

// A Codex (OpenAI Responses) turn: the prompt, a shell call, its result, the final text.
const CODEX_SESSION_HEADERS = { session_id: 'codex-thread-1', 'x-codex-turn-metadata': '{"turn_id":"turn-1"}' };
const environmentContextItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/Users/me/proj</cwd>\n</environment_context>' }] };
const promptItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] };
const functionCallItem = { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' };
const functionCallOutputItem = { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' };
const codexTools = [{ type: 'function', name: 'shell', parameters: {} }];
const firstCodexRequest = { model: 'gpt-6', stream: true, tools: codexTools, input: [environmentContextItem, promptItem] };
const secondCodexRequest = { model: 'gpt-6', stream: true, tools: codexTools, input: [environmentContextItem, promptItem, functionCallItem, functionCallOutputItem] };

const functionCallReply = sse(
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-6","output":[]}}',
  `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: functionCallItem })}`,
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-6","usage":{"input_tokens":10,"output_tokens":5}}}',
);
const finalTextReply = sse(
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2","model":"gpt-6","output":[]}}',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Two files."}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-6","usage":{"input_tokens":20,"output_tokens":3}}}',
);

async function playCodexTurn(gateway: StartedWireGateway): Promise<void> {
  upstream.setReply({ kind: 'sse', chunks: [functionCallReply] });
  expect((await post(gateway, '/r/codex/v1/responses', firstCodexRequest, CODEX_SESSION_HEADERS)).status).toBe(200);
  upstream.setReply({ kind: 'sse', chunks: [finalTextReply] });
  expect((await post(gateway, '/r/codex/v1/responses', secondCodexRequest, CODEX_SESSION_HEADERS)).status).toBe(200);
  await sleep(TURN_QUIET_MS_FOR_TEST * 4);
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream();
  addWireGatewayRoute({ routeId: 'codex', agentId: 'codex', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'claude', agentId: 'claude-code', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'native', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
});

afterAll(async () => {
  await upstream.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(spoolDirectory, { recursive: true, force: true });
  spool = new HookSpool(spoolDirectory);
  spies.push(
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults()),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
  );
  store = new SessionStore(new Database(':memory:'));
  sessionManager = {
    queueObservation: mock(() => {}),
    queueSummarize: mock(() => {}),
    requestSessionWrapup: mock(async () => {}),
    getSession: mock(() => undefined),
    initializeSession: mock((_sessionDbId: number, _prompt: string, _promptNumber: number, project: string) => ({ project })),
  };
  setIngestContext({
    sessionManager: sessionManager as any,
    dbManager: { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
    eventBroadcaster: {
      broadcastNewPrompt: mock(() => {}),
      broadcastSessionStarted: mock(() => {}),
      broadcastObservationQueued: mock(() => {}),
      broadcastSummarizeQueued: mock(() => {}),
    } as any,
    ensureGeneratorRunning: mock(async () => {}),
  });
});

afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore());
  store.close();
});

describe('wire capture pipeline', () => {
  it('a Codex turn spools one session_init, one observation and one summarize, which drain into the store', async () => {
    const gateway = await startCapturingGateway();
    try {
      await playCodexTurn(gateway);
    } finally {
      await gateway.stop();
    }

    const inits = spooled('session_init');
    const observations = spooled('observation');
    const summaries = spooled('summarize');
    expect(spooled()).toHaveLength(3);
    expect(inits).toHaveLength(1);
    expect(inits[0].payload).toEqual({
      contentSessionId: 'codex-thread-1', platformSource: 'codex', prompt: 'list the files', nativePromptId: 'turn-1', cwd: '/Users/me/proj',
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].payload).toEqual({
      contentSessionId: 'codex-thread-1', platformSource: 'codex', toolName: 'shell', toolInput: { cmd: 'ls' },
      toolResponse: 'a.ts\nb.ts', toolUseId: 'call_1', cwd: '/Users/me/proj',
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload).toEqual({
      contentSessionId: 'codex-thread-1', platformSource: 'codex', lastAssistantMessage: 'Two files.', cwd: '/Users/me/proj',
    });
    // Recording consent is off (Phase 6 supplies it): nothing is written under recordings/.
    expect(filesUnder(recordingsDirectory)).toEqual([]);

    expect(await drainHookSpool(spool)).toEqual({ drained: 3, retained: 0, quarantined: 0, expired: 0 });
    expect(countRows('sdk_sessions')).toBe(1);
    expect(countRows('user_prompts')).toBe(1);
    expect(countRows('tool_uses')).toBe(1);
    const sessionDbId = store.findSessionDbIdByContentSessionId('codex-thread-1', 'codex');
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
    expect(sessionManager.queueObservation.mock.calls[0][0]).toBe(sessionDbId);
    expect(sessionManager.queueObservation.mock.calls[0][1]).toMatchObject({ tool_name: 'shell', toolUseId: 'call_1', prompt_number: 1, cwd: '/Users/me/proj' });
    expect(sessionManager.queueSummarize).toHaveBeenCalledWith(sessionDbId, 'Two files.', 1, expect.any(Number));
  });

  it('replaying the same turn after an assembler restart, then draining, adds no rows', async () => {
    const firstGateway = await startCapturingGateway();
    try {
      await playCodexTurn(firstGateway);
    } finally {
      await firstGateway.stop();
    }
    await drainHookSpool(spool);
    // The worker's generator stored the observation and linked its tool use.
    store.linkToolUsesToObservation({ contentSessionId: 'codex-thread-1', toolUseIds: ['call_1'], observationId: 1 });
    const rowsBefore = { sessions: countRows('sdk_sessions'), prompts: countRows('user_prompts'), toolUses: countRows('tool_uses') };

    const restartedGateway = await startCapturingGateway();
    try {
      await playCodexTurn(restartedGateway);
    } finally {
      await restartedGateway.stop();
    }
    await drainHookSpool(spool);

    expect({ sessions: countRows('sdk_sessions'), prompts: countRows('user_prompts'), toolUses: countRows('tool_uses') }).toEqual(rowsBefore);
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(1);
  });

  it('an error event after HTTP 200 does not end the turn; the next whole reply does', async () => {
    const gateway = await startCapturingGateway();
    const headers = { 'x-claude-code-session-id': 'error-turn' };
    const request = { model: 'm', max_tokens: 64000, tools: [{ name: 'Bash', input_schema: {} }], messages: [{ role: 'user', content: 'fix the build' }] };
    const messageStart = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}';
    try {
      upstream.setReply({
        kind: 'error-after-200',
        chunks: [sse(messageStart)],
        errorEvent: sse('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      });
      await post(gateway, '/r/claude/v1/messages', request, headers);
      await sleep(TURN_QUIET_MS_FOR_TEST * 4);
      expect(spooled('summarize')).toHaveLength(0);

      upstream.setReply({ kind: 'sse', chunks: [sse(
        messageStart,
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fixed."}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      )] });
      await post(gateway, '/r/claude/v1/messages', request, headers);
      await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    } finally {
      await gateway.stop();
    }
    // No folder in the request: filed under the agent's unattributed project, with no cwd.
    expect(spooled('session_init').map(entry => entry.payload)).toEqual([{
      contentSessionId: 'error-turn', platformSource: 'claude', prompt: 'fix the build',
      nativePromptId: expect.stringMatching(/^wire:[0-9a-f]{32}$/), project: 'claude-code-unattributed',
    }]);
    // The spool normalizes the platform (claude-code → claude), as for the hooks.
    expect(spooled('summarize').map(entry => entry.payload)).toEqual([{
      contentSessionId: 'error-turn', platformSource: 'claude', lastAssistantMessage: 'Fixed.',
    }]);
  });

  it('a native route is relayed but never captured (native first)', async () => {
    const gateway = await startCapturingGateway();
    try {
      upstream.setReply({ kind: 'json', body: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
      const response = await post(gateway, '/r/native/v1/messages', { model: 'm', max_tokens: 64000, messages: [{ role: 'user', content: 'hello' }] }, { 'x-claude-code-session-id': 'native-session' });
      expect(response.status).toBe(200);
      await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    } finally {
      await gateway.stop();
    }
    expect(spooled()).toEqual([]);
  });

  it('with consent, a turn is recorded without its headers and a helper request is not recorded', async () => {
    rmSync(recordingsDirectory, { recursive: true, force: true });
    const gateway = await startCapturingGateway({ isRecordingOn: () => true, recordingGeneration: () => 1 });
    const finalReply = { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    try {
      upstream.setReply({ kind: 'json', body: finalReply });
      await post(gateway, '/r/claude/v1/messages', { model: 'm', max_tokens: 64000, tools: [{ name: 'Bash', input_schema: {} }], messages: [{ role: 'user', content: 'hello' }] },
        { 'x-claude-code-session-id': 'recorded-session', 'x-api-key': 'sk-ant-api03-secret' });
      // Small and tool-less from Claude Code: a title helper.
      await post(gateway, '/r/claude/v1/messages', { model: 'm', max_tokens: 512, messages: [{ role: 'user', content: 'title this' }] },
        { 'x-claude-code-session-id': 'recorded-session' });
    } finally {
      await gateway.stop();
    }
    const turnsFiles = readdirSync(recordingsDirectory, { recursive: true }).map(String).filter(name => name.endsWith('turns.jsonl'));
    expect(turnsFiles).toHaveLength(1);
    const lines = readFileSync(join(recordingsDirectory, turnsFiles[0]), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const turn = JSON.parse(lines[0]);
    expect(turn).toMatchObject({ agent: 'claude-code', session: 'recorded-session', status: 200, routeId: 'claude', kind: 'turn' });
    expect(turn.output).toEqual([{ role: 'assistant', kind: 'text', text: 'Hello.' }]);
    expect(lines[0]).not.toContain('sk-ant-api03-secret');
  });
});
