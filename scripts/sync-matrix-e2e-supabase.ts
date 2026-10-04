#!/usr/bin/env bun
/**
 * Canonical protocol-v2 sync E2E against the Supabase `cmem-sync` Edge Function.
 *
 * Supabase-local variant of scripts/sync-matrix-e2e.ts (plan
 * 2026-10-03-liveness-over-deadlines, Phase 9). Nothing is spawned here: the
 * caller runs local Supabase with `supabase functions serve cmem-sync` (Pro
 * repo) and seeds one active-pro `pro_users` row whose sync log is empty. The
 * Edge Function itself checks the token against pro_users and writes the log
 * and the read model in one transaction, so there is no projector sidecar.
 *
 * Every client fetch and socket is guarded as loopback-only (unless one exact
 * remote host is opted in, see CMEM_SYNC_E2E_ALLOW_REMOTE_HUB). Exactly two real
 * client stacks (SessionStore + CloudSync + SyncApply + SyncClient) talk
 * protocol v2 over HTTP. Live updates (Phase 11): each client trades its
 * cm_pro token at POST /v1/sync/realtime-token for an ES256 JWT and joins the
 * private Supabase Realtime channel `user:<id>`; a push from A must reach B as
 * an `advance` broadcast and B's cursor must reach the head with NO explicit
 * pull and with the HTTP poll tiers set to 10 minutes, so delivery can only
 * have come from Realtime. B runs on a clock skewed toward its token expiry
 * so it re-mints its 900 s token within seconds and hands it to the open
 * channel (`access_token` event); a later advance must still arrive.
 * The `X-Sync-Mode: poll` header the function stamps for OLD clients must not
 * turn Realtime off.
 *
 * Env:
 *   CMEM_SYNC_E2E_HUB_URL  (default http://127.0.0.1:54321/functions/v1/cmem-sync)
 *   CMEM_SYNC_E2E_USER_ID  pro_users.user_id of the seeded account (required)
 *   CMEM_SYNC_E2E_TOKEN    its setup_token (required)
 *   CMEM_SYNC_E2E_REALTIME_BUDGET_MS  max push->B-cursor latency over Realtime (default 5000)
 *   CMEM_SYNC_E2E_ALLOW_REMOTE_HUB    one exact hostname also allowed (TLS only) for a production
 *                                     smoke run against a dedicated test account; unset = loopback only
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../src/services/sync/CloudSync.js';
import {
  assertCanonicalDecimal,
  compareCanonicalDecimals,
  incrementCanonicalDecimal,
  parseCanonicalOperation,
  stableDocumentId,
  type CanonicalContentBody,
} from '../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../src/services/sync/SyncApply.js';
import { SyncClient } from '../src/services/sync/SyncClient.js';
import { emitRemapProject } from '../src/services/sync/remap-outbox.js';

const DEFAULT_HUB_URL = 'http://127.0.0.1:54321/functions/v1/cmem-sync';
const DEVICE_IDS = { a: 'matrix-device-a', b: 'matrix-device-b' } as const;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** Poll tiers far beyond any wait below: convergence without a pull proves Realtime delivered. */
const POLL_MS = 600_000;
const REALTIME_BUDGET_MS = Number(process.env.CMEM_SYNC_E2E_REALTIME_BUDGET_MS ?? 5_000);
/** realtime-token TTL is server-fixed at 900 s; B's clock runs this close to expiry so it refreshes in ~4 s. */
const B_CLOCK_SKEW_MS = 895_000;

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required (seed an active-pro pro_users row with an empty sync log)`);
  return value;
}

function check(condition: unknown, message: string, detail?: unknown): asserts condition {
  if (!condition) {
    const suffix = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`;
    throw new Error(`${message}${suffix}`);
  }
  console.log(`  PASS  ${message}`);
}

