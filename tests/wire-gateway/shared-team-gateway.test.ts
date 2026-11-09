import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as nodeCrypto from 'crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR, paths } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { addWireClientKey } from '../../src/services/wire-gateway/shared/client-keys.js';
import { FailedKeyThrottle } from '../../src/services/wire-gateway/shared/auth-throttle.js';
import type { DirectHttpOutcome, DirectHttpRequest } from '../../src/services/wire-gateway/direct-http.js';
import { logger } from '../../src/utils/logger.js';
import { sse, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Phase 16 end to end, over HTTP against an in-process gateway in shared mode:
// its loopback listener (this computer, no key) and its team listener (a key
// on every request). The team listener's peer address comes from a seam
// (every test socket is loopback) unless a test asks for the real one;
// everything after it — allow list, keys, throttle, routing, capture — is the
// real code path.

const testRoot = join(WIRE_GATEWAY_DIR, 'shared-team-gateway-test');
const routesFilePath = join(testRoot, 'routes.json');
const keysFilePath = join(testRoot, 'keys', 'keys.json');
const outboxDirectory = join(testRoot, 'outbox');
const recordingsDirectory = join(testRoot, 'recordings');
const TURN_QUIET_MS_FOR_TEST = 100;
const REMOTE_PEER = '203.0.113.7';
/** keys.json's stamp is looked at once a second (client-keys.ts CLIENT_KEYS_RELOAD_CHECK_INTERVAL_MS); a test waits past it. */
const KEYS_RELOAD_WAIT_MS = 1_100;
/** The plan's number (magpie authFailBurst), written out so a changed constant fails here. */
const FAILURES_BEFORE_429 = 50;
/** A test server: http on loopback, which the private-network rule allows. */
const SERVER = (apiKey: string, projectId: string) => ({ url: 'https://team.example.com', apiKey, projectId });

let upstream: FakeUpstream;
let aliceKey: string;
let bobKey: string;
let peerAddress: string = REMOTE_PEER;
const sent: DirectHttpRequest[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startSharedGateway(options: { allowIps?: string; throttle?: FailedKeyThrottle; realPeerAddress?: boolean } = {}): Promise<StartedWireGateway> {
  return startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    shared: true,
    allowIps: options.allowIps ?? '',
    sharedMode: {
      clientKeysFilePath: keysFilePath,
      outboxDirectory,
      ...(options.realPeerAddress ? {} : { peerAddressOf: () => peerAddress }),
      throttle: options.throttle,
      outbox: {
        // The server runtime answers 201 to everything here; delivery itself is tested in shared-server-outbox.test.ts.
        send: async (request): Promise<DirectHttpOutcome> => {
          sent.push(request);
          return { response: { statusCode: 201, bodyText: '{}' } };
        },
        tickIntervalMs: 50,
      },
    },
    capture: { recordingsDirectory, turnQuietMs: TURN_QUIET_MS_FOR_TEST, staleSweepIntervalMs: 0, consent: { isRecordingOn: () => true, recordingGeneration: () => 1 } },
  });
}

type CallInit = { method?: string; headers?: Record<string, string>; body?: unknown };

