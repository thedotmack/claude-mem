// Phase 5 (L): media sync. Canonical metadata validation, the media
// upload/retry/deletion worker beside native text sync, and second-device
// replica resolution. Real SQLite schema, real MediaStore and Sharp, a mocked
// sync hub and a mocked Pro media plane copied from Pro's Phase 3 route shape
// (src/lib/media/cloud-routes.ts). Scratch files live in project-local
// .scratch. No network, no model call.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import express from 'express';
import type { Server } from 'node:http';
import { MediaRoutes } from '../../src/services/worker/http/routes/MediaRoutes.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MediaStore, mediaEventKey } from '../../src/services/media/store.js';
import { MediaCloudClient, MediaCloudReplicaResolver, MediaCloudSync, mediaCloudUploadsEnabled } from '../../src/services/media/cloud.js';
import { CloudSync, type CloudSyncSettingKeys } from '../../src/services/sync/CloudSync.js';
import { SyncApply } from '../../src/services/sync/SyncApply.js';
import { SyncClient } from '../../src/services/sync/SyncClient.js';
import { buildContentOperation, parseCanonicalOperation } from '../../src/services/sync/CanonicalContent.js';
import { parseCanonicalOperation as parseSyncApiOperation } from '../../services/sync-api/src/canonical-content.js';
import { MediaError, type MediaAttachmentRef } from '../../src/shared/media-contract.js';
import { observationChange } from '../worker/sync/content-v2-helpers.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
const PRO = 'https://pro.test';
const TOKEN = 'cm_pro_0123456789abcdef0123456789abcdef';
const DEVICE_A = 'device-a-media';
const DEVICE_B = 'device-b-media';
const ISO = '2026-10-02T00:00:00.000Z';
let png: Buffer;
let otherPng: Buffer;
let scratchDir: string;
const opened: Database[] = [];

beforeAll(async () => {
  const make = (red: number) => sharp({ create: { width: 320, height: 180, channels: 4, background: { r: red, g: 40, b: 90, alpha: 1 } } }).png().toBuffer();
  png = await make(200);
  otherPng = await make(20);
});
beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  scratchDir = realpathSync(mkdtempSync(join(SCRATCH, 'media-sync-')));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake Pro media plane: POST /api/observation-media (multipart manifest +
// canonical), GET descriptor/variants, DELETE with durable tombstones.
// ---------------------------------------------------------------------------
interface ProCall { method: string; path: string; authorization: string | null; fieldNames?: string[]; manifest?: any }
function makeFakePro() {
  const objects = new Map<string, { descriptor: any; viewer: Buffer; llm: Buffer }>();
  const tombstones = new Set<string>();
  const calls: ProCall[] = [];
  const state = {
    offline: false,
    /** Commit the upload server-side, then drop the response (lost ack). */
    loseNextUploadResponse: false,
    failNextUploadStatus: null as null | { status: number; error: string },
    corruptNextVariant: false,
    duringUpload: null as null | (() => void),
  };
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? 'GET');
    const call: ProCall = { method, path: url.pathname, authorization: (init?.headers ?? {}).Authorization ?? null };
    calls.push(call);
    if (state.offline) throw new Error('connect ECONNREFUSED');
    const segments = url.pathname.replace(/^\/api\/observation-media\/?/, '').split('/').filter(Boolean);
    if (method === 'POST' && segments.length === 0) {
      const form = await new Request(url, { method: 'POST', body: init.body }).formData();
      call.fieldNames = Array.from(form.keys());
      const manifest = JSON.parse(String(form.get('manifest')));
      call.manifest = manifest;
      const canonical = Buffer.from(await (form.get('canonical') as File).arrayBuffer());
      state.duringUpload?.();
      state.duringUpload = null;
      if (state.failNextUploadStatus) {
        const failure = state.failNextUploadStatus;
        state.failNextUploadStatus = null;
        return json(failure.status, { error: failure.error });
      }
      if (tombstones.has(manifest.id)) return json(404, { error: 'media_not_found' });
      if (canonical.length !== manifest.canonical.byteLength || sha(canonical) !== manifest.canonical.sha256) return json(409, { error: 'checksum_mismatch' });
      let stored = objects.get(manifest.id);
      if (!stored) {
        const variant = (bytes: Buffer) => ({ sha256: sha(bytes), width: manifest.canonical.width, height: manifest.canonical.height, byteLength: bytes.length, mimeType: 'image/webp' });
        stored = { descriptor: { id: manifest.id, state: 'ready', recipe: manifest.provenance.recipe, encoder: manifest.encoder, viewer: variant(canonical), llm: variant(canonical) }, viewer: canonical, llm: canonical };
        objects.set(manifest.id, stored);
      }
      if (state.loseNextUploadResponse) {
        state.loseNextUploadResponse = false;
        throw new Error('socket hang up');
      }
      return json(200, stored.descriptor);
    }
    const [id, variant] = segments;
    if (method === 'DELETE') {
      objects.delete(id);
      tombstones.add(id);
      return new Response(null, { status: 204 });
    }
    const stored = objects.get(id);
    if (!stored) return json(404, { error: 'media_not_found' });
    if (!variant) return json(200, stored.descriptor);
    let bytes = variant === 'viewer' ? stored.viewer : stored.llm;
    if (state.corruptNextVariant) {
      state.corruptNextVariant = false;
      bytes = Buffer.from(bytes);
      bytes[bytes.length - 1] ^= 0xff;
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'image/webp' } });
  }) as typeof fetch;
  return { impl, calls, objects, tombstones, state, uploads: () => calls.filter(call => call.method === 'POST') };
}