function invariant(condition: unknown, message: string, detail?: unknown): asserts condition {
  if (!condition) {
    const suffix = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Loopback only by default. A deliberate production smoke run opts in with
 * CMEM_SYNC_E2E_ALLOW_REMOTE_HUB=<exact hostname>: then that one host is also
 * allowed, over TLS only (https:/wss:), and the Hub URL must be on it. No
 * wildcard or suffix match — any other host is still refused.
 */
const ALLOWED_REMOTE_HUB_HOST = (process.env.CMEM_SYNC_E2E_ALLOW_REMOTE_HUB ?? '').trim().toLowerCase();
if (ALLOWED_REMOTE_HUB_HOST && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(ALLOWED_REMOTE_HUB_HOST)) {
  throw new Error('CMEM_SYNC_E2E_ALLOW_REMOTE_HUB must be one exact hostname (no scheme, port, path or wildcard)');
}
const TLS_OF: Record<string, string> = { 'http:': 'https:', 'ws:': 'wss:' };

function guardedUrl(input: RequestInfo | URL, label: string, protocols: string[] = ['http:']): URL {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  const loopback = protocols.includes(url.protocol) && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  const allowedRemote = ALLOWED_REMOTE_HUB_HOST !== '' && url.hostname === ALLOWED_REMOTE_HUB_HOST
    && url.port === '' && protocols.some(protocol => TLS_OF[protocol] === url.protocol);
  if (!loopback && !allowedRemote) {
    throw new Error(`${label} refused non-loopback URL: ${url.origin}`);
  }
  return url;
}

/**
 * The ONE fetch this script makes to the Hub (status, log reads, and every
 * client request via guardedFetch). The URL is guarded, and redirects are
 * never followed: a 3xx could send the request (and its bearer token) to a
 * host outside the one-host boundary, so any 3xx fails the run.
 */
async function hubFetch(input: RequestInfo | URL, init: RequestInit | undefined, label: string): Promise<Response> {
  const url = guardedUrl(input, label);
  const response = await fetch(input, { ...init, redirect: 'manual' });
  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} refused redirect ${response.status} from ${url.origin}${url.pathname} (redirects are never followed)`);
  }
  return response;
}

const hubUrl = (process.env.CMEM_SYNC_E2E_HUB_URL ?? DEFAULT_HUB_URL).trim().replace(/\/+$/, '');
guardedUrl(hubUrl, 'Hub');
if (ALLOWED_REMOTE_HUB_HOST && new URL(hubUrl).hostname !== ALLOWED_REMOTE_HUB_HOST) {
  throw new Error('CMEM_SYNC_E2E_ALLOW_REMOTE_HUB is set but the Hub URL is not on that host');
}
const USER_ID = requiredEnv('CMEM_SYNC_E2E_USER_ID');
const TOKEN = requiredEnv('CMEM_SYNC_E2E_TOKEN');

function authHeaders(deviceId?: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'X-User-Id': USER_ID,
    ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
  };
}

interface HubStatus {
  protocol_version: 2;
  epoch: string;
  head_seq: string;
  projected_seq: string;
  op_count: number;
  device_count: number;
}

async function getHubStatus(): Promise<HubStatus> {
  const response = await hubFetch(`${hubUrl}/v1/sync/status`, { headers: authHeaders() }, 'Hub status');
  if (!response.ok) throw new Error(`Hub status ${response.status}: ${(await response.text()).slice(0, 200)}`);
  invariant(response.headers.get('X-Sync-Mode') === 'poll', 'Hub status carries X-Sync-Mode: poll');
  const status = await response.json() as HubStatus;
  invariant(status.protocol_version === 2, 'Hub status speaks protocol v2');
  assertCanonicalDecimal(status.epoch, { positive: true });
  assertCanonicalDecimal(status.head_seq);
  assertCanonicalDecimal(status.projected_seq);
  return status;
}

interface ChangesPage {
  protocol_version: 2;
  epoch: string;
  ops: Array<{ seq: string; body: string; operation_sha256: string; server_ts: string }>;
  head_seq: string;
  more: boolean;
}

/**
 * Read the whole log as device A (an already-registered identity, so the
 * device count stays two; a since=0 pull never lowers A's server cursor).
 * Asserts the log is dense from 1 and every body is canonical.
 */
async function readWholeLog(): Promise<CanonicalContentBody[]> {
  const bodies: CanonicalContentBody[] = [];
  let since = '0';
  for (;;) {
    const response = await hubFetch(`${hubUrl}/v1/sync/changes?since=${since}&limit=500`, {
      headers: authHeaders(DEVICE_IDS.a),
    }, 'Hub changes');
    if (!response.ok) throw new Error(`Hub changes ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const page = await response.json() as ChangesPage;
    let expected = incrementCanonicalDecimal(since);
    for (const op of page.ops) {
      invariant(op.seq === expected, 'log sequences are dense', { expected, actual: op.seq });
      bodies.push(parseCanonicalOperation({ body: op.body, operation_sha256: op.operation_sha256 }));
      since = op.seq;
      expected = incrementCanonicalDecimal(expected);
    }
    if (!page.more) return bodies;
  }
}

