#!/usr/bin/env bun
/**
 * Canonical protocol-v2 sync E2E.
 *
 * Safety is structural: a Bun loopback sidecar owns token verification and
 * projection, while services/sync-api starts the protocol-v2 hub on an
 * ephemeral loopback port against local Postgres. Every client fetch is
 * guarded as loopback-only. Three real client stacks, including a hosted-viewer replica, (SessionStore +
 * CloudSync + SyncApply + SyncClient) exercise the authoritative HTTP lane.
 * services/sync-api has no Supabase Realtime (POST /v1/sync/realtime-token
 * answers 404), so the clients — live updates left enabled as in production —
 * must fall back to HTTP polling and stay correct there.
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
import { openMatrixViewer, runViewerBrowsers, type MatrixViewer } from './sync-matrix-viewer.js';
import { groupIdFor } from '../src/services/work-view/request-groups.mjs';
import { focusAreaRowFields, placementRowFields } from '../src/services/work-view/my-focus.mjs';
import { upsertToolUse } from '../src/services/sqlite/tool-uses.js';
import { SyncConflictRecovery, initializeConflictRecoverySchema } from '../src/services/sync/SyncConflictRecovery.js';


const SYNC_API_DIR = resolve(import.meta.dir, '../services/sync-api');
const SYNC_API_ENTRY = resolve(SYNC_API_DIR, 'src/index.ts');
const USER_ID = `matrix-user-${crypto.randomUUID()}`;
const TOKEN = `matrix-token-${crypto.randomUUID()}`;
const PROJECTOR_SECRET = 'matrix-projector-secret-32-characters-minimum';
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/sync_api_test';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname)) {
  throw new Error('sync matrix refuses non-loopback PostgreSQL');
}
const DEVICE_IDS = { a: 'matrix-device-a', b: 'matrix-device-b', c: 'matrix-device-c' } as const;
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

async function startHub(sidecarUrl: string, port = '0'): Promise<void> {
  loopbackUrl(sidecarUrl, 'Hub sidecar binding');
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const proc = Bun.spawn([
    'bun',
    'run',
    SYNC_API_ENTRY,
  ], {
    cwd: SYNC_API_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnvironment({
      DATABASE_URL,
      HOST: '127.0.0.1',
      PORT: port,
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
      // Non-JSON process output is diagnostic only; ready/stopped are JSON.
    }
  }).catch(error => rejectReady(error));
  const stderrDone = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  hubRuntime = { proc, events, stdoutDone, stderrDone };
  const earlyExit = proc.exited.then(async code => {
    const stderr = await stderrDone;
    throw new Error(`sync-api exited before ready (${code}): ${stderr.slice(0, 500)}`);
  });
  hubUrl = (await withTimeout(Promise.race([ready, earlyExit]), 30_000, 'sync-api ready')).replace(/\/$/, '');
  loopbackUrl(hubUrl, 'Hub');
}

async function stopHub(): Promise<void> {
  const runtime = hubRuntime;
  if (!runtime) return;
  hubRuntime = null;
  runtime.proc.kill(15);
  let code: number;
  try {
    code = await withTimeout(runtime.proc.exited, 10_000, 'clean sync-api shutdown');
  } catch (error) {
    runtime.proc.kill(9);
    await runtime.proc.exited;
    throw error;
  }
  await runtime.stdoutDone;
  const stderr = await runtime.stderrDone;
  check(code === 0, 'sync-api exits cleanly', { code, stderr: stderr.slice(0, 500) });
  check(runtime.events.some(event => event.event === 'stopped'), 'sync-api reports stopped');
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
  pullsOnline: boolean;
  pushAttempts: number;
  pullRequests: number;
}

interface Device {
  name: keyof typeof DEVICE_IDS;
  deviceId: string;
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
    if (url.pathname === '/v1/sync/changes') {
      gate.pullRequests++;
      if (!gate.pullsOnline) throw new Error('simulated offline pull transport');
    }
    return fetch(input, { ...init, redirect: 'error' });
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
    activePollMs: device.name === 'c' ? 30_000 : 60_000,
    idlePollMs: device.name === 'c' ? 30_000 : 60_000,
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
  const gate: NetworkGate = { pushesOnline: true, pullsOnline: true, pushAttempts: 0, pullRequests: 0 };
  const cloudSync = new CloudSync(store.db, {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: USER_ID,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: hubUrl,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE_IDS[name],
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: `Matrix ${name.toUpperCase()}`,
    CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'true',
  }, {
    fetchImpl: guardedFetch(gate),
    settingsPath: join(dir, 'settings.json'),
    debounceMs: 50,
    contentBatchSize: 2,
    fastDebounceMs: 10,
    backoffInitialMs: 60_000,
    backoffMaxMs: 60_000,
    requestTimeoutMs: 10_000,
  });
  const apply = new SyncApply(store.db, { deviceId: DEVICE_IDS[name] });
  const device = { name, deviceId: DEVICE_IDS[name], dir, dbPath, store, cloudSync, apply, client: null!, gate } satisfies Device;
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
  return value.observations + value.summaries + value.prompts + value.workState + value.mutations + value.tombstones;
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


async function waitForAsync(condition: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function drainDevice(device: Device): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    await device.cloudSync.flush();
    if (pending(device) === 0) return;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`Device ${device.name} retained pending work: ${JSON.stringify(device.cloudSync.status())}`);
}

async function runViewerMatrix(a: Device, b: Device, c: Device, viewers: MatrixViewer[], sidecar: SidecarState, sidecarUrl: string) {
  console.log('\nScenario: three replicas, shared My Work and authenticated hosted gate');
  await pullToHead(c);
  const local = await openMatrixViewer(a, false, USER_ID); viewers.push(local);
  const middle = await openMatrixViewer(b, false, USER_ID); viewers.push(middle);
  const hosted = await openMatrixViewer(c, true, USER_ID); viewers.push(hosted);
  check((await hosted.malformedGrant())?.status === 403, 'hosted gate rejects a malformed grant');
  check((await fetch(`${hosted.origin}/api/work-view`)).status === 401, 'hosted viewer refuses anonymous API reads');
  check((await hosted.request('/api/work-state', {})).status === 403, 'hosted gate refuses generic writes');

  // Native padding makes each replica allocate different numeric ids. Identity
  // must still follow origin refs through the actual HTTP canonical stream.
  for (const [device, size] of [[b, 3], [c, 7]] as const) for (let i = 0; i < size; i++) {
    device.store.appendWorkStateEntry({ project: 'matrix-padding', listName: `padding-${i}`, fields: {} });
  }
  const key = (id: string) => JSON.stringify(['conversation', 'claude', id]);
  const anchor = key('matrix-view-main'), companion = key('matrix-view-companion'), groupId = groupIdFor(anchor);
  // Copy record-progress's persisted shape, including its bounded reading history.
  const progressEntry = (percent: number, summary: string) => {
    const at = new Date().toISOString();
    return { groupId, state: percent === 100 ? 'shipped' : 'in-progress', percent, summary,
      checkedAt: at, changedAt: at, startedAt: null, shippedAt: percent === 100 ? at : null,
      lastActivityAt: at, narrative: '', milestones: [], preferences: [], outcome: null, evidence: [],
      reviewedThrough: at, reviewedConversations: [anchor, companion], readings: [{ at, percent }] };
  };
  const sessions = ['main', 'companion'].map(name => {
    const content = `matrix-view-${name}`, memory = `matrix-memory-${name}`;
    const id = a.store.createSDKSession(content, 'matrix-view', name === 'main' ? 'Ship shared viewer' : 'Polish shared viewer', undefined, 'claude');
    a.store.updateMemorySessionId(id, memory); a.store.saveUserPrompt(content, 1, `Matrix ${name} request`, id);
    return { id, content, memory };
  });
  const fields = { task: 'Build shared viewer', status: 'doing' };
  const workId = a.store.appendWorkStateEntry({ project: 'matrix-view', listName: 'matrix-work', fields });
  upsertToolUse(a.store.db, { toolUseId: 'matrix-work-write', contentSessionId: sessions[0].content,
    sessionDbId: sessions[0].id, memorySessionId: sessions[0].memory, project: 'matrix-view', platformSource: 'claude',
    toolName: 'work_state_write', toolInput: JSON.stringify({ list: 'matrix-work', fields }), createdAtEpoch: Date.now() });
  upsertToolUse(a.store.db, { toolUseId: 'matrix-publish', contentSessionId: sessions[0].content,
    sessionDbId: sessions[0].id, memorySessionId: sessions[0].memory, project: 'matrix-view', platformSource: 'claude',
    toolName: 'Bash', toolInput: JSON.stringify({ command: 'gh pr create' }),
    toolResponse: JSON.stringify({ gitOperation: { pr: { url: 'http://github.com/example/repo/pull/42' } } }), createdAtEpoch: Date.now() });
  local.shared.saveFile('request-groups.json', { version: 1, updatedAt: null,
    groups: { [groupId]: { title: 'Matrix shared viewer', anchor, projectRoot: 'matrix-view' } },
    conversations: { [anchor]: groupId, [companion]: groupId }, ignored: {}, suggestions: { [key('content-baseline-a')]: { requestId: groupId, confidence: 0.7, evidence: 'A candidate for owner review.', status: 'open' } } });
  local.shared.saveFile(`progress/${groupId}.json`, progressEntry(60, 'Shared progress across devices.'));
  local.shared.saveFile('story.json', { narrative: 'Deliver a consistent viewer.', preferences: [{ preference: 'Show remaining work clearly.', kind: 'directive', supportCount: 2, quotes: [] }] });
  a.store.appendWorkStateEntry({ project: 'matrix-view', listName: 'my-focus', fields: focusAreaRowFields({
    focusAreaId: 'matrix-focus', name: 'Viewer reliability', goal: 'Keep devices consistent', status: 'kept', source: 'owner', decidedBy: 'owner' }) });
  a.store.appendWorkStateEntry({ project: 'matrix-view', listName: 'my-focus', fields: placementRowFields({
    anchorConversationKey: anchor, focusAreaId: 'matrix-focus', placedBy: 'owner' }) });
  await local.shared.reconcile();
  await drainDevice(a); await drainDevice(b); await drainDevice(c);
  await Promise.all([pullToHead(a), pullToHead(b), pullToHead(c)]);
  await hosted.shared.reconcile();
  const find = (snapshot: any) => snapshot.humanRequests.find((request: any) => request.groupId === groupId);
  await waitForAsync(async () => !!find(await local.snapshot()) && !!find(await hosted.snapshot()), 'grouped request on both viewers').catch(async error => {
    for (const viewer of [local, hosted]) { const snap = await viewer.snapshot(); console.error('GROUP_DEBUG', JSON.stringify({expected:groupId,source:snap.source,shared:snap.sharedState,requests:snap.humanRequests.map((r:any)=>({id:r.id,groupId:r.groupId,title:r.title,keys:r.conversationKeys})),localShared:viewer.shared.status()})); } throw error; });
  const av = find(await local.snapshot()), bv = find(await middle.snapshot()), cv = find(await hosted.snapshot());
  check(av.progress.percent === 60 && cv.progress.percent === 60 && cv.conversationKeys.length === 2,
    'shared group membership and 60 percent progress converge');
  check(av.contentFingerprint === cv.contentFingerprint && av.contentFingerprint === bv.contentFingerprint && av.sharedReviewDescriptor.fingerprint === cv.sharedReviewDescriptor.fingerprint,
    'review fingerprints agree across distinct replica ids');
  check(cv.workProduct.some((product: any) => product.url === 'http://github.com/example/repo/pull/42'), 'published output provenance reaches hosted projection');
  check(count(c, 'SELECT COUNT(*) AS n FROM tool_uses') === 0, 'hosted projection requires no raw local tool bodies');
  const receivedWork = row<{ id: number }>(c, "SELECT id FROM work_state_entries WHERE origin_device_id=? AND origin_local_id=?", DEVICE_IDS.a, String(workId));
  check(receivedWork && receivedWork.id !== workId, 'shared work retains identity after local SQLite id relocation');
  check((await hosted.snapshot()).focusAreas.some((area: any) => area.id === 'matrix-focus' || area.focusAreaId === 'matrix-focus'), 'focus areas reach the hosted viewer');

  const premature = await hosted.request('/api/work-view/review', { requestId: cv.id, expectedFingerprint: cv.contentFingerprint,
    expectedReviewHash: cv.review.hash, checked: true });
  check(premature.status === 409, 'hosted review refuses work that is not yet reported complete');
  local.shared.saveFile(`progress/${groupId}.json`, progressEntry(100, 'Ready for an owner check.'));
  await drainDevice(a); await Promise.all([pullToHead(b), pullToHead(c)]);
  await waitForAsync(async () => find(await hosted.snapshot())?.progress.percent === 100, 'completion reaches hosted reviewer');
  const reviewable = find(await hosted.snapshot());
  const checked = await hosted.request('/api/work-view/review', { requestId: reviewable.id, expectedFingerprint: reviewable.contentFingerprint,
    expectedReviewHash: reviewable.review.hash, checked: true });
  check(checked.status === 200, 'owner review crosses hosted gate and real worker route', await checked.clone().json());
  await drainDevice(c); await Promise.all([pullToHead(a), pullToHead(b)]);
  await waitForAsync(async () => find(await local.snapshot())?.review.checked === true, 'hosted review reaches local viewer');
  const checkedLocal = find(await local.snapshot());
  const unchecked = await local.request('/api/work-view/review', { requestId: checkedLocal.id,
    expectedFingerprint: checkedLocal.contentFingerprint, expectedReviewHash: checkedLocal.review.hash, checked: false });
  check(unchecked.status === 200, 'local owner can change the shared review');
  await drainDevice(a); await pullToHead(c);
  await waitForAsync(async () => find(await hosted.snapshot())?.review.checked === false, 'local review reaches hosted viewer');

  const suggestedRule = (await hosted.snapshot()).rules.find((rule: any) => rule.status === 'suggested' && rule.then === 'Show remaining work clearly.');
  check(!!suggestedRule, 'shared story produces the same suggested rule on the hosted viewer');
  check((await hosted.request('/api/work-view/rules', { action: 'approve', ruleId: suggestedRule.ruleId })).status === 200, 'hosted owner approves the shared rule');
  check((await hosted.request('/api/work-view/focus', { action: 'rename', focusAreaId: 'matrix-focus', name: 'Shared reliability' })).status === 200, 'hosted owner renames a stable focus area');
  const suggestion = (await hosted.snapshot()).suggestions.find((entry: any) => entry.conversationKey === key('content-baseline-a'));
  check(!!suggestion?.expectedSuggestionHash, 'shared grouping suggestion exposes an authoritative decision token');
  check((await hosted.request('/api/work-view/suggestions', { conversationKey: suggestion.conversationKey, action: 'not-this', expectedSuggestionHash: suggestion.expectedSuggestionHash })).status === 200, 'hosted owner declines the shared grouping suggestion');
  await drainDevice(c); await Promise.all([pullToHead(a), pullToHead(b)]);
  await waitForAsync(async () => {
    const snapshot = await local.snapshot();
    return snapshot.rules.some((rule: any) => rule.ruleId === suggestedRule.ruleId && rule.status === 'on')
      && snapshot.focusAreas.some((area: any) => area.focusAreaId === 'matrix-focus' && area.name === 'Shared reliability')
      && !snapshot.suggestions.some((entry: any) => entry.conversationKey === suggestion.conversationKey);
  }, 'hosted rule, focus rename and suggestion decision reach local viewer');
  check(true, 'shared approved rule, stable focus rename and suggestion decision converge');

  console.log('\nScenario: hub process restart retains shared head and generation');
  const beforeRestart = await getHubStatus(), port = new URL(hubUrl).port;
  await stopHub(); await startHub(sidecarUrl, port);
  const afterRestart = await getHubStatus();
  check(afterRestart.epoch === beforeRestart.epoch && afterRestart.head_seq === beforeRestart.head_seq,
    'hub restart retains epoch and authoritative log');
  await Promise.all([pullToHead(a), pullToHead(b), pullToHead(c)]);
  check(find(await hosted.snapshot()).contentFingerprint === find(await local.snapshot()).contentFingerprint,
    'shared semantic identity survives hub restart');

  console.log('\nScenario: browser live feed stays live while cloud pull is offline');
  const feedObservation = a.store.storeObservation(sessions[0].memory, 'matrix-view', observation('MATRIX_FEED_INITIAL', 'Browser convergence marker'), 1, 0);
  await drainDevice(a); await pullToHead(c); await local.notify(); await hosted.notify();
  await runViewerBrowsers(local, hosted, async pages => {
    const browserWait = async (page: any, expression: string, label: string, timeoutMs = 25_000) => waitForAsync(() => page.evaluate(expression), label, timeoutMs).catch(async error => { console.error('BROWSER_DEBUG', label, JSON.stringify(await page.evaluate('({url:location.pathname,errors:window.matrixErrors,metrics:window.matrixMetrics,model:window.matrixModel?.()?.state,text:document.body?.textContent?.slice(0,1500)})'))); throw error; });
    // Page.navigate acknowledges before the new document has a body. Keep polling
    // the intended page instead of turning that normal loading state into an exception.
    await browserWait(pages.local, `location.pathname === '/' && document.body?.textContent?.includes('Matrix shared viewer') === true`, 'local My Work visible');
    await browserWait(pages.hosted, `location.pathname === '/' && document.body?.textContent?.includes('Matrix shared viewer') === true`, 'hosted My Work visible');
    await browserWait(pages.classic, `location.pathname === '/viewer' && document.body?.textContent?.includes('MATRIX_FEED_INITIAL') === true`, 'hosted classic feed visible');
    c.gate.pullRequests = 0; replaceClient(c, false, true);
    await waitFor(() => c.gate.pullRequests > 0 && !c.client.status().inFlight, 'initial normal hosted poll');
    await Bun.sleep(1500);
    a.store.storeObservation(sessions[0].memory, 'matrix-view', observation('MATRIX_NORMAL_POLL', 'Visible through the normal thirty-second polling cadence'), 4, 0);
    await drainDevice(a);
    const acceptedAt = performance.now();
    await browserWait(pages.classic, `document.body.textContent.includes('MATRIX_NORMAL_POLL')`, 'normal thirty-second poll updates visible memory without manual pull or notification', 35_000);
    const visibleAfterMs = performance.now() - acceptedAt;
    check(visibleAfterMs <= 30_000, 'healthy polling-only remote write is visible within thirty seconds', { visibleAfterMs: Math.round(visibleAfterMs) });
    console.log(`  POLLING_VISIBILITY ${JSON.stringify({ cadenceMs: 30_000, acceptedToVisibleMs: Math.round(visibleAfterMs), forcedPull: false, manualNotification: false })}`);
    for (const page of [pages.local, pages.hosted, pages.classic]) await page.evaluate('window.matrixNavigationSentinel = Math.random()');
    const sentinel = await pages.hosted.evaluate('window.matrixNavigationSentinel');
    await browserWait(pages.hosted, `document.querySelector('[data-sync-state]')?.parentElement?.dataset.connectionState === 'live'`, 'hosted SSE live');
    c.gate.pullsOnline = false;
    await c.client.pullOnce({ force: true }); await hosted.notify();
    await browserWait(pages.hosted, `document.querySelector('[data-sync-state="offline"]') !== null`, 'offline cloud status');
    check(await pages.hosted.evaluate(`document.querySelector('[data-sync-state]')?.parentElement?.dataset.connectionState === 'live'`),
      'browser distinguishes an open SSE stream from an offline cloud pull');
    local.shared.saveFile(`progress/${groupId}.json`, progressEntry(80, 'Recovered progress after offline pull.'));
    const second = a.store.storeObservation(sessions[0].memory, 'matrix-view', observation('MATRIX_FEED_RECOVERED', 'Arrived without reload'), 2, 0);
    await drainDevice(a); await local.notify();
    check(!(await pages.classic.evaluate(`document.body.textContent.includes('MATRIX_FEED_RECOVERED')`)), 'offline replica does not pretend remote data arrived');
    c.gate.pullsOnline = true; await pullToHead(c); await hosted.shared.reconcile(); await hosted.notify();
    await browserWait(pages.hosted, `window.matrixModel()?.state === 'loaded' && window.matrixModel().model.requests.some(r => r.progress.percent === 80)`, 'shared progress catches up without reload');
    await browserWait(pages.classic, `document.body.textContent.includes('MATRIX_FEED_RECOVERED')`, 'classic remote memory catches up without reload');
    check(await pages.hosted.evaluate('window.matrixNavigationSentinel') === sentinel, 'hosted browser recovered without navigation');
    const timing = await pages.hosted.evaluate('({firstUsefulMs:window.matrixUseful, navigationEntries:performance.getEntriesByType("navigation").length, requests:window.matrixModel().model.requests.length})');
    check(Number.isFinite(timing.firstUsefulMs), 'browser records first useful My Work display', timing);
    console.log(`  BROWSER_TIMING ${JSON.stringify(timing)}`);
    check(second.id !== feedObservation.id, 'browser update uses a distinct memory entity');
  });

  console.log('\nScenario: selected historical recovery and conditional conflict repair');
  const old = a.store.storeObservation(sessions[0].memory, 'matrix-history', observation('MATRIX_HISTORICAL', 'Selected old memory'), 3, 0);
  a.store.db.prepare('UPDATE observations SET created_at_epoch=?,created_at=?,synced_at=1 WHERE id=?')
    .run(1_600_000_000_000, new Date(1_600_000_000_000).toISOString(), old.id);
  a.store.db.prepare("INSERT OR REPLACE INTO sync_launch_exclusions(kind,origin_local_id,through_rev) VALUES('observation',?,'1')").run(String(old.id));
  const beforeHistory = a.cloudSync.recovery.preview({ project: 'matrix-history', from: '2020-01-01', to: '2021-01-01', kinds: ['observation'] });
  check(beforeHistory.count === 1, 'historical preview selects exactly its explicit date/project scope');
  const job = a.cloudSync.recovery.create({ scope: beforeHistory.scope, previewToken: beforeHistory.previewToken });
  a.cloudSync.recovery.transition(job.id, 'resume', a.apply.getEpoch()); await drainDevice(a); await pullToHead(c);
  check(a.cloudSync.recovery.get(job.id).status === 'complete', 'selected history completes through ordinary uploader acknowledgement');
  check(count(c, "SELECT COUNT(*) AS n FROM observations WHERE title='MATRIX_HISTORICAL'") === 1, 'selected historical memory reaches hosted replica');
  initializeConflictRecoverySchema(a.store.db);
  const repair = new SyncConflictRecovery(a.store.db, { deviceId: DEVICE_IDS.a, userId: USER_ID, authToken: TOKEN,
    hubUrl, fetch: guardedFetch(a.gate) });
  const preview = await repair.preview({ kind: 'observation', originLocalId: String(old.id), choice: 'local_current' });
  const result = await repair.apply({ previewToken: preview.previewToken });
  check(result.state === 'verified', 'origin-only repair verifies its conditional higher revision against the real hub');
  await pullToHead(c);
  const repaired = row<{ sync_rev: string }>(c, 'SELECT sync_rev FROM observations WHERE origin_device_id=? AND origin_local_id=?', DEVICE_IDS.a, String(old.id));
  check(repaired?.sync_rev === preview.proposedRevision, 'hosted replica applies the repaired canonical revision');
  await Promise.all([pullToHead(a), pullToHead(b), pullToHead(c)]);
  check(sidecar.projectionCalls.length > 3 && sidecar.bodies.some(body => body.kind === 'work_state'), 'multi-page canonical projection includes coherent shared records');
}

async function runMatrix(sidecar: SidecarState, sidecarUrl: string): Promise<void> {
  console.log(`Sync matrix E2E — fresh account ${USER_ID}`);
  const fresh = await getHubStatus();
  check(
    fresh.head_seq === '0' && fresh.projected_seq === '0' && fresh.op_count === 0 && fresh.device_count === 0,
    'fresh account starts with an empty log and no devices',
    fresh,
  );

  let a = openDevice('a');
  let b = openDevice('b');
  const c = openDevice('c');
  const tempDirs = new Set([a.dir, b.dir, c.dir]);
  const viewers: MatrixViewer[] = [];
  try {
    await waitFor(() => a.apply.getEpoch() === fresh.epoch && b.apply.getEpoch() === fresh.epoch, 'initial epoch adoption');
    await waitFor(() => a.client.isPollModeOnly() && b.client.isPollModeOnly(), 'both clients fall back to polling (no realtime-token)');
    check(!a.client.isSocketLive() && !b.client.isSocketLive(),
      'both real clients stay on HTTP when the server offers no Realtime');

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

    console.log('\nScenario: authoritative HTTP path (no advisory lane)');
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
    await pullToHead(b);
    await waitFor(() => b.client.isPollModeOnly(), 'B falls back to polling after restart');
    check(!b.client.isSocketLive(), 'restarted client stays in poll mode');

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
    await runViewerMatrix(a, b, c, viewers, sidecar, sidecarUrl);
    const finalStatus = await getHubStatus();
    check(typeof a.apply.getCursor() === 'string' && DECIMAL.test(a.apply.getCursor()), 'A cursor remains a decimal string');
    check(typeof b.apply.getCursor() === 'string' && DECIMAL.test(b.apply.getCursor()), 'B cursor remains a decimal string');
    check(finalStatus.head_seq.length >= 2, 'matrix crosses a multi-digit decimal Hub sequence', finalStatus.head_seq);
    check([a, b, c].every(device => device.apply.getCursor() === finalStatus.head_seq),
      'all three decimal cursors equal the authoritative head');
    check(finalStatus.projected_seq === finalStatus.head_seq, 'Hub checkpoint equals head');
    check(sidecar.projectedThrough === finalStatus.head_seq, 'loopback projector checkpoint equals Hub head');
    check(finalStatus.device_count === 3, 'exactly three real device identities touched the Hub', finalStatus.device_count);
    check(sidecar.errors.length === 0, 'loopback verifier/projector recorded no contract errors', sidecar.errors);
    check(sidecar.verifyCalls > 0 && sidecar.projectionCalls.length > 0, 'real Hub used both loopback sidecar routes');

    const kinds = new Set(sidecar.bodies.map(body => body.kind));
    const mutations = new Set(sidecar.bodies
      .filter(body => body.kind === 'mutation')
      .map(body => (body.mutation as { op?: unknown } | null)?.op));
    check(['observation', 'summary', 'prompt', 'work_state', 'mutation'].every(kind => kinds.has(kind as CanonicalContentBody['kind'])),
      'projector receives every canonical content kind', [...kinds]);
    check(['set_title', 'set_prompt_session', 'remap_project'].every(op => mutations.has(op)),
      'projector receives all required mutation kinds', [...mutations]);
    const lifecycle = sidecar.bodies.filter(body => body.id === entityId);
    check(lifecycle.some(body => body.deleted) && lifecycle.some(body => !body.deleted && compareCanonicalDecimals(body.entity_rev, deleteRev) > 0),
      'projector observes both tombstone and higher-revision revive');

    const [statusA, statusB, statusC] = await Promise.all([
      a.cloudSync.statusWithHubProbe(),
      b.cloudSync.statusWithHubProbe(),
      c.cloudSync.statusWithHubProbe(),
    ]);
    check(statusA.hub.reachable === true && statusB.hub.reachable === true && statusC.hub.reachable === true,
      'all three empty-queue status checks authenticate against Hub');
    check([a, b, c].every(device => pending(device) === 0), 'all three clients finish with empty durable queues');
    check(String(baseline.id) !== offlineId, 'delete/revive reused only its intended stable local id');
  } finally {
    for (const viewer of viewers.reverse()) await viewer.close();
    for (const device of [a, b, c]) {
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
    await runMatrix(sidecar.state, sidecar.baseUrl);
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
  // A scenario that failed midway leaves its viewers and browsers open, and
  // they would keep this process alive until the CI job times out.
  process.exit(1);
});