// ---------------------------------------------------------------------------
// One device: SQLite + MediaStore + mocked hub transport.
// ---------------------------------------------------------------------------
function makeDevice(name: string) {
  const db = new Database(':memory:');
  opened.push(db);
  const sessions = new SessionStore(db);
  const media = new MediaStore(db, join(scratchDir, name));
  return { db, sessions, media };
}
type Device = ReturnType<typeof makeDevice>;

let clock = 1_800_000_000_000;
function mediaCloud(device: Device, pro: ReturnType<typeof makeFakePro>, uploadsEnabled = true) {
  const client = new MediaCloudClient({ baseUrl: PRO, token: TOKEN, fetchImpl: pro.impl });
  return new MediaCloudSync(device.db, device.media, client, { uploadsEnabled, now: () => clock });
}

async function captureImage(device: Device, toolUseId: string, bytes = png, extra: Record<string, unknown> = {}): Promise<{ ref: MediaAttachmentRef; eventKey: string; sessionDbId: number }> {
  const sessionDbId = device.sessions.createSDKSession(`content-${toolUseId}`, 'proj-media', 'prompt', undefined, 'claude');
  device.sessions.updateMemorySessionId(sessionDbId, `mem-${toolUseId}`);
  const identity = { kind: 'platform_event' as const, id: `evt-${toolUseId}` };
  const ref = await device.media.capture({
    sessionDbId,
    label: 'event1_image1',
    bytes,
    mimeType: 'image/png',
    provenance: {
      version: 1, platform: 'claude-code', event_identity: identity, source_shape: 'anthropic_base64',
      source_pointer: '/content/1', source_index: 0, source_sha256: createHash('sha256').update(bytes).digest('hex'),
      recipe: 'screenshot-v1', ...extra,
    },
  });
  return { ref, eventKey: mediaEventKey('claude-code', identity), sessionDbId };
}

