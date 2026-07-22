#!/usr/bin/env bun
/**
 * Canonical protocol-v2 sync E2E.
 *
 * Safety is structural: a Bun loopback sidecar owns token verification and
 * projection, while the existing Node Miniflare wrapper starts the actual
 * bundled Worker and SQLite Durable Object on an ephemeral loopback port.
 * Every client fetch is guarded as loopback-only. Exactly two real client
 * stacks (SessionStore + CloudSync + SyncApply + SyncClient) exercise both
 * the advisory WebSocket and authoritative HTTP lanes.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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

const HUB_DIR = resolve(import.meta.dir, '../workers/sync-hub');
const HUB_RUNNER = resolve(HUB_DIR, 'test/run-miniflare-pro-e2e.mjs');
const USER_ID = `matrix-user-${crypto.randomUUID()}`;
const TOKEN = `matrix-token-${crypto.randomUUID()}`;
const PROJECTOR_SECRET = 'matrix-projector-secret-32-characters-minimum';
const DEVICE_IDS = { a: 'matrix-device-a', b: 'matrix-device-b' } as const;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const CHILD_ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'] as const;

function childEnvironment(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      error => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function loopbackUrl(input: RequestInfo | URL, label: string): URL {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error(`${label} refused non-loopback URL: ${url.origin}`);
  }
  return url;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} uses the exact wire envelope`,
    { actual, wanted },
  );
}

interface ProjectionWireOp {
  seq: string;
  body: string;
  operation_sha256: string;
}

interface ProjectionRequest {
  protocol_version: number;
  user_id: string;
  epoch: string;
  from_seq_exclusive: string;
  through_seq: string;
  ops: ProjectionWireOp[];
}

interface SidecarState {
  verifyCalls: number;
  projectionCalls: ProjectionRequest[];
  projectedThrough: string;
  epoch: string | null;
  bodies: CanonicalContentBody[];
  errors: string[];
}

function startSidecar(): { server: ReturnType<typeof Bun.serve>; state: SidecarState; baseUrl: string } {
  const state: SidecarState = {
    verifyCalls: 0,
    projectionCalls: [],
    projectedThrough: '0',
    epoch: null,
    bodies: [],
    errors: [],
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      try {
        const url = loopbackUrl(request, 'sidecar');
        if (url.pathname === '/verify') {
          state.verifyCalls++;
          if (
            request.method !== 'GET'
            || request.headers.get('Authorization') !== `Bearer ${TOKEN}`
            || request.headers.get('X-User-Id') !== USER_ID
          ) {
            return Response.json({ error: 'denied' }, { status: 401 });
          }
          return Response.json({ userId: USER_ID });
        }
        if (url.pathname === '/project') {
          if (
            request.method !== 'POST'
            || request.headers.get('Authorization') !== `Bearer ${PROJECTOR_SECRET}`
          ) {
            return Response.json({ error: 'denied' }, { status: 401 });
          }
          const value = await request.json();
          invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'projector receives an object');
          const payload = value as ProjectionRequest;
          exactKeys(
            payload as unknown as Record<string, unknown>,
            ['protocol_version', 'user_id', 'epoch', 'from_seq_exclusive', 'through_seq', 'ops'],
            'projection request',
          );
          invariant(payload.protocol_version === 1, 'projection protocol is v1');
          invariant(payload.user_id === USER_ID, 'projection is bound to the fresh test account');
          assertCanonicalDecimal(payload.epoch, { positive: true });
          assertCanonicalDecimal(payload.from_seq_exclusive);
          assertCanonicalDecimal(payload.through_seq, { positive: true });
          invariant(Array.isArray(payload.ops) && payload.ops.length > 0, 'projection page contains operations');
          invariant(payload.from_seq_exclusive === state.projectedThrough, 'projection pages start at the checkpoint', {
            from: payload.from_seq_exclusive,
            checkpoint: state.projectedThrough,
          });
          if (state.epoch === null) state.epoch = payload.epoch;
          invariant(payload.epoch === state.epoch, 'projection epoch remains stable');

          let expected = incrementCanonicalDecimal(payload.from_seq_exclusive);
          const parsedBodies: CanonicalContentBody[] = [];
          for (const op of payload.ops) {
            exactKeys(op as unknown as Record<string, unknown>, ['seq', 'body', 'operation_sha256'], 'projection op');
            invariant(op.seq === expected, 'projection sequences are contiguous', { expected, actual: op.seq });
            parsedBodies.push(parseCanonicalOperation({ body: op.body, operation_sha256: op.operation_sha256 }));
            expected = incrementCanonicalDecimal(expected);
          }
          invariant(payload.ops.at(-1)?.seq === payload.through_seq, 'projection through_seq matches the last operation');
          state.projectionCalls.push(payload);
          state.bodies.push(...parsedBodies);
          state.projectedThrough = payload.through_seq;
          return Response.json({
            protocol_version: 1,
            epoch: payload.epoch,
            projected_through_seq: payload.through_seq,
          });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.errors.push(message);
        return Response.json({ error: message }, { status: 500 });
      }
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  loopbackUrl(baseUrl, 'sidecar');
  return { server, state, baseUrl };
}

interface HubRuntime {
  proc: ReturnType<typeof Bun.spawn>;
  events: Array<Record<string, unknown>>;
  stdoutDone: Promise<void>;
  stderrDone: Promise<string>;
}

let hubRuntime: HubRuntime | null = null;
let hubUrl = '';

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    buffered += decoder.decode(result.value, { stream: true });
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) onLine(buffered.trim());
}

async function startHub(sidecarUrl: string): Promise<void> {
  loopbackUrl(sidecarUrl, 'Hub sidecar binding');
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const proc = Bun.spawn([
    'node',
    HUB_RUNNER,
    '--worker-root', HUB_DIR,
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: HUB_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnvironment({
      INTERNAL_PROJECTOR_URL: `${sidecarUrl}/project`,
      TOKEN_VERIFY_URL: `${sidecarUrl}/verify`,
      CMEM_INTERNAL_PROJECTOR_SECRET: PROJECTOR_SECRET,
    }),
  });
  const events: Array<Record<string, unknown>> = [];
  const stdoutDone = readLines(proc.stdout as ReadableStream<Uint8Array>, line => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      if (event.event === 'ready' && typeof event.url === 'string') resolveReady(event.url);
    } catch {
      // Miniflare dependency output is diagnostic only; ready/stopped are JSON.
    }
  }).catch(error => rejectReady(error));
  const stderrDone = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  hubRuntime = { proc, events, stdoutDone, stderrDone };
  const earlyExit = proc.exited.then(async code => {
    const stderr = await stderrDone;
    throw new Error(`Miniflare Hub exited before ready (${code}): ${stderr.slice(0, 500)}`);
  });
  hubUrl = (await withTimeout(Promise.race([ready, earlyExit]), 30_000, 'Miniflare Hub ready')).replace(/\/$/, '');
  loopbackUrl(hubUrl, 'Hub');
}

async function stopHub(): Promise<void> {
  const runtime = hubRuntime;
  if (!runtime) return;
  hubRuntime = null;
  runtime.proc.kill(15);
  let code: number;
  try {
    code = await withTimeout(runtime.proc.exited, 10_000, 'clean Miniflare shutdown');
  } catch (error) {
    runtime.proc.kill(9);
    await runtime.proc.exited;
    throw error;
  }
  await runtime.stdoutDone;
  const stderr = await runtime.stderrDone;
  check(code === 0, 'Miniflare wrapper exits cleanly', { code, stderr: stderr.slice(0, 500) });
  check(runtime.events.some(event => event.event === 'stopped'), 'Miniflare disposes the Worker and Durable Object');
}

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
  loopbackUrl(hubUrl, 'Hub status');
  const response = await fetch(`${hubUrl}/v1/sync/status`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`Hub status ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const status = await response.json() as HubStatus;
  invariant(status.protocol_version === 2, 'Hub status speaks protocol v2');
  assertCanonicalDecimal(status.epoch, { positive: true });
  assertCanonicalDecimal(status.head_seq);
  assertCanonicalDecimal(status.projected_seq);
  return status;
}

interface NetworkGate {
  pushesOnline: boolean;
  pushAttempts: number;
  pullRequests: number;
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
    const url = loopbackUrl(input, 'sync client');
    if (url.pathname === '/v1/sync/ops') {
      gate.pushAttempts++;
      if (!gate.pushesOnline) throw new Error('simulated offline push transport');
    }
    if (url.pathname === '/v1/sync/changes') gate.pullRequests++;
    return fetch(input, init);
  }) as typeof fetch;
}

function createClient(device: Device, wsEnabled: boolean): SyncClient {
  return new SyncClient(device.apply, {
    hubUrl,
    token: TOKEN,
    userId: USER_ID,
    deviceId: DEVICE_IDS[device.name],
    deviceName: `Matrix ${device.name.toUpperCase()}`,
    fetchImpl: guardedFetch(device.gate),
    activePollMs: 60_000,
    idlePollMs: 60_000,
    suspendAfterMs: 600_000,
    pageLimit: 2,
    maxPagesPerCycle: 100,
    requestTimeoutMs: 10_000,
    backoffInitialMs: 100,
    backoffMaxMs: 1_000,
    minPullGapMs: 0,
    wsEnabled,
    wsPingIntervalMs: 5_000,
    wsBackoffBaseMs: 50,
    wsBackoffMaxMs: 500,
    onSocketLiveChange: live => device.cloudSync.setFastDebounce(live),
  });
}

function openDevice(
  name: keyof typeof DEVICE_IDS,
  existingDir?: string,
  options: { wsEnabled?: boolean; start?: boolean } = {},
): Device {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), `claude-mem-matrix-${name}-`));
  const dbPath = join(dir, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const gate: NetworkGate = { pushesOnline: true, pushAttempts: 0, pullRequests: 0 };
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
  device.client = createClient(device, options.wsEnabled ?? true);
  cloudSync.setHeadSeqListener(head => device.client.onHeadSeq(head));
  cloudSync.setSyncModeListener(mode => device.client.onSyncModeHint(mode));
  if (options.start !== false) device.client.start();
  return device;
}

function replaceClient(device: Device, wsEnabled: boolean, start: boolean): void {
  device.client.stop();
  device.cloudSync.setFastDebounce(false);
  device.client = createClient(device, wsEnabled);
  if (start) device.client.start();
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
  await device.client.pullOnce({ timeoutMs: 20_000, force: true });
  const status = await getHubStatus();
  if (device.apply.getCursor() !== status.head_seq) {
    await device.client.pullOnce({ timeoutMs: 20_000, force: true });
  }
  check(device.apply.getCursor() === status.head_seq, `${device.name.toUpperCase()} cursor reaches Hub head`, {
    cursor: device.apply.getCursor(),
    head: status.head_seq,
  });
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

async function runMatrix(sidecar: SidecarState): Promise<void> {
  console.log(`Sync matrix E2E — fresh account ${USER_ID}`);
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
    await waitFor(() => a.client.isSocketLive() && b.client.isSocketLive(), 'both advisory sockets');
    await waitFor(() => a.apply.getEpoch() === fresh.epoch && b.apply.getEpoch() === fresh.epoch, 'initial epoch adoption');
    check(true, 'both real clients connect their advisory WebSockets');

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

    console.log('\nScenario: WebSocket hint path and authoritative HTTP path');
    await Bun.sleep(100);
    b.gate.pullRequests = 0;
    a.store.storeObservation(
      'memory-baseline-a',
      'project-baseline',
      observation('websocket-only-observation', 'delivered by advisory frame'),
      2,
      0,
    );
    await a.cloudSync.flush();
    await waitFor(
      () => count(b, "SELECT COUNT(*) AS n FROM observations WHERE title = 'websocket-only-observation'") === 1,
      'WebSocket delivery to B',
    );
    check(b.gate.pullRequests === 0, 'advisory WebSocket applies a contiguous frame without an HTTP pull', b.gate);

    replaceClient(b, false, false);
    b.gate.pullRequests = 0;
    a.store.storeObservation(
      'memory-baseline-a',
      'project-baseline',
      observation('http-authoritative-observation', 'must arrive by cursor pull'),
      3,
      0,
    );
    await a.cloudSync.flush();
    await Bun.sleep(100);
    check(count(b, "SELECT COUNT(*) AS n FROM observations WHERE title = 'http-authoritative-observation'") === 0,
      'HTTP-only client has no advisory delivery');
    await b.client.pullOnce({ timeoutMs: 20_000, force: true });
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
    await waitFor(() => b.client.isSocketLive(), 'B WebSocket after restart');
    check(true, 'restarted client reconnects the advisory lane');

    console.log('\nScenario: concurrent two-client writes');
    const sessionConcurrentA = a.store.createSDKSession('content-concurrent-a', 'project-concurrent', 'A concurrent');
    a.store.updateMemorySessionId(sessionConcurrentA, 'memory-concurrent-a');
    const sessionConcurrentB = b.store.createSDKSession('content-concurrent-b', 'project-concurrent', 'B concurrent');
    b.store.updateMemorySessionId(sessionConcurrentB, 'memory-concurrent-b');
    a.store.storeObservation('memory-concurrent-a', 'project-concurrent', observation('concurrent-a', 'written by A'), 1, 0);
    b.store.storeObservation('memory-concurrent-b', 'project-concurrent', observation('concurrent-b', 'written by B'), 1, 0);
    await Promise.all([a.cloudSync.flush(), b.cloudSync.flush()]);
    // A simultaneous projector lease can deliberately refuse one drain as
    // busy. Once the successful request releases it, both real queues retry.
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
    check(finalStatus.projected_seq === finalStatus.head_seq, 'Hub checkpoint equals head');
    check(sidecar.projectedThrough === finalStatus.head_seq, 'loopback projector checkpoint equals Hub head');
    check(finalStatus.device_count === 2, 'exactly two real device identities touched the Hub', finalStatus.device_count);
    check(sidecar.errors.length === 0, 'loopback verifier/projector recorded no contract errors', sidecar.errors);
    check(sidecar.verifyCalls > 0 && sidecar.projectionCalls.length > 0, 'real Hub used both loopback sidecar routes');

    const kinds = new Set(sidecar.bodies.map(body => body.kind));
    const mutations = new Set(sidecar.bodies
      .filter(body => body.kind === 'mutation')
      .map(body => (body.mutation as { op?: unknown } | null)?.op));
    check(['observation', 'summary', 'prompt', 'mutation'].every(kind => kinds.has(kind as CanonicalContentBody['kind'])),
      'projector receives every canonical content kind', [...kinds]);
    check(['set_title', 'set_prompt_session', 'remap_project'].every(op => mutations.has(op)),
      'projector receives all required mutation kinds', [...mutations]);
    const lifecycle = sidecar.bodies.filter(body => body.id === entityId);
    check(lifecycle.some(body => body.deleted) && lifecycle.some(body => !body.deleted && compareCanonicalDecimals(body.entity_rev, deleteRev) > 0),
      'projector observes both tombstone and higher-revision revive');

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
      try { closeDevice(device, false); } catch { /* cleanup continues */ }
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const sidecar = startSidecar();
  let failure: unknown = null;
  try {
    await startHub(sidecar.baseUrl);
    await runMatrix(sidecar.state);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopHub();
    } catch (error) {
      failure ??= error;
    }
    try {
      await sidecar.server.stop(true);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  console.log('\nMATRIX RESULT: ALL CHECKS PASSED');
}

await main().catch(error => {
  console.error('Matrix harness error:', error);
  process.exitCode = 1;
});