interface NetworkGate {
  pushesOnline: boolean;
  pushAttempts: number;
  pullRequests: number;
  /** /v1/sync/changes requests whose response has not arrived yet. */
  pullsInFlight: number;
  realtimeTokenStatuses: number[];
  /** Every Phoenix frame this device received / sent, with arrival time. */
  received: Array<{ at: number; frame: Record<string, any> }>;
  sent: Array<{ at: number; frame: Record<string, any> }>;
}

/** Bun's WebSocket, loopback-guarded, recording frames for the assertions below. */
function recordingWebSocket(gate: NetworkGate) {
  return class RecordingWebSocket extends WebSocket {
    constructor(url: string) {
      guardedUrl(url, 'Realtime socket', ['ws:']);
      super(url);
      this.addEventListener('message', event => {
        try {
          gate.received.push({ at: Date.now(), frame: JSON.parse(String(event.data)) });
        } catch {
          gate.received.push({ at: Date.now(), frame: { unparsable: String(event.data).slice(0, 200) } });
        }
      });
    }
    override send(data: string): void {
      gate.sent.push({ at: Date.now(), frame: JSON.parse(data) });
      super.send(data);
    }
  };
}

function advanceFrames(gate: NetworkGate, since = 0): Array<{ at: number; frame: Record<string, any> }> {
  return gate.received.filter(entry => entry.at >= since
    && entry.frame.event === 'broadcast' && entry.frame.payload?.event === 'advance');
}

interface Device {
  name: keyof typeof DEVICE_IDS;
  dir: string;
  dbPath: string;
  store: SessionStore;
  cloudSync: CloudSync;
  apply: SyncApply;
  client: SyncClient;
  gate: NetworkGate;
}

function guardedFetch(gate: NetworkGate): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = guardedUrl(input, 'sync client');
    if (url.pathname.endsWith('/v1/sync/ops')) {
      gate.pushAttempts++;
      if (!gate.pushesOnline) throw new Error('simulated offline push transport');
    }
    const isPull = url.pathname.endsWith('/v1/sync/changes');
    if (isPull) {
      gate.pullRequests++;
      gate.pullsInFlight++;
    }
    let response: Response;
    try {
      response = await hubFetch(input, init, 'sync client');
    } finally {
      if (isPull) gate.pullsInFlight--;
    }
    if (url.pathname.endsWith('/v1/sync/realtime-token')) gate.realtimeTokenStatuses.push(response.status);
    return response;
  }) as typeof fetch;
}

function createClient(device: Device): SyncClient {
  return new SyncClient(device.apply, {
    hubUrl,
    token: TOKEN,
    userId: USER_ID,
    deviceId: DEVICE_IDS[device.name],
    deviceName: `Matrix ${device.name.toUpperCase()}`,
    fetchImpl: guardedFetch(device.gate),
    webSocketImpl: recordingWebSocket(device.gate),
    // B only: run near token expiry so the 900 s token is re-minted live.
    ...(device.name === 'b' ? { now: () => Date.now() + B_CLOCK_SKEW_MS } : {}),
    activePollMs: POLL_MS,
    idlePollMs: POLL_MS,
    suspendAfterMs: 3_600_000,
    pageLimit: 2,
    maxPagesPerCycle: 100,
    requestTimeoutMs: 10_000,
    backoffInitialMs: 100,
    backoffMaxMs: 1_000,
    minPullGapMs: 0,
    // Left on as in production: X-Sync-Mode: poll must NOT turn it off.
    wsEnabled: true,
    wsPingIntervalMs: 5_000,
    wsBackoffBaseMs: 50,
    wsBackoffMaxMs: 500,
    onSocketLiveChange: live => device.cloudSync.setFastDebounce(live),
  });
}