/** A native observation carrying the manifest plus an unrelated namespace, linked like Phase 4 does. */
function storeLinkedObservation(device: Device, capture: { ref: MediaAttachmentRef; eventKey: string; sessionDbId: number }, title = 'Screenshot observation'): number {
  const memorySessionId = (device.db.prepare('SELECT memory_session_id FROM sdk_sessions WHERE id=?').get(capture.sessionDbId) as { memory_session_id: string }).memory_session_id;
  const metadata = { cmem_media_v1: { version: 1, attachments: [{ ...capture.ref, inspection: 'inspected' }] }, other_namespace: { keep: [1, 'two'] } };
  const row = device.db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, metadata, created_at, created_at_epoch)
    VALUES (?, 'proj-media', 'discovery', ?, 'saw the image', ?, ?, 1800000000000) RETURNING id`).get(memorySessionId, title, JSON.stringify(metadata), ISO) as { id: number };
  device.media.linkObservation(row.id, capture.eventKey, [{ ...capture.ref, inspection: 'inspected' }]);
  return row.id;
}

function cloudSyncSettings(deviceId: string): CloudSyncSettingKeys {
  return {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-media',
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: deviceId,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: deviceId,
  };
}

/** Mocked hub log shared by both devices: push appends, pull pages. */
function makeHub() {
  const log: Array<{ seq: string; body: string; operation_sha256: string; server_ts: string }> = [];
  const pushes: string[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/sync/ops') {
      const wire = JSON.parse(String(init.body));
      pushes.push(...wire.ops.map((op: any) => op.body));
      const acked = wire.ops.map((op: any) => {
        const envelope = JSON.parse(op.body);
        const seq = String(log.length + 1);
        log.push({ seq, body: op.body, operation_sha256: op.operation_sha256, server_ts: '1800000000000' });
        return { id: envelope.id, kind: envelope.kind, origin_local_id: envelope.origin_local_id, entity_rev: envelope.entity_rev, operation_sha256: op.operation_sha256, seq };
      });
      return new Response(JSON.stringify({ acked, head_seq: String(log.length), projected_seq: String(log.length) }), { status: 200 });
    }
    const since = Number(url.searchParams.get('since') ?? '0');
    const ops = log.filter(op => Number(op.seq) > since);
    return new Response(JSON.stringify({ protocol_version: 2, epoch: '1', ops, head_seq: String(log.length), more: false }), { status: 200 });
  }) as typeof fetch;
  return { impl, log, pushes };
}

function settingsPath(name: string) { return join(scratchDir, `${name}-settings.json`); }

function makeCloudSync(device: Device, deviceId: string, hub: ReturnType<typeof makeHub>) {
  return new CloudSync(device.db, cloudSyncSettings(deviceId), { fetchImpl: hub.impl, settingsPath: settingsPath(deviceId), debounceMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 });
}

function makeSyncClient(device: Device, deviceId: string, hub: ReturnType<typeof makeHub>) {
  return new SyncClient(new SyncApply(device.db, { deviceId }), {
    hubUrl: 'https://hub.test', token: TOKEN, userId: 'user-media', deviceId, deviceName: deviceId,
    fetchImpl: hub.impl, wsEnabled: false, activePollMs: 60_000, idlePollMs: 60_000, minPullGapMs: 0,
  });
}

const VALID_ID = '3f8a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const INVALID_MANIFESTS: Array<[string, unknown]> = [
  ['null namespace', null],
  ['unsupported version', { version: 2, attachments: [] }],
  ['readiness frozen into a ref', { version: 1, attachments: [{ id: VALID_ID, label: 'event1_image1', inspection: 'uninspected', state: 'ready' }] }],
  ['object key on a ref', { version: 1, attachments: [{ id: VALID_ID, label: 'event1_image1', inspection: 'uninspected', key: 'owner/a/b/viewer.webp' }] }],
  ['path as label', { version: 1, attachments: [{ id: VALID_ID, label: '/Users/me/shot.png', inspection: 'uninspected' }] }],
  ['data URL as label', { version: 1, attachments: [{ id: VALID_ID, label: 'data:image/webp;base64,AAAA', inspection: 'uninspected' }] }],
  ['duplicate id', { version: 1, attachments: [{ id: VALID_ID, label: 'a', inspection: 'uninspected' }, { id: VALID_ID, label: 'b', inspection: 'uninspected' }] }],
  ['33 refs', { version: 1, attachments: Array.from({ length: 33 }, (_, index) => ({ id: `3f8a1c2e-5b6d-4e7f-8a9b-${index.toString(16).padStart(12, '0')}`, label: 'event1_image1', inspection: 'uninspected' })) }],
];

function observationPayload(metadata: unknown): Record<string, unknown> {
  return {
    memory_session_id: 'mem-1', project: 'proj-x', type: 'discovery', title: 't',
    created_at: ISO, created_at_epoch: '1800000000000', metadata,
  };
}

describe('canonical metadata.cmem_media_v1 (local and sync-api parity)', () => {
  it('accepts a bounded manifest, keeps other namespaces, payload v2 and the 256,000-byte budget', async () => {
    const metadata = { cmem_media_v1: { version: 1, attachments: [{ id: VALID_ID, label: 'event1_image1', inspection: 'inspected' }], overflow: false }, other_namespace: { anything: [1, { deep: true }] } };
    const op = buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '1', entityRev: '1', payload: observationPayload(metadata) });
    const local = parseCanonicalOperation(op);
    expect(local.payload_schema_version).toBe(2);
    expect((local.payload as any).metadata).toEqual(metadata);
    const remote = await parseSyncApiOperation(op);
    expect(remote.serialized).toBe(op.body);
    // Budget unchanged: a body over 256,000 bytes still fails even with a valid manifest.
    expect(() => buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '2', entityRev: '1', payload: { ...observationPayload(metadata), narrative: 'x'.repeat(256_000) } })).toThrow(/256000/);
  });

  for (const [name, manifest] of INVALID_MANIFESTS) {
    it(`fails closed in both validators on ${name}`, async () => {
      const metadata = { cmem_media_v1: manifest, other_namespace: {} };
      expect(() => buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '1', entityRev: '1', payload: observationPayload(metadata) })).toThrow(/cmem_media_v1 is invalid/);
      // Same body forged past local validation is refused by the sync service.
      const valid = buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '1', entityRev: '1', payload: observationPayload({}) });
      const envelope = JSON.parse(valid.body);
      envelope.payload.metadata = metadata;
      const { canonicalJson, sha256Base64Url } = await import('../../src/services/sync/CanonicalContent.js');
      envelope.payload_sha256 = sha256Base64Url(canonicalJson(envelope.payload));
      const body = canonicalJson(envelope);
      await expect(parseSyncApiOperation({ body, operation_sha256: sha256Base64Url(body) })).rejects.toThrow(/cmem_media_v1 is invalid/);
    });
  }

  it('keeps unknown top-level payload fields rejected', () => {
    expect(() => buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '1', entityRev: '1', payload: { ...observationPayload({}), attachments: [VALID_ID] } })).toThrow(/unknown field attachments/);
  });
});

describe('L -> hub -> second device', () => {
  it('round-trips refs and other metadata, resolves pending then ready, never echoes or re-uploads the replica', async () => {
    const pro = makeFakePro();
    const hub = makeHub();
    const deviceA = makeDevice('a');
    const capture = await captureImage(deviceA, 'roundtrip');
    const observationId = storeLinkedObservation(deviceA, capture);

    // Text syncs first, carrying the stable pending attachment ID.
    await makeCloudSync(deviceA, DEVICE_A, hub).flush();
    expect(hub.log).toHaveLength(1);
    const pushedBody = hub.log[0].body;
    expect(pushedBody).toContain(capture.ref.id);
    for (const leak of ['data:image', 'base64', 'media-v1', scratchDir, '.webp', 'source_sha256', 'evt-roundtrip']) expect(pushedBody).not.toContain(leak);
    const syncedRow = deviceA.db.prepare('SELECT CAST(sync_rev AS TEXT) AS rev, synced_at, metadata FROM observations WHERE id=?').get(observationId) as any;
    expect(syncedRow.synced_at).not.toBeNull();

    // Second device pulls before the owner uploaded: refs retained, bytes pending.
    const deviceB = makeDevice('b');
    await makeSyncClient(deviceB, DEVICE_B, hub).pullOnce({ timeoutMs: 5_000 });
    const replicaRow = deviceB.db.prepare('SELECT id, metadata, origin_device_id FROM observations').get() as any;
    expect(replicaRow.origin_device_id).toBe(DEVICE_A);
    expect(JSON.parse(replicaRow.metadata)).toEqual(JSON.parse(syncedRow.metadata));
    expect(deviceB.db.prepare('SELECT observation_id, attachment_id, label, inspection FROM observation_media_links').all())
      .toEqual([{ observation_id: replicaRow.id, attachment_id: capture.ref.id, label: 'event1_image1', inspection: 'inspected' }]);
    expect(deviceB.db.prepare('SELECT origin, upload_state, state FROM media_attachments WHERE id=?').get(capture.ref.id))
      .toEqual({ origin: 'replica', upload_state: 'cancelled', state: 'failed' });
    const resolver = new MediaCloudReplicaResolver(deviceB.media, new MediaCloudClient({ baseUrl: PRO, token: TOKEN, fetchImpl: pro.impl }));
    await expect(resolver.resolve(capture.ref.id)).rejects.toMatchObject({ code: 'media_not_ready' });

    // Owner upload completes later: text, metadata and revision are untouched.
    const ownerSync = mediaCloud(deviceA, pro);
    expect(await ownerSync.drain()).toMatchObject({ uploaded: 1 });
    expect(deviceA.db.prepare('SELECT CAST(sync_rev AS TEXT) AS rev, synced_at, metadata FROM observations WHERE id=?').get(observationId)).toEqual(syncedRow);
    expect(deviceA.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE synced_at IS NULL").get()).toEqual({ n: 0 });
    expect(deviceA.db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
    expect(deviceA.db.prepare('SELECT upload_state FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ upload_state: 'uploaded' });
    const [upload] = pro.uploads();
    expect(upload.authorization).toBe(`Bearer ${TOKEN}`);
    expect(upload.path).toBe('/api/observation-media');
    expect(upload.fieldNames).toEqual(['manifest', 'canonical']);
    expect(Object.keys(upload.manifest).sort()).toEqual(['canonical', 'encoder', 'id', 'provenance', 'version']);
    expect(upload.manifest.provenance.attachment_id).toBe(capture.ref.id);
    // A second drain is a no-op: no duplicate upload.
    await ownerSync.drain();
    expect(pro.uploads()).toHaveLength(1);

    // Now the replica resolves, verified against the authorized descriptor.
    await resolver.resolve(capture.ref.id);
    expect(deviceB.media.getMetadata(capture.ref.id).state).toBe('ready');
    const ownerViewer = await deviceA.media.readVariant(capture.ref.id, 'viewer');
    expect(Buffer.compare(await deviceB.media.readVariant(capture.ref.id, 'viewer'), ownerViewer)).toBe(0);

    // The replica is never uploaded and never echoed as a native observation.
    const replicaSync = mediaCloud(deviceB, pro);
    await replicaSync.drain();
    expect(pro.uploads()).toHaveLength(1);
    await makeCloudSync(deviceB, DEVICE_B, hub).flush();
    expect(hub.log).toHaveLength(1);
  });

  it('the local viewer route resolves a replica lazily: pending (409) before the owner upload, verified bytes after', async () => {
    const pro = makeFakePro();
    const hub = makeHub();
    const deviceA = makeDevice('a');
    const capture = await captureImage(deviceA, 'route');
    storeLinkedObservation(deviceA, capture);
    await makeCloudSync(deviceA, DEVICE_A, hub).flush();
    const deviceB = makeDevice('b');
    await makeSyncClient(deviceB, DEVICE_B, hub).pullOnce({ timeoutMs: 5_000 });
    const resolver = new MediaCloudReplicaResolver(deviceB.media, new MediaCloudClient({ baseUrl: PRO, token: TOKEN, fetchImpl: pro.impl }));
    const app = express();
    new MediaRoutes(() => deviceB.media, id => resolver.resolve(id)).setupRoutes(app);
    const server: Server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}/api/media/${capture.ref.id}`;
      const pending = await fetch(`${url}/viewer`);
      expect(pending.status).toBe(409);
      expect(await pending.json()).toEqual({ error: 'Media request failed', code: 'media_not_ready' });
      // A foreign page is refused before any cloud request.
      const callsBefore = pro.calls.length;
      expect((await fetch(`${url}/viewer`, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
      expect(pro.calls.length).toBe(callsBefore);
      await mediaCloud(deviceA, pro).drain();
      const ready = await fetch(`${url}/viewer`);
      expect(ready.status).toBe(200);
      expect(ready.headers.get('content-type')).toBe('image/webp');
      expect(Buffer.compare(Buffer.from(await ready.arrayBuffer()), await deviceA.media.readVariant(capture.ref.id, 'viewer'))).toBe(0);
      const metadata = await (await fetch(url)).json() as Record<string, unknown>;
      expect(metadata.state).toBe('ready');
      expect(JSON.stringify(metadata)).not.toContain('replica');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects a checksum-mismatched replica download and keeps it pending-resolvable', async () => {
    const pro = makeFakePro();
    const hub = makeHub();
    const deviceA = makeDevice('a');
    const capture = await captureImage(deviceA, 'corrupt');
    storeLinkedObservation(deviceA, capture);
    await makeCloudSync(deviceA, DEVICE_A, hub).flush();
    await mediaCloud(deviceA, pro).drain();
    const deviceB = makeDevice('b');
    await makeSyncClient(deviceB, DEVICE_B, hub).pullOnce({ timeoutMs: 5_000 });
    const resolver = new MediaCloudReplicaResolver(deviceB.media, new MediaCloudClient({ baseUrl: PRO, token: TOKEN, fetchImpl: pro.impl }));
    pro.state.corruptNextVariant = true;
    await expect(resolver.resolve(capture.ref.id)).rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(deviceB.media.isUnresolvedReplica(capture.ref.id)).toBe(true);
    await resolver.resolve(capture.ref.id);
    expect(deviceB.media.getMetadata(capture.ref.id).state).toBe('ready');
  });

  it('a replica without cloud credentials stays pending instead of failing', async () => {
    const deviceB = makeDevice('b');
    const apply = new SyncApply(deviceB.db, { deviceId: DEVICE_B });
    const change = observationChange(1, '11', DEVICE_A, { metadata: { cmem_media_v1: { version: 1, attachments: [{ id: VALID_ID, label: 'event1_image1', inspection: 'uninspected' }] } } });
    const client = new SyncClient(apply, { hubUrl: 'https://hub.test', token: TOKEN, userId: 'u', deviceId: DEVICE_B, deviceName: 'b', wsEnabled: false, minPullGapMs: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ protocol_version: 2, epoch: '1', ops: [change], head_seq: '1', more: false }))) as typeof fetch });
    await client.pullOnce({ timeoutMs: 5_000 });
    await expect(new MediaCloudReplicaResolver(deviceB.media, null).resolve(VALID_ID)).rejects.toMatchObject({ code: 'media_not_ready' });
  });
});

