import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_LIMITS, MediaError } from '../../../../src/shared/media-contract.js';
import { MediaStore } from '../../../../src/services/media/store.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MEDIA_STATUS_MAX_IDS, MediaRoutes } from '../../../../src/services/worker/http/routes/MediaRoutes.js';

const READY = '11111111-1111-4111-8111-111111111111';
const CONVERTING = '22222222-2222-4222-8222-222222222222';
const FAILED = '33333333-3333-4333-8333-333333333333';
const REPLICA = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';
const DELETED = '66666666-6666-4666-8666-666666666666';
const SCRATCH = join(import.meta.dir, '../../../../.scratch');

let dir: string;
let db: Database;
let media: MediaStore;
let server: Server;
let base: string;
let resolved: string[];
let resolveReplica: (id: string) => Promise<void>;

function insert(id: string, state: string, origin: 'native' | 'replica' = 'native'): void {
  db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,upload_state,origin,created_at)
    VALUES(?,?,'{}','screenshot-v1',?,'cancelled',?,1)`).run(id, `status:${id}`, state, origin);
}

beforeEach(async () => {
  // Project-local scratch (gitignored), never the system temp directory.
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'media-status-')));
  db = new Database(':memory:');
  new SessionStore(db);
  media = new MediaStore(db, dir);
  insert(READY, 'ready');
  insert(CONVERTING, 'converting');
  insert(FAILED, 'failed');
  insert(REPLICA, 'failed', 'replica');
  insert(DELETED, 'deleted');
  resolved = [];
  resolveReplica = async (id) => { resolved.push(id); };
  const app = express();
  new MediaRoutes(() => media, id => resolveReplica(id)).setupRoutes(app);
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

const status = (ids: string, headers: Record<string, string> = {}) => fetch(`${base}/api/media/status?ids=${ids}`, { headers });

describe('GET /api/media/status', () => {
  it('answers every requested id in the gallery’s four states, privately and without cache validators', async () => {
    const response = await status([READY, CONVERTING, FAILED, REPLICA, MISSING, DELETED].join(','));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('etag')).toBeNull();
    expect(await response.json()).toEqual({ attachments: [
      { id: READY, state: 'ready' },
      { id: CONVERTING, state: 'pending' },
      { id: FAILED, state: 'rejected' },
      { id: REPLICA, state: 'pending' },
      { id: MISSING, state: 'deleted' },
      { id: DELETED, state: 'deleted' },
    ] });
  });

  it('resolves each id first, so a downloaded replica answers ready on the same call', async () => {
    resolveReplica = async (id) => {
      resolved.push(id);
      if (id === REPLICA) db.prepare(`UPDATE media_attachments SET state='ready' WHERE id=?`).run(id);
    };
    const body = await (await status(`${REPLICA},${READY},${REPLICA}`)).json();
    expect(body.attachments).toEqual([{ id: REPLICA, state: 'ready' }, { id: READY, state: 'ready' }]);
    // Duplicates are asked once.
    expect(resolved.sort()).toEqual([READY, REPLICA].sort());
  });

  it('keeps a replica whose download failed as pending instead of failing the whole strip', async () => {
    resolveReplica = async (id) => { if (id === REPLICA) throw new MediaError('checksum_mismatch'); };
    const body = await (await status(`${REPLICA},${READY}`)).json();
    expect(body.attachments).toEqual([{ id: REPLICA, state: 'pending' }, { id: READY, state: 'ready' }]);
  });

  it('refuses a missing, malformed or oversized id list with the bounded 400 code', async () => {
    expect(MEDIA_STATUS_MAX_IDS).toBe(MEDIA_LIMITS.maxObservationRefs);
    const tooMany = Array.from({ length: MEDIA_STATUS_MAX_IDS + 1 }, (_, index) => `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    for (const response of [
      await fetch(`${base}/api/media/status`),
      await status(''),
      await status(`${READY},not-a-uuid`),
      await status(tooMany.join(',')),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Media request failed', code: 'invalid_manifest' });
    }
    expect((await status(tooMany.slice(0, MEDIA_STATUS_MAX_IDS).join(','))).status).toBe(200);
  });

  it('uses the same trust guard as the pixels', async () => {
    for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await status(READY, headers);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('unauthorized_owner');
    }
    expect(resolved).toEqual([]);
    // A same-origin page fetch, as the gallery sends it (and as viewer-host forwards it).
    expect((await status(READY, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });

  it('answers 503 with the bounded code when storage cannot be read', async () => {
    db.close();
    const response = await status(READY);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('storage_unavailable');
    db = new Database(':memory:');
  });
});