function openDevice(
  name: keyof typeof DEVICE_IDS,
  existingDir?: string,
  options: { start?: boolean } = {},
): Device {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), `claude-mem-matrix-supabase-${name}-`));
  const dbPath = join(dir, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const gate: NetworkGate = {
    pushesOnline: true, pushAttempts: 0, pullRequests: 0, pullsInFlight: 0, realtimeTokenStatuses: [], received: [], sent: [],
  };
  const cloudSync = new CloudSync(store.db, {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: USER_ID,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: hubUrl,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE_IDS[name],
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: `Matrix ${name.toUpperCase()}`,
  }, {
    fetchImpl: guardedFetch(gate),
    settingsPath: join(dir, 'settings.json'),
    debounceMs: 50,
    fastDebounceMs: 10,
    backoffInitialMs: 60_000,
    backoffMaxMs: 60_000,
    requestTimeoutMs: 10_000,
  });
  const apply = new SyncApply(store.db, { deviceId: DEVICE_IDS[name] });
  const device = { name, dir, dbPath, store, cloudSync, apply, client: null!, gate } satisfies Device;
  device.client = createClient(device);
  cloudSync.setHeadSeqListener(head => device.client.onHeadSeq(head));
  cloudSync.setSyncModeListener(mode => device.client.onSyncModeHint(mode));
  if (options.start !== false) device.client.start();
  return device;
}

function closeDevice(device: Device, remove: boolean): void {
  device.cloudSync.stop();
  device.client.stop();
  device.store.db.close();
  if (remove) rmSync(device.dir, { recursive: true, force: true });
}

function row<T>(device: Device, sql: string, ...params: unknown[]): T | undefined {
  return device.store.db.prepare(sql).get(...params as never[]) as T | undefined;
}

function count(device: Device, sql: string, ...params: unknown[]): number {
  return row<{ n: number }>(device, sql, ...params)?.n ?? -1;
}

function pending(device: Device): number {
  const value = device.cloudSync.status().pending;
  return value.observations + value.summaries + value.prompts + value.mutations + value.tombstones;
}