describe('replica refs follow accepted revisions only', () => {
  function apply(device: Device, ops: ReturnType<typeof observationChange>[]) {
    const client = new SyncClient(new SyncApply(device.db, { deviceId: DEVICE_B }), {
      hubUrl: 'https://hub.test', token: TOKEN, userId: 'u', deviceId: DEVICE_B, deviceName: 'b', wsEnabled: false, minPullGapMs: 0,
      fetchImpl: (async (input: any) => {
        const since = Number(new URL(String(input)).searchParams.get('since') ?? '0');
        const page = ops.filter(op => Number(op.seq) > since);
        return new Response(JSON.stringify({ protocol_version: 2, epoch: '1', ops: page, head_seq: String(ops.length), more: false }));
      }) as typeof fetch,
    });
    return client.pullOnce({ timeoutMs: 5_000 });
  }
  const ID_ONE = '11111111-1111-4111-8111-111111111111';
  const ID_TWO = '22222222-2222-4222-8222-222222222222';
  const manifest = (...ids: string[]) => ({ cmem_media_v1: { version: 1, attachments: ids.map(id => ({ id, label: 'event1_image1', inspection: 'uninspected' })) }, keep: true });
  function revision(seq: number, rev: string, metadata: unknown) {
    const change = observationChange(seq, '11', DEVICE_A, { metadata });
    const envelope = JSON.parse(change.body);
    const op = buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '11', entityRev: rev, payload: envelope.payload });
    return { ...change, ...op };
  }
  function tombstone(seq: number, rev: string) {
    const op = buildContentOperation({ kind: 'observation', originDeviceId: DEVICE_A, originLocalId: '11', entityRev: rev, payload: null, deleted: true, deletedAt: ISO });
    return { ...op, seq: String(seq), server_ts: '1' };
  }
  const links = (device: Device) => device.db.prepare('SELECT attachment_id FROM observation_media_links ORDER BY attachment_id').all();
  const attachment = (device: Device, id: string) => device.db.prepare('SELECT state, origin, upload_state FROM media_attachments WHERE id=?').get(id);

  it('a stale payload cannot add or remove media; a newer one replaces refs; a tombstone removes them without cloud deletion', async () => {
    const device = makeDevice('b');
    const ops = [revision(1, '2', manifest(ID_ONE))];
    await apply(device, ops);
    expect(links(device)).toEqual([{ attachment_id: ID_ONE }]);

    // Stale rev 1 naming a different image: ignored entirely.
    ops.push(revision(2, '1', manifest(ID_TWO)));
    await apply(device, ops);
    expect(links(device)).toEqual([{ attachment_id: ID_ONE }]);
    expect(attachment(device, ID_TWO)).toBeNull();

    // Newer rev 3 replaces the ref: the dropped replica is tombstoned locally.
    ops.push(revision(3, '3', manifest(ID_TWO)));
    await apply(device, ops);
    expect(links(device)).toEqual([{ attachment_id: ID_TWO }]);
    expect(attachment(device, ID_ONE)).toEqual({ state: 'deleted', origin: 'replica', upload_state: 'cancelled' });

    // Higher-revision tombstone deletes the row and its replica media.
    ops.push(tombstone(4, '4'));
    await apply(device, ops);
    expect(links(device)).toEqual([]);
    expect(attachment(device, ID_TWO)).toEqual({ state: 'deleted', origin: 'replica', upload_state: 'cancelled' });
    // A replica deletion never deletes the owner's cloud copy.
    expect(device.db.prepare('SELECT COUNT(*) AS n FROM media_cloud_deletions').get()).toEqual({ n: 0 });

    // A stale live op after the tombstone cannot recreate the row or media.
    ops.push(revision(5, '3', manifest(ID_ONE, ID_TWO)));
    await apply(device, ops);
    expect(device.db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    expect(links(device)).toEqual([]);
    expect(attachment(device, ID_ONE)).toEqual({ state: 'deleted', origin: 'replica', upload_state: 'cancelled' });
  });
});