async function callUrl(url: string, init: CallInit = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(url, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.method === 'GET' ? undefined : JSON.stringify(init.body ?? { model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** The team listener: where members (and any proxy) connect. */
function call(gateway: StartedWireGateway, path: string, init: CallInit = {}) {
  return callUrl(`${gateway.teamUrl}${path}`, init);
}

/** The loopback listener: this computer's own agents, no key. */
function callLoopback(gateway: StartedWireGateway, path: string, init: CallInit = {}) {
  return callUrl(`${gateway.baseUrl}${path}`, init);
}

const originalKeysFile = () => readFileSync(keysFilePath, 'utf-8');

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  addWireGatewayRoute({ routeId: 'claude', agentId: 'claude-code', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'codex', agentId: 'codex', upstreamBaseUrl: upstream.url }, routesFilePath);
  aliceKey = addWireClientKey({ name: 'alice', server: SERVER('cmem_aliceserverkey000000000', 'project-a') }, keysFilePath).rawKey;
  bobKey = addWireClientKey({ name: 'bob', server: SERVER('cmem_bobserverkey0000000000000', 'project-b') }, keysFilePath).rawKey;
});

afterAll(async () => {
  await upstream.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  peerAddress = REMOTE_PEER;
  sent.length = 0;
  rmSync(outboxDirectory, { recursive: true, force: true });
  rmSync(recordingsDirectory, { recursive: true, force: true });
});

describe('team listener: client keys at the door', () => {
  let gateway: StartedWireGateway;
  beforeEach(async () => { gateway = await startSharedGateway(); });
  afterEach(async () => { await gateway.stop(); });

  it('a request without a key gets 401, and the provider is never asked', async () => {
    const before = upstream.requests.length;
    const response = await call(gateway, '/r/claude/v1/messages');
    expect(response.status).toBe(401);
    expect(JSON.parse(response.text).error.type).toBe('authentication_error');
    expect(response.text).toContain('/k/<key>/r/<route>');
    expect(upstream.requests.length).toBe(before);
  });

  it('a request with a wrong key gets 401, and the key is not echoed', async () => {
    const wrongKey = `cmw_${'A'.repeat(43)}`;
    const response = await call(gateway, `/k/${wrongKey}/r/claude/v1/messages`);
    expect(response.status).toBe(401);
    expect(response.text).not.toContain(wrongKey);
    expect(response.text).not.toContain('AAAA');
  });

  it('a request with a valid key is relayed with the agent\'s own credential, the key path stripped', async () => {
    const before = upstream.requests.length;
    const response = await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`, { headers: { 'x-api-key': 'sk-ant-api03-vendor-credential' } });
    expect(response.status).toBe(200);
    const relayed = upstream.requests[before];
    expect(relayed.path).toBe('/v1/messages');
    expect(relayed.headers['x-api-key']).toBe('sk-ant-api03-vendor-credential');
    expect(JSON.stringify(relayed)).not.toContain(aliceKey);
  });

  it('the identity probe answers a keyed caller at /k/<key>/ and /k/<key>/r/<route>/', async () => {
    for (const path of [`/k/${aliceKey}/`, `/k/${aliceKey}/r/claude/`]) {
      const response = await call(gateway, path, { method: 'GET' });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).name).toBe('claude-mem-wire-gateway');
    }
  });
});

describe('team listener: no keyless access, whatever the peer address (a TLS proxy on the host adds no header)', () => {
  let gateway: StartedWireGateway;
  beforeEach(async () => { gateway = await startSharedGateway(); });
  afterEach(async () => { await gateway.stop(); });

  for (const loopbackPeer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    it(`a ${loopbackPeer} peer without a forwarding header needs a key like anyone else`, async () => {
      peerAddress = loopbackPeer;
      const before = upstream.requests.length;
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(401);
      expect(upstream.requests.length).toBe(before);
      for (const endpoint of [{ method: 'GET', path: '/wire/routes' }, { method: 'POST', path: '/mcp' }, { method: 'POST', path: '/v1/claude-mem/events' }, { method: 'GET', path: '/wire/trace' }]) {
        expect((await call(gateway, endpoint.path, { method: endpoint.method })).status).toBe(401);
        expect((await call(gateway, `/k/${aliceKey}${endpoint.path}`, { method: endpoint.method })).status).toBe(403);
      }
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
    });
  }

  it('the loopback listener serves this computer without a key, and never takes a key path', async () => {
    expect((await callLoopback(gateway, '/r/claude/v1/messages')).status).toBe(200);
    expect((await callLoopback(gateway, '/wire/routes', { method: 'GET' })).status).toBe(200);
    expect((await callLoopback(gateway, '/wire/identity', { method: 'GET' })).status).toBe(200);
    const keyed = await callLoopback(gateway, `/k/${aliceKey}/r/claude/v1/messages`);
    expect(keyed.status).toBe(404);
    expect(keyed.text).not.toContain(aliceKey);
    // A proxy that does add a forwarding header is refused there, as on a single-user gateway.
    expect((await callLoopback(gateway, '/r/claude/v1/messages', { headers: { 'x-forwarded-for': '203.0.113.7' } })).status).toBe(403);
  });
});

describe('team listener on a real loopback socket (what a header-less TLS proxy on the host looks like)', () => {
  it('a real 127.0.0.1 connection gets nothing without a key', async () => {
    const gateway = await startSharedGateway({ realPeerAddress: true });
    try {
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(401);
      expect((await call(gateway, '/wire/routes', { method: 'GET' })).status).toBe(401);
      expect((await call(gateway, '/mcp')).status).toBe(401);
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });
});

describe('team listener: endpoint exposure', () => {
  let gateway: StartedWireGateway;
  beforeEach(async () => { gateway = await startSharedGateway(); });
  afterEach(async () => { await gateway.stop(); });

  const hostOnlyEndpoints: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/wire/status' },
    { method: 'GET', path: '/wire/routes' },
    { method: 'GET', path: '/wire/identity' },
    { method: 'POST', path: '/wire/launch' },
    { method: 'GET', path: '/wire/trace' },
    { method: 'GET', path: '/wire/call?id=x' },
    { method: 'POST', path: '/mcp' },
    { method: 'POST', path: '/v1/claude-mem/events' },
    { method: 'POST', path: '/v1/traces' },
  ];

  for (const endpoint of hostOnlyEndpoints) {
    it(`${endpoint.method} ${endpoint.path}: without a key 401, with a key 403 (loopback listener only)`, async () => {
      expect((await call(gateway, endpoint.path, { method: endpoint.method })).status).toBe(401);
      const keyed = await call(gateway, `/k/${aliceKey}${endpoint.path}`, { method: endpoint.method });
      expect(keyed.status).toBe(403);
      expect(keyed.text).toContain('answer the gateway host only');
    });
  }
});

describe('team listener: the failed-key throttle never locks a member out (magpie identifyCaller)', () => {
  it('50 failures get 401, then 429 with Retry-After; a valid key never verified before still gets 200', async () => {
    let nowMs = 1_000_000;
    const gateway = await startSharedGateway({ throttle: new FailedKeyThrottle(() => nowMs) });
    try {
      for (let attempt = 0; attempt < FAILURES_BEFORE_429; attempt++) {
        const response = await call(gateway, attempt % 2 === 0 ? `/k/cmw_${'C'.repeat(43)}/r/claude/v1/messages` : '/r/claude/v1/messages');
        expect(response.status).toBe(401);
      }
      const throttled = await call(gateway, `/k/cmw_${'D'.repeat(43)}/r/claude/v1/messages`);
      expect(throttled.status).toBe(429);
      // magpie's rounding: whole seconds until a token frees, plus one.
      expect(throttled.headers.get('retry-after')).toBe('2');
      expect(JSON.parse(throttled.text).error.type).toBe('rate_limit_error');
      // Alice's key was never verified by this process: it is still checked and let in.
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
      // A sustained flood of one wrong key a second keeps the bucket empty; members still get in.
      for (let second = 0; second < 5; second++) {
        nowMs += 1_000;
        expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(401);
        expect((await call(gateway, `/k/${bobKey}/r/claude/v1/messages`)).status).toBe(200);
      }
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(429);
      // A loopback peer gets no exemption on the team listener: a header-less proxy looks like one.
      peerAddress = '127.0.0.1';
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(429);
      // The loopback listener never touches the throttle.
      expect((await callLoopback(gateway, '/r/claude/v1/messages')).status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });

  it('after a keys.json change and after a restart, a flood still cannot keep a member out', async () => {
    let nowMs = 2_000_000;
    const throttle = new FailedKeyThrottle(() => nowMs);
    let gateway = await startSharedGateway({ throttle });
    const keysBefore = originalKeysFile();
    try {
      expect((await call(gateway, `/k/${bobKey}/r/claude/v1/messages`)).status).toBe(200);
      for (let attempt = 0; attempt <= FAILURES_BEFORE_429; attempt++) await call(gateway, '/r/claude/v1/messages');
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(429);
      // The host adds a key: keys.json changes, the verified cache is cleared.
      const carolKey = addWireClientKey({ name: 'carol', server: SERVER('cmem_carolserverkey0000000000', 'project-c') }, keysFilePath).rawKey;
      await sleep(KEYS_RELOAD_WAIT_MS);
      expect((await call(gateway, `/k/${bobKey}/r/claude/v1/messages`)).status).toBe(200);
      expect((await call(gateway, `/k/${carolKey}/r/claude/v1/messages`)).status).toBe(200);
      // A restart: nothing verified yet, the bucket still empty.
      await gateway.stop();
      gateway = await startSharedGateway({ throttle });
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(429);
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
    } finally {
      await gateway.stop();
      writeFileSync(keysFilePath, keysBefore, { mode: 0o600 });
    }
  });

  it('no slow hash on the request path: a flood of wrong keys sharing a member\'s prefix runs no scrypt, and the member gets through', async () => {
    const gateway = await startSharedGateway({ throttle: new FailedKeyThrottle(() => 7_000_000) });
    const asyncHash = spyOn(nodeCrypto, 'scrypt');
    const syncHash = spyOn(nodeCrypto, 'scryptSync');
    try {
      const cpuBefore = process.cpuUsage();
      const statuses = await Promise.all(Array.from({ length: 200 }, (_, index) =>
        call(gateway, `/k/${aliceKey.slice(0, 10)}${String(index).padStart(37, 'Z')}/`, { method: 'GET' }).then(response => response.status)));
      expect(statuses.filter(status => status === 401)).toHaveLength(FAILURES_BEFORE_429);
      expect(statuses.filter(status => status === 429)).toHaveLength(200 - FAILURES_BEFORE_429);
      // CPU for the 200 requests, client and gateway together: scrypt cost ~26 ms per key
      // (.scratch/review-p16-rereview), over 5 s for these 200; a digest each stays far below 2 s.
      const cpu = process.cpuUsage(cpuBefore);
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(2_000);
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
      expect(asyncHash).not.toHaveBeenCalled();
      expect(syncHash).not.toHaveBeenCalled();
    } finally {
      asyncHash.mockRestore();
      syncHash.mockRestore();
      await gateway.stop();
    }
  });
});

describe('team listener: allow list on the socket address', () => {
  it('lets in an address on the list and refuses one off it, key or not', async () => {
    const gateway = await startSharedGateway({ allowIps: '10.0.0.0/8, 192.168.1.5' });
    try {
      peerAddress = '10.1.2.3';
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
      peerAddress = '::ffff:192.168.1.5';
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
      peerAddress = REMOTE_PEER;
      const refused = await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`);
      expect(refused.status).toBe(403);
      expect(refused.text).toContain(REMOTE_PEER);
      expect(refused.text).not.toContain(aliceKey);
    } finally {
      await gateway.stop();
    }
  });

  it('never believes a forwarding header: a spoofed X-Forwarded-For from an address off the list is refused', async () => {
    const gateway = await startSharedGateway({ allowIps: '10.0.0.0/8' });
    try {
      peerAddress = REMOTE_PEER;
      for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip']) {
        const value = header === 'forwarded' ? 'for=10.1.2.3' : '10.1.2.3';
        expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`, { headers: { [header]: value } })).status).toBe(403);
      }
    } finally {
      await gateway.stop();
    }
  });

  it('a malformed entry lets nothing in (the list stays on); this computer passes the list but still needs a key', async () => {
    const gateway = await startSharedGateway({ allowIps: '10.0.0.0/33' });
    try {
      peerAddress = '10.1.2.3';
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(403);
      peerAddress = REMOTE_PEER;
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(403);
      peerAddress = '127.0.0.1';
      expect((await call(gateway, '/r/claude/v1/messages')).status).toBe(401);
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });
});

describe('team listener: keys.json that does not read fails closed', () => {
  it('every keyed request gets 503 until keys.json reads again (a botched removal never leaves a key working)', async () => {
    const gateway = await startSharedGateway();
    const keysBefore = originalKeysFile();
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
      writeFileSync(keysFilePath, keysBefore.replace(/"name": "alice"[\s\S]*?"name": "bob"/, '"name": "bob"').slice(0, -10));
      await sleep(KEYS_RELOAD_WAIT_MS);
      const refused = await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`);
      expect(refused.status).toBe(503);
      expect((await call(gateway, `/k/${bobKey}/r/claude/v1/messages`)).status).toBe(503);
      expect(error).toHaveBeenCalled();
      writeFileSync(keysFilePath, keysBefore, { mode: 0o600 });
      await sleep(KEYS_RELOAD_WAIT_MS);
      expect((await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`)).status).toBe(200);
    } finally {
      error.mockRestore();
      writeFileSync(keysFilePath, keysBefore, { mode: 0o600 });
      await gateway.stop();
    }
  });
});

describe('team listener: refusal logging is rate-limited', () => {
  it('a flood of refusals writes one line per reason, then one count when the gateway stops', async () => {
    const warnings: string[] = [];
    const warn = spyOn(logger, 'warn').mockImplementation(((_component: string, message: string) => { warnings.push(message); }) as never);
    const gateway = await startSharedGateway({ throttle: new FailedKeyThrottle(() => 5_000_000) });
    try {
      for (let attempt = 0; attempt < 80; attempt++) await call(gateway, '/r/claude/v1/messages');
    } finally {
      await gateway.stop();
      warn.mockRestore();
    }
    const refusalLines = warnings.filter(message => message.includes('Refused'));
    expect(refusalLines).toEqual([
      'Refused a request on the team listener: no client key',
      'Refused a request on the team listener: too many failed client keys (429)',
      `Refused ${FAILURES_BEFORE_429 - 1} more request(s) on the team listener: no client key`,
      `Refused ${80 - FAILURES_BEFORE_429 - 1} more request(s) on the team listener: too many failed client keys (429)`,
    ]);
  });
});

describe('path keys never reach a log', () => {
  it('neither the logger calls nor the written log file hold a client key; refusals log /k/[REDACTED]/', async () => {
    const loggedCalls: string[] = [];
    const spies = (['debug', 'info', 'warn', 'error'] as const).map(level =>
      spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        loggedCalls.push(JSON.stringify(args, (_key, value) => value instanceof Error ? `${value.message} ${value.stack}` : value));
      }) as never));
    const gateway = await startSharedGateway({ allowIps: '10.0.0.0/8' });
    const wrongKey = `cmw_${'E'.repeat(43)}`;
    try {
      peerAddress = '10.1.2.3';
      await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`);
      await call(gateway, `/k/${wrongKey}/r/claude/v1/messages`);
      await call(gateway, `/k/${aliceKey}/wire/status`, { method: 'GET' });
      await call(gateway, `/k/${aliceKey}/r/missing-route/v1/messages`);
      await callLoopback(gateway, `/k/${aliceKey}/r/claude/v1/messages`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
      peerAddress = REMOTE_PEER;
      await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`);
    } finally {
      await gateway.stop();
      spies.forEach(spy => spy.mockRestore());
    }
    const everything = loggedCalls.join('\n');
    expect(everything).toContain('/k/[REDACTED]');
    expect(everything).not.toContain(aliceKey);
    expect(everything).not.toContain(wrongKey);
    expect(everything).not.toContain(aliceKey.slice(4, 20));

    // And the logger's own last step, over a line as it is written to the log file.
    const logFile = join(paths.logsDir(), `claude-mem-${new Date().toISOString().split('T')[0]}.log`);
    logger.warn('WIRE', 'redaction probe', { path: `/k/${aliceKey}/r/claude/v1/messages`, raw: aliceKey });
    const written = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
    expect(written).toContain('redaction probe');
    expect(written).toContain('/k/[REDACTED]/r/claude/v1/messages');
    expect(written).not.toContain(aliceKey);
  });
});

// A Codex turn (OpenAI Responses): prompt, a shell call, its result, the final text.
const promptItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] };
const functionCallItem = { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' };
const functionCallOutputItem = { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' };
const codexTools = [{ type: 'function', name: 'shell', parameters: {} }];
const firstCodexRequest = { model: 'gpt-6', stream: true, tools: codexTools, input: [promptItem] };
const secondCodexRequest = { model: 'gpt-6', stream: true, tools: codexTools, input: [promptItem, functionCallItem, functionCallOutputItem] };
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

async function playCodexTurn(gateway: StartedWireGateway, basePath: string, headers: Record<string, string>): Promise<void> {
  upstream.setReply({ kind: 'sse', chunks: [functionCallReply] });
  expect((await call(gateway, `${basePath}/v1/responses`, { body: firstCodexRequest, headers })).status).toBe(200);
  upstream.setReply({ kind: 'sse', chunks: [finalTextReply] });
  expect((await call(gateway, `${basePath}/v1/responses`, { body: secondCodexRequest, headers })).status).toBe(200);
  await sleep(TURN_QUIET_MS_FOR_TEST * 4);
}

/** A key name's files in one outbox state, across its record ids. */
function outboxFiles(keyName: string, state: string): string[] {
  const nameDirectory = join(outboxDirectory, keyName);
  if (!existsSync(nameDirectory)) return [];
  return readdirSync(nameDirectory).flatMap(keyId => {
    const directory = join(nameDirectory, keyId, state);
    return existsSync(directory) ? readdirSync(directory).map(file => join(keyId, state, file)) : [];
  });
}

/** A key name's delivered markers (the lines of its delivered.log), across its record ids. */
function deliveredMarkers(keyName: string): string[] {
  const nameDirectory = join(outboxDirectory, keyName);
  if (!existsSync(nameDirectory)) return [];
  return readdirSync(nameDirectory).flatMap(keyId => {
    const indexPath = join(nameDirectory, keyId, 'delivered.log');
    return existsSync(indexPath) ? readFileSync(indexPath, 'utf-8').split('\n').filter(Boolean) : [];
  });
}

function recordedLines(): string[] {
  if (!existsSync(recordingsDirectory)) return [];
  return readdirSync(recordingsDirectory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .flatMap(entry => readFileSync(join(entry.parentPath, entry.name), 'utf-8').split('\n').filter(Boolean));
}

describe('shared team gateway: capture', () => {
  it('a fingerprinted session (no client-named id) is neither recorded nor captured', async () => {
    const gateway = await startSharedGateway();
    try {
      await playCodexTurn(gateway, `/k/${aliceKey}/r/codex`, {});
      await gateway.service.serverOutbox!.drainNow();
    } finally {
      await gateway.stop();
    }
    expect(recordedLines()).toEqual([]);
    expect(outboxFiles('alice', 'pending')).toEqual([]);
    expect(deliveredMarkers('alice')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a client-named session goes to its key\'s server runtime with the member\'s own session id and server API key', async () => {
    const gateway = await startSharedGateway();
    try {
      await playCodexTurn(gateway, `/k/${aliceKey}/r/codex`, { session_id: 'codex-thread-1', 'x-codex-turn-metadata': '{"turn_id":"turn-1"}' });
      await gateway.service.serverOutbox!.drainNow();
    } finally {
      await gateway.stop();
    }
    const routes = sent.map(request => new URL(request.url).pathname);
    expect(routes).toEqual(['/v1/events', '/api/sessions/observations', '/v1/events']);
    for (const request of sent) {
      expect(request.url.startsWith('https://team.example.com/')).toBe(true);
      expect(request.headers).toEqual({ authorization: 'Bearer cmem_aliceserverkey000000000' });
      expect(JSON.stringify(request.jsonBody)).not.toContain('key:alice');
    }
    expect(sent[0].jsonBody).toMatchObject({ projectId: 'project-a', eventType: 'session_init', contentSessionId: 'codex-thread-1', platformSource: 'codex', sourceType: 'hook' });
    expect(sent[1].jsonBody).toMatchObject({ contentSessionId: 'codex-thread-1', tool_name: 'shell', tool_response: 'a.ts\nb.ts' });
    // The tool id is sent scoped by its session (the server dedupes tool ids across a project).
    expect((sent[1].jsonBody as { tool_use_id: string }).tool_use_id).toMatch(/^[0-9a-f]{64}-call_1$/);
    expect(sent[2].jsonBody).toMatchObject({ eventType: 'summarize', contentSessionId: 'codex-thread-1' });
    expect(deliveredMarkers('alice')).toHaveLength(3);
    expect(outboxFiles('alice', 'pending')).toEqual([]);
    // A delivered marker holds no content.
    expect(deliveredMarkers('alice').join('\n')).not.toContain('list the files');
    // Recording consent is on in this test, so the named session's turns are recorded (namespaced by key and record).
    expect(recordedLines().length).toBeGreaterThan(0);
    for (const line of recordedLines()) expect(JSON.parse(line).session).toMatch(/^key:alice\/[0-9a-f]{32}:codex-thread-1$/);
    expect(statSync(join(outboxDirectory, 'alice')).mode & 0o077).toBe(0);
  });

  it('two members naming the same session id stay apart: each key\'s events go to its own project', async () => {
    const gateway = await startSharedGateway();
    const headers = { session_id: 'shared-name', 'x-codex-turn-metadata': '{"turn_id":"turn-1"}' };
    try {
      await playCodexTurn(gateway, `/k/${aliceKey}/r/codex`, headers);
      await playCodexTurn(gateway, `/k/${bobKey}/r/codex`, headers);
      await gateway.service.serverOutbox!.drainNow();
    } finally {
      await gateway.stop();
    }
    const aliceRequests = sent.filter(request => request.headers?.authorization === 'Bearer cmem_aliceserverkey000000000');
    const bobRequests = sent.filter(request => request.headers?.authorization === 'Bearer cmem_bobserverkey0000000000000');
    expect(aliceRequests).toHaveLength(3);
    expect(bobRequests).toHaveLength(3);
    expect(bobRequests[0].jsonBody).toMatchObject({ projectId: 'project-b', contentSessionId: 'shared-name' });
  });

  it('an exchange the provider refused (401/403: a bogus provider key) is not captured, for members and the host alike', async () => {
    const gateway = await startSharedGateway();
    const headers = { session_id: 'refused-thread', 'x-codex-turn-metadata': '{"turn_id":"turn-1"}' };
    try {
      for (const status of [401, 403]) {
        upstream.setReply({ kind: 'json', status, body: { error: { message: 'invalid api key', type: 'invalid_request_error' } } });
        const bigOutput = { ...functionCallOutputItem, output: 'x'.repeat(200_000) };
        expect((await call(gateway, `/k/${aliceKey}/r/codex/v1/responses`, { body: { ...secondCodexRequest, stream: false, input: [promptItem, functionCallItem, bigOutput] }, headers })).status).toBe(status);
        expect((await callLoopback(gateway, '/r/codex/v1/responses', { body: { ...secondCodexRequest, stream: false }, headers: { ...headers, session_id: `host-${status}` } })).status).toBe(status);
      }
      await sleep(TURN_QUIET_MS_FOR_TEST * 4);
      await gateway.service.serverOutbox!.drainNow();
    } finally {
      upstream.setReply({ kind: 'json', body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
      await gateway.stop();
    }
    expect(sent).toEqual([]);
    expect(outboxFiles('alice', 'pending')).toEqual([]);
    expect(outboxFiles('alice', 'rejected')).toEqual([]);
  });

  it('wire status reports the team listener, the loopback listener and counts only', async () => {
    const gateway = await startSharedGateway();
    try {
      await call(gateway, '/r/claude/v1/messages');
      const report = await gateway.service.statusReport();
      expect(report.team?.listener).toBe(gateway.teamUrl!);
      expect(report.gateway.origin).toBe(gateway.baseUrl);
      expect(report.team?.clientKeys).toBeGreaterThanOrEqual(2);
      expect(report.team?.admission.refusedNoKey).toBeGreaterThan(0);
      expect(JSON.stringify(report.team)).not.toContain('cmw_');
      expect(gateway.service.runtimeState().sharedPort).toBe(gateway.service.sharedPort);
    } finally {
      await gateway.stop();
    }
  });
});

describe('team listener: what a member\'s request never touches', () => {
  beforeEach(() => upstream.setReply({ kind: 'json', body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }));

  it('a member\'s subscription sign-in is refused even with FORWARD_SUBSCRIPTION_SIGNINS=true (it lifts D4 for the host\'s agents only)', async () => {
    const gateway = await startWireGatewayForTest({
      routesFilePath, routesReloadCheckIntervalMs: 0, shared: true, allowIps: '', forwardSubscriptionSignIns: true,
      sharedMode: { clientKeysFilePath: keysFilePath, outboxDirectory, peerAddressOf: () => REMOTE_PEER, outbox: { send: async () => ({ response: { statusCode: 201, bodyText: '{}' } }) } },
    });
    const signIn = { authorization: 'Bearer sk-ant-oat01-subscription-token' };
    try {
      const before = upstream.requests.length;
      const member = await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`, { headers: signIn });
      expect(member.status).toBe(403);
      expect(member.text).toContain('subscription');
      expect(upstream.requests.length).toBe(before);
      // The host's own agent, on the loopback listener: forwarded, as the setting says.
      expect((await callLoopback(gateway, '/r/claude/v1/messages', { headers: signIn })).status).toBe(200);
      expect(upstream.requests.length).toBe(before + 1);
    } finally {
      await gateway.stop();
    }
  });

  it('a member\'s request does not mark the host\'s agent as seen (drift status is about this host\'s own agents)', async () => {
    const gateway = await startSharedGateway();
    try {
      const before = gateway.service.agentLastSeen.snapshot().codex;
      expect((await call(gateway, `/k/${aliceKey}/r/codex/v1/responses`, { body: { ...firstCodexRequest, stream: false } })).status).toBe(200);
      expect(gateway.service.agentLastSeen.snapshot().codex).toBe(before);
      expect((await callLoopback(gateway, '/r/codex/v1/responses', { body: { ...firstCodexRequest, stream: false } })).status).toBe(200);
      expect(gateway.service.agentLastSeen.snapshot().codex).not.toBe(before);
    } finally {
      await gateway.stop();
    }
  });

  it('outbound redaction: each key has its own placeholders; a reply to bob never carries alice\'s secret, nor the host\'s', async () => {
    const gateway = await startWireGatewayForTest({
      routesFilePath, routesReloadCheckIntervalMs: 0, shared: true, allowIps: '', outboundRedaction: true,
      sharedMode: { clientKeysFilePath: keysFilePath, outboxDirectory, peerAddressOf: () => REMOTE_PEER, outbox: { send: async () => ({ response: { statusCode: 201, bodyText: '{}' } }) } },
    });
    const aliceSecret = 'sk-proj-ALICEaliceALICEalice0123456789abcdefABCDEF';
    const hostSecret = 'sk-proj-HOSTHOSThosthostHOST0123456789abcdefABCDEF';
    const ask = (secret: string) => ({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: `my key is ${secret}` }] });
    try {
      upstream.setReply({ kind: 'json', body: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
      let before = upstream.requests.length;
      await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`, { body: ask(aliceSecret) });
      const alicePlaceholder = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/.exec(new TextDecoder().decode(upstream.requests[before].body))?.[0];
      expect(alicePlaceholder).toBeDefined();
      before = upstream.requests.length;
      await callLoopback(gateway, '/r/claude/v1/messages', { body: ask(hostSecret) });
      const hostPlaceholder = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/.exec(new TextDecoder().decode(upstream.requests[before].body))?.[0];
      expect(hostPlaceholder).toBeDefined();
      // The same value in two namespaces gets two different placeholders.
      expect(alicePlaceholder).not.toBe(hostPlaceholder);
      // The model echoes both placeholders (braced and bare) to bob: nothing of alice's or the host's comes back.
      const bare = (placeholder: string) => placeholder.slice(2, -2);
      upstream.setReply({ kind: 'json', body: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: `${alicePlaceholder} ${bare(alicePlaceholder!)} ${hostPlaceholder} ${bare(hostPlaceholder!)}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
      const toBob = await call(gateway, `/k/${bobKey}/r/claude/v1/messages`, { body: ask('nothing secret here') });
      expect(toBob.text).not.toContain(aliceSecret);
      expect(toBob.text).not.toContain(hostSecret);
      // Alice still gets her own value back.
      const toAlice = await call(gateway, `/k/${aliceKey}/r/claude/v1/messages`, { body: ask('again') });
      expect(toAlice.text).toContain(aliceSecret);
      expect(toAlice.text).not.toContain(hostSecret);
    } finally {
      await gateway.stop();
    }
  });
});