function observation(title: string, narrative: string): Parameters<SessionStore['storeObservation']>[2] {
  return {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}

async function pullToHead(device: Device): Promise<void> {
  // pullOnce is single-flight: while the client's own background cycle (for
  // example the pull after its push) is fetching, it returns at once without
  // waiting for that cycle. Retry, bounded, until the cursor reaches the head
  // instead of assuming a second call lands after that cycle.
  const deadline = Date.now() + 10_000;
  await device.client.pullOnce({ timeoutMs: 20_000, force: true });
  let status = await getHubStatus();
  while (device.apply.getCursor() !== status.head_seq && Date.now() < deadline) {
    await Bun.sleep(10);
    await device.client.pullOnce({ timeoutMs: 20_000, force: true });
    status = await getHubStatus();
  }
  check(device.apply.getCursor() === status.head_seq, `${device.name.toUpperCase()} cursor reaches Hub head`, {
    cursor: device.apply.getCursor(),
    head: status.head_seq,
  });
}

/** Until the device has had no pull in flight and started none for 300 ms (bounded). */
async function waitForQuietPulls(device: Device): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastCount = device.gate.pullRequests;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (device.gate.pullsInFlight > 0 || device.gate.pullRequests !== lastCount) {
      lastCount = device.gate.pullRequests;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 300) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${device.name} pulls to go quiet`);
}

/**
 * A flushes one new observation; B must hear the `advance` broadcast and
 * reach the head with no explicit pull (poll tiers are 10 min). Returns
 * flush-start -> advance-frame and flush-start -> cursor-at-head latencies.
 */
async function realtimeDelivery(a: Device, b: Device, title: string): Promise<{ advanceMs: number; convergeMs: number }> {
  // A pull B already has in flight (e.g. the catch-up pull after a (re)join)
  // can be answered after A's push lands and carry the probe, so the advance
  // would then need no pull; over real network latency that race is common.
  // Start only once B's pulls are quiet, so the probe can only reach B
  // through a pull the advance triggered.
  await waitForQuietPulls(b);
  a.store.storeObservation('memory-baseline-a', 'project-baseline', observation(title, 'delivered over Realtime'), 5, 0);
  const startedAt = Date.now();
  const bPullsBefore = b.gate.pullRequests;
  await a.cloudSync.flush();
  invariant(pending(a) === 0, 'A pushed the realtime probe', a.cloudSync.status().lastError);
  const head = (await getHubStatus()).head_seq;
  const matching = () => advanceFrames(b.gate, startedAt).filter(entry => entry.frame.payload?.payload?.head_seq === head);
  await waitFor(() => matching().length > 0, `B hears advance to ${head}`, REALTIME_BUDGET_MS).catch(error => {
    const recent = b.gate.received.filter(entry => entry.at >= startedAt - 5_000)
      .map(entry => ({ dt: entry.at - startedAt, event: entry.frame.event, payload: entry.frame.payload }));
    throw new Error(`${(error as Error).message}; B live=${b.client.isSocketLive()} recent frames=${JSON.stringify(recent)}`);
  });
  await waitFor(() => b.apply.getCursor() === head, `B cursor reaches ${head} without a pull call`, REALTIME_BUDGET_MS);
  const convergeMs = Date.now() - startedAt;
  const advanceMs = matching()[0].at - startedAt;
  check(count(b, 'SELECT COUNT(*) AS n FROM observations WHERE title = ?', title) === 1 && b.gate.pullRequests > bPullsBefore,
    `${title} reached B over Realtime (flush->advance ${advanceMs} ms, flush->B cursor ${convergeMs} ms)`);
  await Bun.sleep(300);
  check(matching().length === 1, 'exactly one advance broadcast for the one push', matching().length);
  return { advanceMs, convergeMs };
}

function reviveObservation(device: Device, id: string, memorySessionId: string): void {
  device.store.db.prepare(`
    INSERT INTO observations
      (id, memory_session_id, project, type, title, subtitle, facts, narrative,
       concepts, files_read, files_modified, prompt_number, discovery_tokens,
       created_at, created_at_epoch)
    VALUES (?, ?, 'project-offline', 'discovery', 'revived-offline', NULL,
      '[]', 'revived after tombstone', '[]', '[]', '[]', 1, 0, ?, ?)
  `).run(id, memorySessionId, new Date().toISOString(), Date.now());
}

async function runMatrix(): Promise<void> {
  console.log(`Sync matrix E2E (Supabase cmem-sync) — account ${USER_ID} at ${hubUrl}`);
  const fresh = await getHubStatus();
  check(
    fresh.head_seq === '0' && fresh.projected_seq === '0' && fresh.op_count === 0 && fresh.device_count === 0,
    'fresh account starts with an empty log and no devices',
    fresh,
  );

  let a = openDevice('a');
  let b = openDevice('b');
  const tempDirs = new Set([a.dir, b.dir]);
  try {
    await waitFor(() => a.apply.getEpoch() === fresh.epoch && b.apply.getEpoch() === fresh.epoch, 'initial epoch adoption');
    await waitFor(() => a.client.isSocketLive() && b.client.isSocketLive(), 'both clients join the Realtime channel');
    check(a.gate.realtimeTokenStatuses[0] === 200 && b.gate.realtimeTokenStatuses[0] === 200,
      'realtime-token answers 200 for both devices', [a.gate.realtimeTokenStatuses, b.gate.realtimeTokenStatuses]);
    check(!a.client.isPollModeOnly() && !b.client.isPollModeOnly() && a.client.isSocketLive() && b.client.isSocketLive(),
      'both real clients joined the private user channel (X-Sync-Mode: poll ignored)');
    const joinReply = b.gate.received.find(entry => entry.frame.event === 'phx_reply' && entry.frame.topic === `realtime:user:${USER_ID}`);
    check(joinReply?.frame.payload?.status === 'ok', 'Realtime acknowledged the private join', joinReply?.frame.payload);

    console.log('\nScenario: canonical content plus set_title and set_prompt_session');
    const sessionA = a.store.createSDKSession(
      'content-baseline-a',
      'project-baseline',
      'baseline request',
      'Baseline Custom Title',
      'claude',
    );
    a.store.saveUserPrompt('content-baseline-a', 1, 'prompt captured before memory id', sessionA);
    await a.cloudSync.flush();
    a.store.updateMemorySessionId(sessionA, 'memory-baseline-a');
    const baseline = a.store.storeObservation(
      'memory-baseline-a',
      'project-baseline',
      observation('baseline-observation', 'baseline canonical narrative'),
      1,
      7,
    );
    a.store.storeSummary('memory-baseline-a', 'project-baseline', {
      request: 'summarize baseline',
      investigated: 'canonical flow',
      learned: 'protocol v2',
      completed: 'baseline complete',
      next_steps: 'continue matrix',
      notes: null,
    }, 1);
    await a.cloudSync.flush();
    await pullToHead(b);
    check(
      row<{ custom_title: string | null }>(b, "SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'memory-baseline-a'")?.custom_title
        === 'Baseline Custom Title',
      'set_title converges on the second client',
    );
    const repairedPrompt = row<{ memory_session_id: string | null }>(b, `
      SELECT s.memory_session_id
      FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id
      WHERE p.prompt_text = 'prompt captured before memory id'
    `);
    check(repairedPrompt?.memory_session_id === 'memory-baseline-a', 'set_prompt_session repairs the early prompt');
    check(count(b, "SELECT COUNT(*) AS n FROM session_summaries WHERE origin_device_id = ?", DEVICE_IDS.a) === 1,
      'summary content replicates through canonical protocol v2');

    console.log('\nScenario: live delivery over Supabase Realtime (no pull call, 10 min poll tiers)');
    const firstDelivery = await realtimeDelivery(a, b, 'realtime-delivery-1');
    const advance = advanceFrames(b.gate).at(-1)!.frame.payload.payload as Record<string, unknown>;
    check(advance.type === 'advance' && advance.epoch === fresh.epoch && DECIMAL.test(String(advance.head_seq)),
      'advance payload carries type/epoch/head_seq (extra fields ignored)', advance);
    check(a.client.isSocketLive() && b.client.isSocketLive(), 'both sockets stay live after the broadcast');

    console.log('\nScenario: live token refresh on the open channel');
    await waitFor(() => b.gate.sent.some(entry => entry.frame.event === 'access_token'), 'B re-mints and sends access_token', 15_000);
    const refresh = b.gate.sent.find(entry => entry.frame.event === 'access_token')!;
    check(typeof refresh.frame.payload?.access_token === 'string' && refresh.frame.topic === `realtime:user:${USER_ID}`,
      'B handed a fresh token to the open channel (access_token frame)');
    check(b.gate.realtimeTokenStatuses.filter(status => status === 200).length >= 2,
      'refresh minted a second token via realtime-token', b.gate.realtimeTokenStatuses);
    await Bun.sleep(500);
    const refreshReply = b.gate.received.find(entry => entry.at >= refresh.at && entry.frame.ref === refresh.frame.ref);
    check(refreshReply === undefined || refreshReply.frame.payload?.status !== 'error',
      'Realtime did not refuse the refreshed token', refreshReply?.frame.payload);
    check(b.client.isSocketLive() && !b.gate.received.some(entry => entry.at >= refresh.at
      && (entry.frame.event === 'phx_error' || entry.frame.event === 'phx_close'
        || (entry.frame.event === 'system' && entry.frame.payload?.status === 'error'))),
      'channel survives the token refresh without a reconnect');
    const secondDelivery = await realtimeDelivery(a, b, 'realtime-delivery-after-refresh');
    console.log(`  INFO  realtime latency: flush->advance ${firstDelivery.advanceMs} / ${secondDelivery.advanceMs} ms, `
      + `flush->B cursor ${firstDelivery.convergeMs} / ${secondDelivery.convergeMs} ms (poll tier ${POLL_MS} ms)`);

    console.log('\nScenario: authoritative HTTP path (no advisory lane)');
    b.gate.pullRequests = 0;
    a.store.storeObservation(
      'memory-baseline-a',
      'project-baseline',
      observation('http-authoritative-observation', 'must arrive by cursor pull'),
      3,
      0,
    );
    await a.cloudSync.flush();
    await pullToHead(b);
    check(count(b, "SELECT COUNT(*) AS n FROM observations WHERE title = 'http-authoritative-observation'") === 1,
      'authoritative HTTP cursor pull converges without WebSocket');
    check(b.gate.pullRequests > 0, 'HTTP correctness uses /v1/sync/changes');

    console.log('\nScenario: restart with durable cursor');
    const persistedCursor = b.apply.getCursor();
    const bDir = b.dir;
    closeDevice(b, false);
    b = openDevice('b', bDir, { start: false });
    check(b.apply.getCursor() === persistedCursor, 'client restart preserves the decimal cursor', {
      before: persistedCursor,
      after: b.apply.getCursor(),
    });
    b.client.start();
    await pullToHead(b);
    await waitFor(() => b.client.isSocketLive(), 'B rejoins Realtime after restart');
    check(b.client.isSocketLive(), 'restarted client is live again');
    await realtimeDelivery(a, b, 'realtime-delivery-after-restart');

    console.log('\nScenario: concurrent two-client writes');
    const sessionConcurrentA = a.store.createSDKSession('content-concurrent-a', 'project-concurrent', 'A concurrent');
    a.store.updateMemorySessionId(sessionConcurrentA, 'memory-concurrent-a');
    const sessionConcurrentB = b.store.createSDKSession('content-concurrent-b', 'project-concurrent', 'B concurrent');
    b.store.updateMemorySessionId(sessionConcurrentB, 'memory-concurrent-b');
    a.store.storeObservation('memory-concurrent-a', 'project-concurrent', observation('concurrent-a', 'written by A'), 1, 0);
    b.store.storeObservation('memory-concurrent-b', 'project-concurrent', observation('concurrent-b', 'written by B'), 1, 0);
    await Promise.all([a.cloudSync.flush(), b.cloudSync.flush()]);
    await Promise.all([a.cloudSync.flush(), b.cloudSync.flush()]);
    await Promise.all([pullToHead(a), pullToHead(b)]);
    for (const device of [a, b]) {
      check(count(device, "SELECT COUNT(*) AS n FROM observations WHERE title IN ('concurrent-a','concurrent-b')") === 2,
        `${device.name.toUpperCase()} converges both concurrent writes exactly once`);
      check(pending(device) === 0, `${device.name.toUpperCase()} concurrent queue drains`);
    }

    console.log('\nScenario: offline push retry');
    const offline = a.store.storeObservation(
      'memory-baseline-a',
      'project-offline',
      observation('offline-retry-observation', 'queued while transport is offline'),
      4,
      0,
    );
    a.gate.pushesOnline = false;
    await a.cloudSync.flush();
    check(a.cloudSync.status().lastError?.includes('simulated offline push transport') === true,
      'offline failure is surfaced without losing the row');
    check(pending(a) > 0, 'offline write remains queued for retry');
    a.gate.pushesOnline = true;
    await a.cloudSync.flush();
    check(pending(a) === 0 && a.cloudSync.status().lastError === null, 'online retry drains the same durable queue');
    await pullToHead(b);
    check(count(b, "SELECT COUNT(*) AS n FROM observations WHERE title = 'offline-retry-observation'") === 1,
      'retried offline write converges on B');

    console.log('\nScenario: remap_project mutation');
    a.store.db.transaction(() => {
      emitRemapProject(a.store.db, { memory_session_id: 'memory-baseline-a' }, { project: 'project-remapped' });
    })();
    await a.cloudSync.flush();
    await pullToHead(b);
    check(
      count(b, "SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = 'memory-baseline-a' AND project = 'project-remapped'") >= 1,
      'remap_project converges matching content',
    );

    console.log('\nScenario: delete then higher-revision revive');
    const offlineId = String(offline.id);
    const entityId = stableDocumentId('observation', DEVICE_IDS.a, offlineId);
    const deleteRev = a.cloudSync.queueDelete('observation', offlineId, '2026-07-20T12:00:00.000Z');
    await a.cloudSync.flush();
    await pullToHead(b);
    check(count(b, 'SELECT COUNT(*) AS n FROM observations WHERE origin_device_id = ? AND origin_local_id = ?', DEVICE_IDS.a, offlineId) === 0,
      'tombstone deletes the replica');
    const deletedHead = row<{ entity_rev: string; deleted: number }>(b,
      'SELECT entity_rev, deleted FROM sync_entity_heads WHERE entity_id = ?', entityId);
    check(deletedHead?.deleted === 1 && deletedHead.entity_rev === deleteRev, 'delete advances the entity head', deletedHead);

    reviveObservation(a, offlineId, 'memory-baseline-a');
    await a.cloudSync.flush();
    await pullToHead(b);
    const revived = row<{ title: string; sync_rev: string }>(b, `
      SELECT title, CAST(sync_rev AS TEXT) AS sync_rev
      FROM observations WHERE origin_device_id = ? AND origin_local_id = ?
    `, DEVICE_IDS.a, offlineId);
    check(revived?.title === 'revived-offline', 'higher-revision live body revives the deleted entity', revived);
    check(revived !== undefined && compareCanonicalDecimals(revived.sync_rev, deleteRev) > 0,
      'revive revision is strictly greater than the tombstone', { deleteRev, revived: revived?.sync_rev });

    await Promise.all([pullToHead(a), pullToHead(b)]);
    const finalStatus = await getHubStatus();
    check(typeof a.apply.getCursor() === 'string' && DECIMAL.test(a.apply.getCursor()), 'A cursor remains a decimal string');
    check(typeof b.apply.getCursor() === 'string' && DECIMAL.test(b.apply.getCursor()), 'B cursor remains a decimal string');
    check(finalStatus.head_seq.length >= 2, 'matrix crosses a multi-digit decimal Hub sequence', finalStatus.head_seq);
    check(a.apply.getCursor() === finalStatus.head_seq && b.apply.getCursor() === finalStatus.head_seq,
      'both decimal cursors equal the authoritative head');
    check(finalStatus.projected_seq === finalStatus.head_seq, 'projected_seq === head_seq (read model written in the push transaction)');
    check(finalStatus.device_count === 2, 'exactly two real device identities touched the Hub', finalStatus.device_count);

    const bodies = await readWholeLog();
    check(String(bodies.length) === finalStatus.head_seq, 'the whole log is dense, canonical, and ends at head', {
      ops: bodies.length,
      head: finalStatus.head_seq,
    });
    const kinds = new Set(bodies.map(body => body.kind));
    const mutations = new Set(bodies
      .filter(body => body.kind === 'mutation')
      .map(body => (body.mutation as { op?: unknown } | null)?.op));
    check(['observation', 'summary', 'prompt', 'mutation'].every(kind => kinds.has(kind as CanonicalContentBody['kind'])),
      'log carries every canonical content kind', [...kinds]);
    check(['set_title', 'set_prompt_session', 'remap_project'].every(op => mutations.has(op)),
      'log carries all required mutation kinds', [...mutations]);
    const lifecycle = bodies.filter(body => body.id === entityId);
    check(lifecycle.some(body => body.deleted) && lifecycle.some(body => !body.deleted && compareCanonicalDecimals(body.entity_rev, deleteRev) > 0),
      'log holds both tombstone and higher-revision revive');

    const [statusA, statusB] = await Promise.all([
      a.cloudSync.statusWithHubProbe(),
      b.cloudSync.statusWithHubProbe(),
    ]);
    check(statusA.hub.reachable === true && statusB.hub.reachable === true,
      'both empty-queue status checks authenticate against Hub');
    check(pending(a) === 0 && pending(b) === 0, 'both clients finish with empty durable queues');
    check(String(baseline.id) !== offlineId, 'delete/revive reused only its intended stable local id');
  } finally {
    for (const device of [a, b]) {
      try {
        closeDevice(device, false);
      } catch (cleanupError) {
        // The other device and temp dirs still need cleaning; say what failed.
        console.error(`cleanup: closing ${device.dir} failed:`, cleanupError);
      }
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}

await runMatrix().then(
  () => console.log('\nMATRIX RESULT: ALL CHECKS PASSED'),
  error => {
    console.error('Matrix harness error:', error);
    process.exitCode = 1;
  },
);