describe('media upload state is independent of text sync', () => {
  it('is gated by the capture flag and cloud sync credentials', () => {
    const base = { CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN, CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'u', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true' };
    expect(mediaCloudUploadsEnabled(base)).toBe(true);
    expect(mediaCloudUploadsEnabled({ ...base, CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false' })).toBe(false);
    expect(mediaCloudUploadsEnabled({ ...base, CLAUDE_MEM_CLOUD_SYNC_HUB_URL: ' ' })).toBe(false);
    expect(mediaCloudUploadsEnabled({ ...base, CLAUDE_MEM_CLOUD_SYNC_TOKEN: '' })).toBe(false);
  });

  it('uploads nothing when uploads are disabled, while text still syncs', async () => {
    const pro = makeFakePro();
    const hub = makeHub();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'disabled');
    storeLinkedObservation(device, capture);
    await mediaCloud(device, pro, false).drain();
    expect(pro.calls).toHaveLength(0);
    await makeCloudSync(device, DEVICE_A, hub).flush();
    expect(hub.log).toHaveLength(1);
  });

  it('offline spool, backoff, reconnect and a lost acknowledgement reuse the stable attachment ID', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'offline');
    const sync = mediaCloud(device, pro);
    const row = () => device.db.prepare('SELECT upload_state, upload_attempts, upload_retry_at, upload_error FROM media_attachments WHERE id=?').get(capture.ref.id) as any;

    pro.state.offline = true;
    expect(await sync.drain()).toMatchObject({ uploaded: 0, uploadRetries: 1 });
    expect(row()).toMatchObject({ upload_state: 'pending', upload_attempts: 1, upload_error: 'storage_unavailable' });
    expect(row().upload_retry_at).toBeGreaterThan(clock);

    // Within the backoff window nothing is attempted.
    const callsBefore = pro.calls.length;
    await sync.drain();
    expect(pro.calls.length).toBe(callsBefore);

    // Reconnect, but the server's acknowledgement is lost after it committed.
    pro.state.offline = false;
    pro.state.loseNextUploadResponse = true;
    clock = row().upload_retry_at;
    await sync.drain();
    expect(row()).toMatchObject({ upload_state: 'pending', upload_attempts: 2 });
    expect(pro.objects.has(capture.ref.id)).toBe(true);

    // Replay after the backoff: same ID, server replay, one object.
    clock = row().upload_retry_at;
    expect(await sync.drain()).toMatchObject({ uploaded: 1 });
    expect(row()).toMatchObject({ upload_state: 'uploaded', upload_error: null });
    expect(new Set(pro.uploads().filter(call => call.manifest).map(call => call.manifest.id))).toEqual(new Set([capture.ref.id]));
    expect(pro.objects.size).toBe(1);

    // Re-capturing the same event reuses the durable ID and uploads nothing new.
    const replay = await captureImage(device, 'offline');
    expect(replay.ref.id).toBe(capture.ref.id);
    await sync.drain();
    expect(pro.objects.size).toBe(1);
  });

  it('a six-hour outage never exhausts uploads or deletions: backoff caps at one hour, then recovery completes both', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const pending = await captureImage(device, 'outage-upload');
    const doomed = await captureImage(device, 'outage-delete', otherPng);
    const sync = mediaCloud(device, pro);
    await sync.drain(); // both uploaded
    device.db.transaction(() => {
      device.db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(doomed.sessionDbId);
    })();
    device.db.prepare("UPDATE media_attachments SET upload_state='pending' WHERE id=?").run(pending.ref.id);
    pro.objects.delete(pending.ref.id);
    pro.state.offline = true;
    const outageEnd = clock + 6 * 60 * 60 * 1000;
    let drains = 0;
    while (clock < outageEnd) {
      await sync.drain();
      drains++;
      const next = Math.min(
        (device.db.prepare('SELECT upload_retry_at AS t FROM media_attachments WHERE id=?').get(pending.ref.id) as any).t,
        (device.db.prepare('SELECT retry_at AS t FROM media_cloud_deletions WHERE attachment_id=?').get(doomed.ref.id) as any).t,
      );
      expect(next - clock).toBeLessThanOrEqual(60 * 60 * 1000);
      clock = Math.max(clock + 1, next);
    }
    const upload = device.db.prepare('SELECT upload_state, upload_attempts, upload_error FROM media_attachments WHERE id=?').get(pending.ref.id) as any;
    const deletion = device.db.prepare('SELECT attempts, last_error, retry_at FROM media_cloud_deletions WHERE attachment_id=?').get(doomed.ref.id) as any;
    expect(upload.upload_state).toBe('pending');
    expect(upload.upload_attempts).toBeGreaterThan(10);
    expect(deletion.attempts).toBeGreaterThan(10);
    expect(deletion.last_error).toBe('storage_unavailable');
    expect(deletion.retry_at).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(drains).toBeGreaterThan(10);

    pro.state.offline = false;
    clock += 60 * 60 * 1000;
    expect(await sync.drain()).toMatchObject({ uploaded: 1, deleted: 1 });
    expect(device.db.prepare('SELECT upload_state FROM media_attachments WHERE id=?').get(pending.ref.id)).toEqual({ upload_state: 'uploaded' });
    expect(pro.tombstones.has(doomed.ref.id)).toBe(true);
  });

  it('auth refusal (402) backs off without consuming a budget', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'lapsed');
    const sync = mediaCloud(device, pro);
    for (let attempt = 0; attempt < 12; attempt++) {
      pro.state.failNextUploadStatus = { status: 402, error: 'subscription_inactive' };
      await sync.drain();
      clock += 60 * 60 * 1000;
    }
    expect(device.db.prepare('SELECT upload_state, upload_attempts FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ upload_state: 'pending', upload_attempts: 12 });
    await sync.drain();
    expect(device.db.prepare('SELECT upload_state FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ upload_state: 'uploaded' });
  });

  it('transient server failures retry; checksum mismatch and a cloud tombstone are final', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const first = await captureImage(device, 'transient');
    const sync = mediaCloud(device, pro);
    pro.state.failNextUploadStatus = { status: 503, error: 'storage_unavailable' };
    await sync.drain();
    expect(device.db.prepare('SELECT upload_state FROM media_attachments WHERE id=?').get(first.ref.id)).toEqual({ upload_state: 'pending' });
    clock += 60 * 60 * 1000;
    await sync.drain();
    expect(device.db.prepare('SELECT upload_state FROM media_attachments WHERE id=?').get(first.ref.id)).toEqual({ upload_state: 'uploaded' });

    const second = await captureImage(device, 'mismatch', otherPng);
    pro.state.failNextUploadStatus = { status: 409, error: 'checksum_mismatch' };
    await sync.drain();
    expect(device.db.prepare('SELECT upload_state, upload_error FROM media_attachments WHERE id=?').get(second.ref.id)).toEqual({ upload_state: 'failed', upload_error: 'checksum_mismatch' });
    const uploadsAfter = pro.uploads().length;
    clock += 60 * 60 * 1000;
    await sync.drain();
    expect(pro.uploads().length).toBe(uploadsAfter);

    const third = await captureImage(device, 'tombstoned', await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());
    pro.tombstones.add(third.ref.id);
    await sync.drain();
    expect(device.db.prepare('SELECT upload_state, upload_error FROM media_attachments WHERE id=?').get(third.ref.id)).toEqual({ upload_state: 'failed', upload_error: 'media_not_found' });
  });

  it('never sends the owner-only source locator', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'locator', png, { source_shape: 'trusted_tool_file', source_locator: { kind: 'local_file', path: '/Users/someone/private/shot.png' } });
    await mediaCloud(device, pro).drain();
    const [upload] = pro.uploads();
    expect(upload.manifest.provenance.source_locator).toBeUndefined();
    expect(JSON.stringify(upload.manifest)).not.toContain('/Users/someone');
    expect(upload.manifest.id).toBe(capture.ref.id);
  });
});

