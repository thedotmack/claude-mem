import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express, { type Request } from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { MediaError } from '../../../../src/shared/media-contract.js';
import { convertMedia, type ConvertedMedia } from '../../../../src/services/media/converter.js';
import { MediaStore } from '../../../../src/services/media/store.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MediaRoutes, isTrustedMediaRead } from '../../../../src/services/worker/http/routes/MediaRoutes.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const ID = '11111111-1111-4111-8111-111111111111';
const MISSING_ID = '22222222-2222-4222-8222-222222222222';
const SCRATCH = join(import.meta.dir, '../../../../.scratch');
/** A valid trusted-file provenance whose locator must never leave through generic metadata. */
const fixtureProvenance = (attachmentId: string, path: string) => ({
  version: 1, attachment_id: attachmentId, platform: 'claude-code', event_identity: { kind: 'platform_event', id: 'toolu_fixture' },
  source_shape: 'trusted_tool_file', source_pointer: '/content/1/source/data', source_index: 0, source_sha256: 'a'.repeat(64),
  recipe: 'screenshot-v1', source_locator: { kind: 'local_file', path },
});
let converted: ConvertedMedia;
let dir: string;
let db: Database;
let sessions: SessionStore;
let media: MediaStore;
let server: Server;
let base: string;
let storeAccesses: number;

beforeAll(async () => {
  const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 1 } } }).png().toBuffer();
  converted = await convertMedia(png, 'image/png');
});

