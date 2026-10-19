import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { composeRelayObservers, type RelayExchange } from '../../src/services/wire-gateway/relay/relay.js';
import { TurnTracker, createTurnTrackingRelayObserver, type WireTurnEnd } from '../../src/services/wire-gateway/identity/turn-tracker.js';
import { sse, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Phase 4 through the running gateway: identity on every exchange, the
// x-claude-mem-session echo, launcher sessions, and turn ends from the relay.

const routesFilePath = join(WIRE_GATEWAY_DIR, 'identity-relay-test-routes.json');
const CLAUDE_CODE_FIXTURE = readFileSync(join(import.meta.dir, '../fixtures/wire-gateway/magpie/workdir/claude-code-2.1.296.json'));
const TURN_QUIET_MS_FOR_TEST = 150;

let upstream: FakeUpstream;
let gateway: StartedWireGateway;
let turnTracker: TurnTracker;
const exchanges: RelayExchange[] = [];
const turnEnds: WireTurnEnd[] = [];

beforeAll(async () => {
  upstream = await startFakeUpstream();
  rmSync(routesFilePath, { force: true });
  addWireGatewayRoute({ routeId: 'claude', agentId: 'claude-code', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'native', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  addWireGatewayRoute({ routeId: 'any', agentId: 'generic', upstreamBaseUrl: upstream.url }, routesFilePath);
  turnTracker = new TurnTracker({
    onTurnEnd: turnEnd => turnEnds.push(turnEnd),
    onSessionStale: () => undefined,
    turnQuietMs: TURN_QUIET_MS_FOR_TEST,
    staleSweepIntervalMs: 0,
  });
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    relayObserver: composeRelayObservers(
      { onExchangeStarted: exchange => exchanges.push(exchange) },
      createTurnTrackingRelayObserver(turnTracker),
    ),
  });
});

afterAll(async () => {
  turnTracker.dispose();
  await gateway.stop();
  await upstream.stop();
  rmSync(routesFilePath, { force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function post(path: string, body: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(`${gateway.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  await response.arrayBuffer();
  return response;
}

async function createLaunch(body: unknown): Promise<Response> {
  return fetch(`${gateway.baseUrl}/wire/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const simpleTurn = '{"model":"m","max_tokens":64000,"tools":[{"name":"Bash","input_schema":{}}],"messages":[{"role":"user","content":"hi"}]}';

describe('wire identity through the relay', () => {
  it('a session the client named is echoed in x-claude-mem-session; a fingerprint is not', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const named = await post('/r/claude/v1/messages', simpleTurn, { 'x-claude-code-session-id': 'cc-session-1' });
    expect(named.headers.get('x-claude-mem-session')).toBe('cc-session-1');
    expect(exchanges.at(-1)!.identity).toMatchObject({ agentId: 'claude-code', sessionId: 'cc-session-1', sessionSource: 'header', kind: 'turn' });

    const fromBody = await post('/r/claude/v1/messages?beta=true', CLAUDE_CODE_FIXTURE);
    expect(fromBody.headers.get('x-claude-mem-session')).toBe('790b2fef-7571-49e7-8619-e5bf3806b7ca');
    expect(exchanges.at(-1)!.identity.workDir).toBe('/Users/me/work/proj/a&b <c> 中文');

    const fingerprinted = await post('/r/claude/v1/messages', simpleTurn);
    expect(fingerprinted.headers.get('x-claude-mem-session')).toBeNull();
    expect(exchanges.at(-1)!.identity.sessionSource).toBe('fingerprint');

    // The gateway's own header never goes upstream.
    await post('/r/claude/v1/messages', simpleTurn, { 'x-claude-mem-session': 'mine' });
    expect(upstream.requests.at(-1)!.headers['x-claude-mem-session']).toBeUndefined();
    expect(exchanges.at(-1)!.identity.sessionSource).toBe('named');
  });

  it('a native route is never recorded but still has its identity read from the body', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const response = await post('/r/native/v1/messages', CLAUDE_CODE_FIXTURE);
    expect(response.headers.get('x-claude-mem-session')).toBe('790b2fef-7571-49e7-8619-e5bf3806b7ca');
    const exchange = exchanges.at(-1)!;
    expect(exchange.captured).toBe(false);
    expect(exchange.decodedRequestBody).toBeNull();
    expect(exchange.request).not.toBeNull();
    expect(exchange.identity.sessionSource).toBe('body');
    // Read for identity, forwarded byte for byte.
    expect(Buffer.from(upstream.requests.at(-1)!.body).equals(CLAUDE_CODE_FIXTURE)).toBe(true);
  });

  it('a body session id that cannot be a header value relays without an echo', async () => {
    upstream.setReply({ kind: 'json', body: { ok: true } });
    const userId = JSON.stringify({ device_id: 'd', session_id: '会话-1' });
    const body = JSON.stringify({ model: 'm', max_tokens: 64000, metadata: { user_id: userId }, messages: [{ role: 'user', content: 'hi' }] });
    const response = await post('/r/claude/v1/messages', body);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-claude-mem-session')).toBeNull();
    expect(exchanges.at(-1)!.identity).toMatchObject({ sessionId: '会话-1', sessionSource: 'body' });
  });

  it('a generic route takes its agent from the User-Agent; a relay-only path gets a header-only identity', async () => {
    upstream.setReply({ kind: 'json', body: { input_tokens: 3 } });
    await post('/r/any/v1/messages/count_tokens', simpleTurn, { 'user-agent': 'claude-cli/2.1.296 (external, cli)', 'x-claude-code-session-id': 'cc-2' });
    expect(exchanges.at(-1)!.identity).toMatchObject({ agentId: 'claude-code', kind: 'helper:count_tokens', sessionId: 'cc-2' });
    expect(exchanges.at(-1)!.request).toBeNull();
  });

  it('POST /wire/launch makes a launch whose /l/<launchId> segment names the session and folder and never goes upstream', async () => {
    const created = await createLaunch({ agentId: 'aider', cwd: '/Users/me/launched' });
    expect(created.status).toBe(200);
    const { launchId } = await created.json() as { launchId: string };
    expect(launchId).toMatch(/^[a-z2-7]{26}$/);

    upstream.setReply({ kind: 'json', body: { ok: true } });
    const relayed = await post(`/r/claude/l/${launchId}/v1/messages?beta=true`, simpleTurn);
    expect(relayed.status).toBe(200);
    expect(upstream.requests.at(-1)!.path).toBe('/v1/messages');
    expect(upstream.requests.at(-1)!.query).toBe('?beta=true');
    expect(relayed.headers.get('x-claude-mem-session')).toBe(launchId);
    expect(exchanges.at(-1)!.identity).toMatchObject({ sessionId: launchId, sessionSource: 'launch', workDir: '/Users/me/launched', agentId: 'claude-code' });
    expect(exchanges.at(-1)!.suffixPath).toBe('/v1/messages');

    // An agent that names its session keeps it under a launch (a resumed
    // conversation under a new `wire run`); the launch still gives the folder.
    await post(`/r/claude/l/${launchId}/v1/messages`, simpleTurn, { 'x-claude-code-session-id': 'resumed-session' });
    expect(exchanges.at(-1)!.identity).toMatchObject({ sessionId: 'resumed-session', sessionSource: 'header', workDir: '/Users/me/launched' });
    // `wire run` asks how many requests its launch carried once the agent exits.
    const counted = await fetch(`${gateway.baseUrl}/wire/launch?launchId=${launchId}`);
    expect(await counted.json()).toEqual({ requestCount: 2 });
    expect((await fetch(`${gateway.baseUrl}/wire/launch?launchId=${'c'.repeat(26)}`)).status).toBe(404);

    // An unknown launch still relays, stripped, and falls back to what the request says.
    const unknown = await post(`/r/claude/l/${'b'.repeat(26)}/v1/messages`, simpleTurn);
    expect(unknown.status).toBe(200);
    expect(upstream.requests.at(-1)!.path).toBe('/v1/messages');
    expect(exchanges.at(-1)!.identity.sessionSource).toBe('fingerprint');
  });

  it('POST /wire/launch refuses bad input', async () => {
    expect((await fetch(`${gateway.baseUrl}/wire/launch`, { method: 'PUT' })).status).toBe(405);
    expect((await createLaunch({ agentId: 'aider', cwd: 'relative/dir' })).status).toBe(400);
    expect((await createLaunch({ agentId: 'Not An Id', cwd: '/x' })).status).toBe(400);
    expect((await createLaunch({ cwd: '/x' })).status).toBe(400);
    const notJson = await fetch(`${gateway.baseUrl}/wire/launch`, { method: 'POST', body: '{nope' });
    expect(notJson.status).toBe(400);
    expect((await notJson.json() as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });

  it('turn ends: a tool-calling reply and a subagent\'s final reply do not end the turn; the final reply does, after the quiet', async () => {
    const headers = { 'x-claude-code-session-id': 'turn-session' };
    const toolUseStream = sse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    );
    const finalStream = sse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done: \\"tool_use\\""}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    );
    const turnEndsOfSession = () => turnEnds.filter(turnEnd => turnEnd.sessionId === 'turn-session');

    upstream.setReply({ kind: 'sse', chunks: [toolUseStream] });
    await post('/r/claude/v1/messages', simpleTurn, headers);
    upstream.setReply({ kind: 'sse', chunks: [finalStream] });
    await post('/r/claude/v1/messages', simpleTurn, { ...headers, 'x-claude-code-agent-id': 'a143287ac46b82a96' });
    await sleep(TURN_QUIET_MS_FOR_TEST * 3);
    expect(turnEndsOfSession()).toHaveLength(0);

    await post('/r/claude/v1/messages', simpleTurn, headers);
    await sleep(TURN_QUIET_MS_FOR_TEST * 3);
    expect(turnEndsOfSession()).toHaveLength(1);
    expect(turnEndsOfSession()[0].agentId).toBe('claude-code');
  });
});