function deleteSession(device: Device, sessionDbId: number) {
  device.db.transaction(() => {
    const memory = (device.db.prepare('SELECT memory_session_id FROM sdk_sessions WHERE id=?').get(sessionDbId) as { memory_session_id: string }).memory_session_id;
    device.db.prepare('DELETE FROM observations WHERE memory_session_id=?').run(memory);
    device.db.prepare('DELETE FROM sdk_sessions WHERE id=?').run(sessionDbId);
  })();
}

describe('deletion wins over uploads', () => {

  it('offline deletion of a never-attempted image cancels its upload; reconnect cannot recreate it', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'cancel');
    storeLinkedObservation(device, capture);
    deleteSession(device, capture.sessionDbId);
    expect(device.db.prepare('SELECT state, upload_state, upload_attempts FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ state: 'deleted', upload_state: 'cancelled', upload_attempts: 0 });
    expect(device.db.prepare('SELECT COUNT(*) AS n FROM media_cloud_deletions').get()).toEqual({ n: 0 });
    // Reconnect, a restart (new worker over the same database) and many hours later: still nothing.
    await mediaCloud(device, pro).drain();
    clock += 24 * 60 * 60 * 1000;
    await mediaCloud(device, pro).drain();
    expect(pro.calls).toHaveLength(0);
    expect(pro.objects.size).toBe(0);
  });

  it('a deterministically failed upload that was attempted still gets a cloud deletion (its ack may have been lost)', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'failed-then-deleted');
    storeLinkedObservation(device, capture);
    pro.state.failNextUploadStatus = { status: 415, error: 'unsupported_format' };
    await mediaCloud(device, pro).drain();
    expect(device.db.prepare('SELECT upload_state, upload_attempts FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ upload_state: 'failed', upload_attempts: 1 });
    deleteSession(device, capture.sessionDbId);
    expect(device.db.prepare('SELECT attachment_id FROM media_cloud_deletions').all()).toEqual([{ attachment_id: capture.ref.id }]);
    await mediaCloud(device, pro).drain();
    expect(pro.tombstones.has(capture.ref.id)).toBe(true);
  });

  it('deletion of an uploaded or possibly-landed image queues a durable cloud deletion that survives failures', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const uploaded = await captureImage(device, 'uploaded');
    storeLinkedObservation(device, uploaded);
    const sync = mediaCloud(device, pro);
    await sync.drain();
    expect(pro.objects.has(uploaded.ref.id)).toBe(true);

    const lost = await captureImage(device, 'lost-ack', otherPng);
    pro.state.offline = true;
    await sync.drain(); // attempted; the outcome is unknown
    pro.state.offline = false;

    deleteSession(device, uploaded.sessionDbId);
    deleteSession(device, lost.sessionDbId);
    expect((device.db.prepare('SELECT attachment_id FROM media_cloud_deletions ORDER BY attachment_id').all() as any[]).map(row => row.attachment_id))
      .toEqual([uploaded.ref.id, lost.ref.id].sort());

    pro.state.offline = true;
    clock += 60 * 60 * 1000;
    expect(await sync.drain()).toMatchObject({ deleted: 0, deleteRetries: 2 });
    pro.state.offline = false;
    clock += 60 * 60 * 1000;
    expect(await sync.drain()).toMatchObject({ deleted: 2, uploaded: 0 });
    expect(pro.objects.has(uploaded.ref.id)).toBe(false);
    expect(pro.tombstones.has(lost.ref.id)).toBe(true);
    expect(device.db.prepare('SELECT COUNT(*) AS n FROM media_cloud_deletions').get()).toEqual({ n: 0 });
  });

  it('a deletion that lands while an upload is in flight removes the late cloud copy', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'inflight');
    storeLinkedObservation(device, capture);
    const sync = mediaCloud(device, pro);
    pro.state.duringUpload = () => deleteSession(device, capture.sessionDbId);
    await sync.drain();
    expect(pro.objects.has(capture.ref.id)).toBe(true);
    expect(device.db.prepare('SELECT state, upload_state FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ state: 'deleted', upload_state: 'cancelled' });
    await sync.drain();
    expect(pro.objects.has(capture.ref.id)).toBe(false);
    expect(pro.tombstones.has(capture.ref.id)).toBe(true);
    // The cloud tombstone also refuses any later replay of the same ID.
    expect(pro.uploads()).toHaveLength(1);
  });

  it('observation deletion alone keeps event-retained media and its upload', async () => {
    const pro = makeFakePro();
    const device = makeDevice('a');
    const capture = await captureImage(device, 'event-retained');
    const observationId = storeLinkedObservation(device, capture);
    await mediaCloud(device, pro).drain();
    device.db.prepare('DELETE FROM observations WHERE id=?').run(observationId);
    expect(device.db.prepare('SELECT state, upload_state FROM media_attachments WHERE id=?').get(capture.ref.id)).toEqual({ state: 'ready', upload_state: 'uploaded' });
    expect(device.db.prepare('SELECT COUNT(*) AS n FROM media_cloud_deletions').get()).toEqual({ n: 0 });
  });
});