beforeEach(async () => {
  // Project-local scratch (gitignored), never the system temp directory.
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'media-routes-')));
  db = new Database(':memory:');
  sessions = new SessionStore(db);
  media = new MediaStore(db, dir);
  const variants = Object.fromEntries(['viewer', 'llm'].map(name => {
    const v = converted[name as 'viewer' | 'llm'];
    return [name, { sha256: v.sha256, width: v.width, height: v.height, byteLength: v.byteLength, mimeType: v.mimeType }];
  }));
  db.prepare(`INSERT INTO sdk_sessions(id,content_session_id,memory_session_id,project,platform_source,started_at,started_at_epoch,status)
    VALUES(1,'route-content','route-memory','route-project','claude','2026-10-02T00:00:00Z',1,'completed')`).run();
  db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,encoder_version,variants,created_at)
    VALUES(?,?,'{"source_locator":{"path":"/fixture-private/original.png"},"source_pointer":"/content/1/source/data"}','screenshot-v1','ready',?,?,1)`)
    .run(ID, 'route-replay', converted.encoderVersion, JSON.stringify(variants));
  mkdirSync(join(media.root, ID), { recursive: true });
  for (const name of ['viewer', 'llm'] as const) writeFileSync(join(media.root, ID, name + '.webp'), converted[name].bytes);
  storeAccesses = 0;
  const app = express();
  new MediaRoutes(() => { storeAccesses++; return media; }).setupRoutes(app);
  // Exercise the existing deletion API and real v61 triggers; no separate
  // attachment deletion route or production worker/service is introduced.
  new DataRoutes({} as any, { getSessionStore: () => sessions, getCloudSync: () => null } as any,
    { getSession: () => undefined } as any, { broadcast: () => {} } as any, {} as any, Date.now()).setupRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing route test address');
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (suffix = '', headers: Record<string, string> = {}) => fetch(`${base}/api/media/${ID}${suffix}`, { headers });
function expectPrivate(response: globalThis.Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
}
function seedObservation(id: number): void {
  db.prepare(`INSERT INTO observations(id,memory_session_id,project,type,title,created_at,created_at_epoch)
    VALUES(?,'route-memory','route-project','discovery','fixture','2026-10-02T00:00:00Z',1)`).run(id);
  db.prepare(`INSERT INTO observation_media_links(observation_id,attachment_id,event_key,label,inspection)
    VALUES(?,?,'route-event','image1','uninspected')`).run(id, ID);
}

describe('private UUID media routes', () => {
  it('sends no ETag on metadata, not-found or forbidden responses, even with express etag enabled', async () => {
    const missing = await fetch(`${base}/api/media/${MISSING_ID}`);
    expect(missing.status).toBe(404);
    const forbidden = await get('', { 'X-Forwarded-For': '10.0.0.5' });
    expect(forbidden.status).toBe(403);
    const metadata = await get();
    for (const response of [metadata, missing, forbidden]) {
      expectPrivate(response);
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect((await metadata.json()).id).toBe(ID);
    expect((await missing.json()).code).toBe('media_not_found');
    expect((await forbidden.json()).code).toBe('unauthorized_owner');
    // A conditional request cannot turn a private read into a cacheable 304.
    expect((await get('', { 'If-None-Match': '*' })).status).toBe(200);
  });

  it('serves both validated variants, without paths, source provenance or cache validators', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(response.headers.get('etag')).toBeNull();
    const metadata = await response.json();
    expect(Object.keys(metadata).sort()).toEqual(['capturedAt', 'encoderVersion', 'failureCode', 'id', 'llm', 'recipe', 'state', 'viewer']);
    expect(metadata.capturedAt).toBe(1);
    expect(JSON.stringify(metadata)).not.toContain('fixture-private');
    expect(JSON.stringify(metadata)).not.toContain('source_pointer');
    for (const name of ['viewer', 'llm'] as const) {
      const image = await get('/' + name);
      expect(image.status).toBe(200);
      expectPrivate(image);
      expect(image.headers.get('content-type')).toBe('image/webp');
      expect(image.headers.get('etag')).toBeNull();
      expect(Buffer.from(await image.arrayBuffer())).toEqual(converted[name].bytes);
    }
  });

  it('permits only the same worker browser page, including loopback aliases', async () => {
    for (const origin of [base, base.replace('127.0.0.1', 'localhost')]) {
      expect((await get('/viewer', { Origin: origin, Referer: origin + '/viewer.html' })).status).toBe(200);
    }
    expect((await get('/viewer', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });

  it('denies foreign pages, other localhost ports, opaque origins and cross-site embedding before store access', async () => {
    const attacks = [
      { Origin: 'https://evil.example' }, { Origin: 'http://localhost:9999' }, { Origin: 'null' },
      { Origin: base + '/not-an-origin' }, { Referer: 'https://evil.example/page' },
      { Referer: 'http://localhost:9999/page', 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of attacks) {
      const response = await get('/viewer', headers);
      expect(response.status).toBe(403);
      expectPrivate(response);
      expect(await response.json()).toEqual({ error: 'Forbidden', code: 'unauthorized_owner' });
    }
    expect(storeAccesses).toBe(0);
  });

  it('denies proxy/client headers and DNS-rebinding Hosts before store access', async () => {
    for (const headers of [
      { 'X-Forwarded-For': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' },
      { 'X-Real-IP': '127.0.0.1' }, { 'X-Forwarded-Host': 'localhost' },
      { 'X-Forwarded-Proto': 'http' }, { 'X-Forwarded-For': '' }, { Host: 'evil.example' },
    ]) expect((await get('/viewer', headers)).status).toBe(403);
    expect(storeAccesses).toBe(0);
  });

  it('uses the socket peer, rejects LAN even when req.ip claims loopback, and validates Host syntax', () => {
    const request = (peer: string, host = '127.0.0.1:37777') => ({
      socket: { remoteAddress: peer }, ip: '127.0.0.1', protocol: 'http', headers: { host },
    } as unknown as Request);
    for (const peer of ['192.168.1.2', '10.0.0.1', '::ffff:192.168.1.2', '']) expect(isTrustedMediaRead(request(peer))).toBe(false);
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isTrustedMediaRead(request(peer))).toBe(true);
    for (const host of ['192.168.1.2:37777', 'evil@127.0.0.1:37777', '[::1]evil.example', 'localhost/secret', '']) expect(isTrustedMediaRead(request('127.0.0.1', host))).toBe(false);
  });

  it('rejects malformed IDs and variants, and never uses a query string as a file key', async () => {
    for (const id of ['..%2Fsettings.json', 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF', 'not-a-uuid']) {
      expect((await fetch(`${base}/api/media/${id}/viewer`)).status).toBe(400);
    }
    for (const variant of ['source', 'viewer.webp', 'settings.json']) expect((await get('/' + variant)).status).toBe(400);
    expect(storeAccesses).toBe(0);
    const privateFile = join(dir, 'unrelated-secret.txt');
    writeFileSync(privateFile, 'must-never-be-served');
    const response = await get('/viewer?path=' + encodeURIComponent(privateFile));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(converted.viewer.bytes);
  });

  it('does not expose nonexistent, tombstoned or non-ready image bytes', async () => {
    expect((await fetch(`${base}/api/media/${MISSING_ID}/viewer`)).status).toBe(404);
    db.prepare(`UPDATE media_attachments SET state='converting',variants=NULL,encoder_version=NULL WHERE id=?`).run(ID);
    expect((await get()).status).toBe(200);
    expect((await get('/viewer')).status).toBe(409);
    db.prepare(`UPDATE media_attachments SET state='deleted' WHERE id=?`).run(ID);
    expect((await get()).status).toBe(404);
    expect((await get('/viewer')).status).toBe(404);
  });

  it('rejects symlink leaves and symlink asset directories without returning target bytes', async () => {
    const secret = join(dir, 'unrelated-secret.txt');
    writeFileSync(secret, 'must-never-be-served');
    rmSync(join(media.root, ID, 'viewer.webp'));
    symlinkSync(secret, join(media.root, ID, 'viewer.webp'));
    const leaf = await get('/viewer');
    expect(leaf.status).toBe(503);
    expect(await leaf.text()).not.toContain('must-never-be-served');
    rmSync(join(media.root, ID), { recursive: true });
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'viewer.webp'), converted.viewer.bytes);
    symlinkSync(outside, join(media.root, ID), 'dir');
    expect((await get('/viewer')).status).toBe(503);
  });

  it('returns only safe failure codes for corrupt assets and backend exceptions', async () => {
    writeFileSync(join(media.root, ID, 'viewer.webp'), 'corrupt');
    const corrupt = await get('/viewer');
    expect(corrupt.status).toBe(503);
    expect(await corrupt.json()).toEqual({ error: 'Media request failed', code: 'checksum_mismatch' });
    media.getMetadata = () => { throw new Error('private /original/source.png and object-key'); };
    const error = await get();
    expect(error.status).toBe(503);
    expect(await error.json()).toEqual({ error: 'Media request failed', code: 'storage_unavailable' });
  });

  it('projects metadata fields even if a future store adds private properties', async () => {
    const original = media.getMetadata.bind(media);
    media.getMetadata = id => ({ ...original(id), object_key: '/fixture-private/key', source_locator: '/fixture-private/path' } as any);
    expect(await (await get()).text()).not.toContain('fixture-private');
  });

  it('rechecks deletion after pending I/O before sending image bytes', async () => {
    const original = media.readVariant.bind(media);
    media.readVariant = async (id, variant) => {
      const bytes = await original(id, variant);
      db.prepare(`UPDATE media_attachments SET state='deleted' WHERE id=?`).run(id);
      return bytes;
    };
    const response = await get('/viewer');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Media request failed', code: 'media_not_found' });
  });

  it('existing observation deletion retains another link, then makes an unreferenced asset unreadable', async () => {
    seedObservation(1); seedObservation(2);
    expect((await fetch(`${base}/api/observation/1`, { method: 'DELETE' })).status).toBe(200);
    expect((await get('/viewer')).status).toBe(200);
    expect((await fetch(`${base}/api/observation/2`, { method: 'DELETE' })).status).toBe(200);
    expect((await get('/viewer')).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE attachment_id=?').get(ID)).toEqual({ n: 1 });
    expect(readFileSync(join(media.root, ID, 'viewer.webp'))).toEqual(converted.viewer.bytes);
  });

  it('existing observation deletion preserves an event-retained asset, while session deletion tombstones it', async () => {
    db.prepare(`INSERT INTO media_events(event_key,session_db_id,platform,event_identity,created_at)
      VALUES('route-event',1,'claude-code','{"kind":"platform_event","id":"toolu-route"}',1)`).run();
    db.prepare(`INSERT INTO media_event_refs(event_key,attachment_id,label) VALUES('route-event',?,'image1')`).run(ID);
    seedObservation(1);
    expect((await fetch(`${base}/api/observation/1`, { method: 'DELETE' })).status).toBe(200);
    expect((await get('/viewer')).status).toBe(200);
    expect((await fetch(`${base}/api/sessions/claude/route-content`, { method: 'DELETE' })).status).toBe(200);
    expect((await get()).status).toBe(404);
    expect((await get('/viewer')).status).toBe(404);
  });
});

describe('phase 6 viewer provenance', () => {
  it('generic metadata never reads provenance: an invalid provenance row still reports readiness', async () => {
    // The beforeEach fixture provenance is deliberately not a valid MediaProvenance.
    const metadata = await get();
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).state).toBe('ready');
    const details = await get('/details');
    expect(details.status).toBe(503);
    expect(JSON.stringify(await details.json())).not.toContain('fixture-private');
  });

  it('only the owner details route reports source availability and carries the locator', async () => {
    const present = join(dir, 'present-source.png');
    writeFileSync(present, 'x');
    db.prepare('UPDATE media_attachments SET provenance=? WHERE id=?').run(JSON.stringify(fixtureProvenance(ID, present)), ID);
    const metadata = await (await get()).json();
    expect('sourceAvailability' in metadata).toBe(false);
    expect(JSON.stringify(metadata)).not.toContain(present);

    const details = await get('/details');
    expect(details.status).toBe(200);
    expectPrivate(details);
    expect(details.headers.get('etag')).toBeNull();
    expect(await details.json()).toEqual({
      id: ID, platform: 'claude-code', sourceShape: 'trusted_tool_file', sourceLocatorPath: present, sourceAvailability: 'file_present',
    });

    rmSync(present);
    expect((await (await get('/details')).json()).sourceAvailability).toBe('file_missing');
  });

  it('owner details use the same guard as pixels and never expose replica provenance', async () => {
    for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await get('/details', headers);
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain('fixture-private');
    }
    const replicaId = '33333333-3333-4333-8333-333333333333';
    db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,upload_state,origin,created_at)
      VALUES(?,?,'{"origin":"replica"}','screenshot-v1','failed','cancelled','replica',5)`).run(replicaId, 'replica:' + replicaId);
    const replicaMetadata = await (await fetch(`${base}/api/media/${replicaId}`)).json();
    expect(replicaMetadata).toMatchObject({ state: 'unresolved_replica', capturedAt: 5 });
    expect(await (await fetch(`${base}/api/media/${replicaId}/details`)).json()).toEqual({
      id: replicaId, platform: null, sourceShape: null, sourceLocatorPath: null, sourceAvailability: 'converted_only',
    });
    expect((await fetch(`${base}/api/media/${MISSING_ID}/details`)).status).toBe(404);
  });
});
