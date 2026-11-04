import { afterEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { SharedLedgerAdapter } from '../../../../src/services/work-view/shared-ledger-adapter.mjs';
import { readSharedRecords } from '../../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../../src/services/work-view/shared-records.mjs';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture({ enabled = false, failCommit = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shared-ledger-route-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'source.db'), ledgerDir = join(directory, 'work-view');
  const store = new SessionStore(databasePath); mkdirSync(ledgerDir);
  cleanup.push(() => store.close());
  const adapter = enabled ? new SharedLedgerAdapter(store.db, { directory: ledgerDir, deviceId: 'route-device' }) : null;
  if (failCommit) store.db.exec("CREATE TRIGGER reject_shared_commit BEFORE INSERT ON work_state_entries WHEN NEW.list_name='__my_work_v1:commit' BEGIN SELECT RAISE(ABORT, 'fixture durable write refused'); END");
  const calls: Array<{ file: string; value: unknown }> = [];
  const status = { enabled: true, pending: 2, invalid: 1, unsupported: 0, conflicts: [], files: [{ file: 'story.json', message: 'Retained for review' }] };
  const routes = new WorkViewRoutes({ databasePath, ledgerDir, humanCopy: null, autoRefresh: null, pollIntervalMs: 60_000,
    reviewPath: join(directory, 'review.db'), setupStatePath: join(directory, 'setup.json'), settingsPath: join(directory, 'settings.json'),
    getLocalDeviceId: () => 'route-device',
    ...(enabled ? { saveSharedLedgerFile: (file: string, value: unknown) => { calls.push({ file, value }); adapter!.saveFile(file, value); }, getSharedStatus: () => status } : {}),
  });
  cleanup.push(() => routes.close());
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  let server!: Server;
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/work-view/shared-ledger`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  return { directory, ledgerDir, store, routes, origin, post, calls, status };
}

const story = { narrative: 'A durable shared story', preferences: [] };

test('the default route refuses shared writes and advertises disabled status without a capability', async () => {
  const f = await fixture();
  const response = await f.post({ file: 'story.json', value: story });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'Shared work persistence is unavailable.' });
  expect(f.calls).toEqual([]);
  expect(f.store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get()).toEqual({ count: 0 });
  const full = await (await fetch(`${f.origin}/api/work-view`)).json();
  expect(full.sharedState.enabled).toBe(false);
  expect(full).not.toHaveProperty('sharedPersistenceVersion');
  const overview = await (await fetch(`${f.origin}/api/work-view/overview`)).json();
  expect(overview.model.sharedState.enabled).toBe(false);
});

test('the enabled route commits the narrow story write and exposes capability and diagnostics in views', async () => {
  const f = await fixture({ enabled: true });
  const response = await f.post({ file: 'story.json', value: story });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ saved: true });
  expect(f.calls).toEqual([{ file: 'story.json', value: story }]);
  expect(readSharedRecords(f.store.db, { deviceId: 'route-device' }).records.get(sharedRecordKey('story', 'current'))?.value).toEqual(story);
  expect(JSON.parse(readFileSync(join(f.ledgerDir, 'story.json'), 'utf8'))).toEqual(story);
  const full = await (await fetch(`${f.origin}/api/work-view`)).json();
  expect(full.sharedPersistenceVersion).toBe(1);
  expect(full.sharedState).toMatchObject(f.status);
  const overview = await (await fetch(`${f.origin}/api/work-view/overview`)).json();
  expect(overview.model.sharedState).toMatchObject(f.status);
});

test('foreign origins, forwarded clients and non-JSON requests cannot invoke the shared writer', async () => {
  const f = await fixture({ enabled: true });
  const body = { file: 'story.json', value: story };
  expect((await f.post(body, { Origin: 'https://foreign.example' })).status).toBe(403);
  expect((await f.post(body, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  expect((await f.post(body, { 'X-Forwarded-For': '198.51.100.20' })).status).toBe(403);
  expect((await f.post(body, { 'Content-Type': 'text/plain' })).status).toBe(403);
  expect((await fetch(`${f.origin}/api/work-view/shared-ledger`, { method: 'POST', headers: { Origin: f.origin } })).status).toBe(403);
  expect(f.calls).toEqual([]);
});

test('unknown files, missing values and extra fields are rejected before the shared writer', async () => {
  const f = await fixture({ enabled: true });
  for (const body of [
    { file: 'request-groups.json', value: story },
    { file: '../story.json', value: story },
    { file: 'story.json' },
    { file: 'story.json', value: [] },
    { file: 'story.json', value: story, extra: 'not allowed' },
  ]) expect((await f.post(body)).status).toBe(400);
  expect(f.calls).toEqual([]);
});

test('a failed durable commit reports failure without a success response or partial file', async () => {
  const f = await fixture({ enabled: true, failCommit: true });
  const response = await f.post({ file: 'story.json', value: story });
  expect(response.status).toBe(500);
  const result = await response.json();
  expect(result).not.toHaveProperty('saved');
  expect(result.error).toContain('fixture durable write refused');
  expect(f.calls).toHaveLength(1);
  expect(readSharedRecords(f.store.db, { deviceId: 'route-device' }).records.size).toBe(0);
  expect(f.store.db.query('SELECT * FROM my_work_file_state').all()).toEqual([]);
  expect(existsSync(join(f.ledgerDir, 'story.json'))).toBe(false);
});
