import { afterEach, expect, test } from 'bun:test';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { WorkStateSource } from '../../../../src/services/work-view/data-source.mjs';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { SharedWorkSync } from '../../../../src/services/work-view/SharedWorkSync.js';
import { getSharedReviews, publishSharedReview, readSharedReview } from '../../../../src/services/work-view/shared-reviews.mjs';
import { buildContentOperation } from '../../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../../src/services/sync/SyncClient.js';
import { SyncApply } from '../../../../src/services/sync/SyncApply.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
const closes: Array<() => unknown> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture(device: string) {
  const dir = mkdtempSync(join(tmpdir(), 'review-api-')); closes.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.db'), ledger = join(dir, 'work'); mkdirSync(ledger);
  const store = new SessionStore(path); store.setLocalSyncDeviceId(device); closes.push(() => store.close());
  const source = new WorkStateSource({ databasePath: path, localDeviceId: device }); closes.push(() => source.close());
  return { dir, path, ledger, store, source, device };
}
function transfer(a: ReturnType<typeof fixture>, b: ReturnType<typeof fixture>) {
  const apply = new SyncApply(b.store.db, { deviceId: b.device });
  const cursor = BigInt(apply.getCursor());
  const rows = a.store.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as any[];
  apply.applyOps(decodeChanges(rows.map((row, i) => ({ seq: String(cursor + BigInt(i + 1)), ...buildContentOperation({ kind: 'work_state', originDeviceId: a.device, originLocalId: String(row.id), entityRev: String(row.sync_rev),
    payload: { project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) } }) }))), { epoch: '1' });
}
async function server(f: ReturnType<typeof fixture>) {
  let enabled = false;
  const sync = new SharedWorkSync(f.store.db, { databasePath: f.path, directory: f.ledger, deviceId: f.device, enabled: true, notify() {} }); closes.push(() => sync.close());
  const routes = new WorkViewRoutes({ databasePath: f.path, reviewPath: join(f.dir, 'review.db'), ledgerDir: f.ledger, humanCopy: null, autoRefresh: null,
    getLocalDeviceId: () => f.device, getSharedStatus: () => ({ enabled }), saveSharedReview: input => sync.saveReview(input), prepareSharedOwnerAction: () => sync.prepareOwnerAction() });
  closes.push(() => routes.close());
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  const listener = app.listen(0, '127.0.0.1'); closes.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as any).port}`;
  return { enable(value: boolean) { enabled = value; }, async snapshot() { return (await fetch(`${origin}/api/work-view`)).json(); },
    async save(request: any, checked: boolean, fields: any = {}, headers: any = {}) { return fetch(`${origin}/api/work-view/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify({ requestId: request.id, expectedFingerprint: request.contentFingerprint, checked, ...fields }) }); } };
}

test('real worker projections share review identity, retain explicit local uncheck, and never auto-export on enable', async () => {
  const a = fixture('a'), b = fixture('b');
  a.store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { task: 'Release viewer', status: 'done', request_id: 'release', human_request: 'Release the viewer', request_complete: true } });
  b.store.appendWorkStateEntry({ project: 'padding', listName: 'padding', fields: {} }); transfer(a, b);
  const ar = a.source.read().agentView.humanRequests[0], br = b.source.read().agentView.humanRequests.find((r: any) => r.explicitRequestId === 'release')!;
  expect(ar.sharedReviewDescriptor?.complete).toBe(true);
  expect(br.sharedReviewDescriptor).toEqual(ar.sharedReviewDescriptor);
  publishSharedReview(a.store.db, { deviceId: 'a', project: 'repo', descriptor: ar.sharedReviewDescriptor!, checked: true, expectedHash: null }); transfer(a, b);
  const api = await server(b), first = (await api.snapshot()).humanRequests.find((r: any) => r.explicitRequestId === 'release');
  expect(first.review).toMatchObject({ checked: true, mode: 'local' });
  const count = () => (b.store.db.query('SELECT count(*) AS n FROM work_state_entries').get() as any).n;
  const before = count(), local = await api.save(first, false);
  expect(local.status).toBe(200); expect((await local.json()).save).toEqual({ scope: 'local', state: 'saved' });
  expect((await api.snapshot()).humanRequests.find((r: any) => r.explicitRequestId === 'release').review.checked).toBe(false);
  expect(count()).toBe(before);
  api.enable(true);
  const shared = (await api.snapshot()).humanRequests.find((r: any) => r.explicitRequestId === 'release');
  expect(shared.review).toMatchObject({ checked: true, mode: 'shared' }); expect(count()).toBe(before);
  expect((await api.save(shared, false)).status).toBe(409);
  expect((await api.save(shared, false, { expectedReviewHash: shared.review.hash }, { Origin: 'https://foreign.invalid' })).status).toBe(403);
  const saved = await api.save(shared, false, { expectedReviewHash: shared.review.hash });
  expect(saved.status).toBe(200); expect((await saved.json()).save).toEqual({ scope: 'shared', state: 'queued' });
  expect(getSharedReviews(b.store.db, 'b').records.size).toBeGreaterThan(0);
  const afterShared = (await api.snapshot()).humanRequests.find((r: any) => r.explicitRequestId === 'release');
  expect((await api.save(afterShared, true, { expectedReviewHash: afterShared.review.hash })).status).toBe(200);
  api.enable(false);
  expect((await api.snapshot()).humanRequests.find((r: any) => r.explicitRequestId === 'release').review.checked).toBe(true);
});

test('the review API refuses a pre-loser token and accepts a fresh all-head decision', async () => {
  const a = fixture('a'), b = fixture('b');
  a.store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { task: 'Release viewer', status: 'done', request_id: 'release', human_request: 'Release the viewer', request_complete: true } });
  transfer(a, b);
  const ad = a.source.read().agentView.humanRequests[0].sharedReviewDescriptor!;
  const bd = b.source.read().agentView.humanRequests[0].sharedReviewDescriptor!;
  publishSharedReview(a.store.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: false, expectedHash: null, now: 100 }); transfer(a, b);
  const base = readSharedReview(getSharedReviews(a.store.db, 'a'), ad).hash;
  publishSharedReview(a.store.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: false, expectedHash: base, now: 101 });
  publishSharedReview(b.store.db, { deviceId: 'b', project: 'repo', descriptor: bd, checked: true, expectedHash: base, now: 102 });
  const api = await server(b); api.enable(true);
  const before = (await api.snapshot()).humanRequests[0];
  transfer(a, b);
  const stale = await api.save(before, true, { expectedReviewHash: before.review.hash });
  expect(stale.status).toBe(409);
  const after = (await stale.json()).snapshot.humanRequests[0];
  expect(after.review.recordHash).toBe(before.review.recordHash);
  expect(after.review.hash).not.toBe(before.review.hash);
  expect(after.review).toMatchObject({ conflict: true, checked: false });
  const fresh = await api.save(after, true, { expectedReviewHash: after.review.hash });
  expect(fresh.status).toBe(200);
  expect((await fresh.json()).humanRequests[0].review).toMatchObject({ checked: true, conflict: false });
});
