import { afterEach, expect, it } from 'bun:test';
import express from 'express';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { getNativeContentOperation } from '../../../../src/services/sync/CloudSync.js';
import { SyncRecovery } from '../../../../src/services/sync/SyncRecovery.js';
import { SyncRecoveryReader } from '../../../../src/services/sync/SyncRecoveryReader.js';
import { SyncRecoveryRoutes } from '../../../../src/services/worker/http/routes/SyncRecoveryRoutes.js';
import { initializeConflictRecoverySchema, SyncConflictRecovery } from '../../../../src/services/sync/SyncConflictRecovery.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const deviceId = 'recovery-route-fixture';
const flags = { deviceId, sharedWorkWritesEnabled: false, workStateSupported: true };
const scope = { project: 'fixture', from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', kinds: ['observation'] };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-route-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.db'); const db = new Database(path);
  cleanup.push(() => { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); });
  const store = new SessionStore(db);
  initializeConflictRecoverySchema(db);
  db.prepare("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES ('fixture-c','fixture-m','fixture','2026-07-01',1782864000000,'active')").run();
  const id = store.storeObservation('fixture-m', 'fixture', { type: 'discovery', title: 'PRIVATE-PREVIEW-CONTENT', narrative: 'private body', subtitle: null, facts: [], concepts: [], files_read: [], files_modified: [] }, 1, 0).id;
  db.prepare('UPDATE observations SET created_at_epoch=1782864000000,synced_at=1782864000000 WHERE id=?').run(id);
  db.prepare("INSERT INTO sync_launch_exclusions(kind,origin_local_id,through_rev) VALUES ('observation',?,'1')").run(String(id));
  db.prepare("INSERT INTO sync_state(k,v) VALUES ('epoch','1')").run();
  db.exec('PRAGMA journal_mode=DELETE');
  const recovery = new SyncRecovery(db, deviceId, { flags: () => flags, snapshotNative: (kind, id) => getNativeContentOperation(db, kind, id, deviceId) });
  const reader = new SyncRecoveryReader(path, deviceId, () => flags); cleanup.push(() => reader.close());
  const conflicts = new SyncConflictRecovery(db, { deviceId, userId:'fixture',authToken:'fixture',hubUrl:'https://fixture.invalid',
    readEvidence:(kind,id)=>reader.conflictEvidence(kind,id),listEvidence:limit=>reader.conflicts(limit),
    fetch:(async()=>{throw new Error('Unexpected hub request');}) as typeof fetch });
  let notifications = 0;
  const app = express(); app.use(express.json());
  new SyncRecoveryRoutes({ getCloudSync: () => ({ recovery, notify: () => { notifications++; } }), getSyncRecoveryReader: () => reader, getSyncConflictRecovery: () => conflicts } as any).setupRoutes(app);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/sync/recovery${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { db, id:String(id), reader, url, post, notifications: () => notifications };
}

it('HTTP preview is read-only, sample-free and never wakes uploads; create and resume are separate exact actions', async () => {
  const f = await fixture();
  const before = f.db.serialize();
  const response = await f.post('/preview', scope); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const preview = await response.json() as any;
  expect(preview.count).toBe(1); expect(JSON.stringify(preview)).not.toContain('PRIVATE-PREVIEW-CONTENT');
  expect(f.db.serialize()).toEqual(before); expect(f.notifications()).toBe(0);
  const inventory = await fetch(`${f.url}/api/sync/recovery/inventory`); expect(inventory.status).toBe(200);
  expect(f.db.serialize()).toEqual(before);
  const created = await f.post('/jobs', { scope: preview.scope, previewToken: preview.previewToken });
  const job = await created.json() as any; expect(job.status).toBe('paused'); expect(f.notifications()).toBe(0);
  expect((await f.post(`/jobs/${job.id}/transition`, { action: 'resume' })).status).toBe(400);
  expect((await f.post(`/jobs/${job.id}/transition`, { action: 'resume', expectedEpoch: '1' })).status).toBe(200);
  expect(f.notifications()).toBe(1);
});

it('rejects foreign origins, proxy hosts, malformed scope and arbitrary repair bodies without mutations', async () => {
  const f = await fixture(); const before = f.db.serialize();
  for (const headers of [ { Origin: 'https://foreign.test' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Forwarded-For': '127.0.0.1' }, { Host: 'foreign.test' } ]) {
    expect((await f.post('/preview', scope, headers)).status).toBe(403);
  }
  expect((await f.post('/preview', { ...scope, force: true })).status).toBe(400);
  expect((await f.post('/preview', { ...scope, kinds: ['observation', 'observation'] })).status).toBe(400);
  expect((await f.post('/conflicts/apply', { previewToken: 'a'.repeat(32), body: 'arbitrary' })).status).toBe(400);
  expect((await f.post('/conflicts/preview', { kind: 'observation', originLocalId: '1', choice: 'hub_current' })).status).toBe(400);
  expect(f.db.serialize()).toEqual(before); expect(f.notifications()).toBe(0);
});

it('keeps HTTP responsive while an isolated recovery scan is waiting on SQLite', async () => {
  const f = await fixture(); await f.reader.inventory();
  f.db.exec('BEGIN EXCLUSIVE');
  let completed = false;
  const scan = f.reader.inventory().then(value => { completed = true; return value; });
  await Bun.sleep(50);
  expect((await fetch(`${f.url}/health`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
  expect(completed).toBe(false);
  f.db.exec('ROLLBACK');
  expect((await scan).excludedCurrent.observation).toBe(1);
}, 10_000);

it('returns the supported bound error without truncating or uploading conflict evidence', async () => {
  const f=await fixture(); const entityId=getNativeContentOperation(f.db,'observation',f.id,deviceId)!.operation;
  const insert=f.db.prepare("INSERT INTO sync_pull_quarantine(epoch,seq,entity_id,entity_rev,reason,raw_body,created_at_epoch) VALUES('1',?,?,?,'retained','PRIVATE',1)");
  f.db.transaction(()=>{for(let index=0;index<1025;index++)insert.run(String(index),JSON.parse(entityId.body).id,String(index));})();
  const response=await f.post('/conflicts/preview',{kind:'observation',originLocalId:f.id,choice:'local_current'});
  expect(response.status).toBe(409);expect(await response.json()).toEqual({code:'repair_evidence_too_large'});
  expect(f.notifications()).toBe(0);
});