describe('replica publication guards', () => {
  it('an unresolved replica reads as its own state, not failed; downloads are capped at four concurrent', async () => {
    const device = makeDevice('b');
    const ids = Array.from({ length: 5 }, (_, index) => `3f8a1c2e-5b6d-4e7f-8a9b-00000000000${index}`);
    const change = observationChange(1, '11', DEVICE_A, { metadata: { cmem_media_v1: { version: 1, attachments: ids.map(id => ({ id, label: 'event1_image1', inspection: 'uninspected' })) } } });
    await new SyncClient(new SyncApply(device.db, { deviceId: DEVICE_B }), { hubUrl: 'https://hub.test', token: TOKEN, userId: 'u', deviceId: DEVICE_B, deviceName: 'b', wsEnabled: false, minPullGapMs: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ protocol_version: 2, epoch: '1', ops: [change], head_seq: '1', more: false }))) as typeof fetch }).pullOnce({ timeoutMs: 5_000 });
    expect(device.media.getMetadata(ids[0])).toMatchObject({ state: 'unresolved_replica', failureCode: null });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    const hanging = (async () => { requests++; await gate; return new Response('{"error":"media_not_found"}', { status: 404 }); }) as unknown as typeof fetch;
    const resolver = new MediaCloudReplicaResolver(device.media, new MediaCloudClient({ baseUrl: PRO, token: TOKEN, fetchImpl: hanging }));
    const pendingReads = ids.slice(0, 4).map(id => resolver.resolve(id).catch(error => error));
    await expect(resolver.resolve(ids[4])).rejects.toMatchObject({ code: 'media_not_ready' });
    expect(requests).toBe(4);
    release();
    for (const outcome of await Promise.all(pendingReads)) expect(outcome).toMatchObject({ code: 'media_not_ready' });
    // Slots free again after settling.
    await expect(resolver.resolve(ids[4])).rejects.toMatchObject({ code: 'media_not_ready' });
    expect(requests).toBe(5);
  });

  it('a replica deleted while its download ran is not resurrected', async () => {
    const device = makeDevice('b');
    const apply = new SyncApply(device.db, { deviceId: DEVICE_B });
    const change = observationChange(1, '11', DEVICE_A, { metadata: { cmem_media_v1: { version: 1, attachments: [{ id: VALID_ID, label: 'event1_image1', inspection: 'uninspected' }] } } });
    await new SyncClient(apply, { hubUrl: 'https://hub.test', token: TOKEN, userId: 'u', deviceId: DEVICE_B, deviceName: 'b', wsEnabled: false, minPullGapMs: 0,
      fetchImpl: (async () => new Response(JSON.stringify({ protocol_version: 2, epoch: '1', ops: [change], head_seq: '1', more: false }))) as typeof fetch }).pullOnce({ timeoutMs: 5_000 });
    const webp = await sharp(png).webp({ lossless: true }).toBuffer();
    const variant = { sha256: createHash('sha256').update(webp).digest('hex'), width: 320, height: 180, byteLength: webp.length, mimeType: 'image/webp' as const, bytes: webp };
    device.db.prepare('DELETE FROM observations').run();
    expect(() => device.media.publishReplica(VALID_ID, { recipe: 'screenshot-v1', encoderVersion: 'sharp-0.34.4/vips-8.17.2', viewer: variant, llm: variant }))
      .toThrow(MediaError);
    expect(device.db.prepare('SELECT state FROM media_attachments WHERE id=?').get(VALID_ID)).toEqual({ state: 'deleted' });
    device.media.reconcile(Date.now() + 1);
    expect(existsSync(join(device.media.root, VALID_ID))).toBe(false);
  });
});
