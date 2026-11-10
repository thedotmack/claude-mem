import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { ledgerRelativeName, registerSharedFileWriter } from '../../../src/services/work-view/shared-file-hooks.mjs';
import { groupIdFor, readLedger, writeJsonAtomic } from '../../../src/services/work-view/request-groups.mjs';
import { readSharedRecords, publishSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import { createHumanCopyInput, humanCopyFingerprint } from '../../../src/services/work-view/human-copy.mjs';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
function fixture(deviceId = 'device-a') {
  const dir = mkdtempSync(join(tmpdir(), 'shared-ledger-'));
  disposals.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'memory.db');
  const store = new SessionStore(databasePath);
  store.setLocalSyncDeviceId(deviceId);
  disposals.push(() => store.close());
  const directory = join(dir, 'work-view'); mkdirSync(directory);
  const adapter = new SharedLedgerAdapter(store.db, { directory, deviceId });
  return { dir, databasePath, store, directory, adapter, deviceId };
}
const key = (id: string) => JSON.stringify(['conversation', 'claude', id]);
function groups(...ids: string[]) {
  return { version: 1, updatedAt: null,
    groups: Object.fromEntries(ids.map(id => [groupIdFor(key(id)), { title: `Request ${id}`, anchor: key(id), projectRoot: 'repo' }])),
    conversations: Object.fromEntries(ids.map(id => [key(id), groupIdFor(key(id))])), ignored: {}, suggestions: {} };
}
const state = (f: ReturnType<typeof fixture>) => readSharedRecords(f.store.db, { deviceId: f.deviceId, validateValue: isSharedProjectionValue });
const count = (f: ReturnType<typeof fixture>) => (f.store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get() as { count: number }).count;
function replicate(from: ReturnType<typeof fixture>, to: ReturnType<typeof fixture>) {
  const rows = from.store.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as any[];
  const apply = new SyncApply(to.store.db, { deviceId: to.deviceId });
  const cursor = Number(apply.getCursor());
  const wires = rows.map((row, i) => ({ seq: String(cursor + i + 1), ...buildContentOperation({ kind: 'work_state', originDeviceId: from.deviceId,
    originLocalId: String(row.id), entityRev: row.sync_rev, payload: { project: row.project, list_name: row.list_name,
      fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) } }) }));
  return apply.applyOps(decodeChanges(wires));
}
function applyRemote(target: ReturnType<typeof fixture>, updates: any[]) {
  const remote = fixture('device-z');
  publishSharedRecords(remote.store.db, { deviceId: remote.deviceId, project: 'shared', updates, validateValue: isSharedProjectionValue });
  return replicate(remote, target);
}

test('the registered real JSON writer commits canonical facts before its file and does not echo on restart', () => {
  const f = fixture(); const path = join(f.directory, 'request-groups.json');
  let observedBeforeFile = false;
  const adapter = new SharedLedgerAdapter(f.store.db, { directory: f.directory, deviceId: f.deviceId,
    notify: () => { observedBeforeFile = !existsSync(path) && state(f).records.size === 1; } });
  disposals.push(registerSharedFileWriter(f.directory, (name: string, value: unknown) => adapter.beforeWrite(name, value)));
  writeJsonAtomic(path, groups('a'));
  expect(observedBeforeFile).toBe(true);
  expect(readLedger(f.directory).groups.groups[groupIdFor(key('a'))].title).toBe('Request a');
  adapter.reconcile({ captureActivity: false });
  const before = count(f);
  new SharedLedgerAdapter(f.store.db, { directory: f.directory, deviceId: f.deviceId }).reconcile({ captureActivity: false });
  expect(count(f)).toBe(before);
  expect(f.store.getWorkStateEntries(['__my_work__'])).toEqual([]);
});

test('pending JSON recovers a crash between canonical commit and file rename without reauthoring', () => {
  const f = fixture();
  f.adapter.beforeWrite('request-groups.json', groups('a')); // simulate crash before rename/finalizer
  const before = count(f);
  expect(existsSync(join(f.directory, 'request-groups.json'))).toBe(false);
  const restarted = new SharedLedgerAdapter(f.store.db, { directory: f.directory, deviceId: f.deviceId });
  const result = restarted.reconcile({ captureActivity: false });
  expect(result.files).toEqual([]);
  expect(readLedger(f.directory).groups.groups[groupIdFor(key('a'))].title).toBe('Request a');
  expect(count(f)).toBe(before);
  expect((f.store.db.query("SELECT pending_json FROM my_work_file_state WHERE name='request-groups.json'").get() as any).pending_json).toBeNull();
});

test('unchanged reconciliation creates no canonical rows or metadata writes', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  f.adapter.reconcile({ captureActivity: false });
  const before = f.store.db.query('SELECT total_changes() AS count').get() as { count: number };
  const metadata = f.store.db.query('SELECT * FROM my_work_file_state ORDER BY name').all();
  const rows = count(f);
  for (let i = 0; i < 3; i++) f.adapter.reconcile({ captureActivity: false });
  expect(count(f)).toBe(rows);
  expect(f.store.db.query('SELECT total_changes() AS count').get()).toEqual(before);
  expect(f.store.db.query('SELECT * FROM my_work_file_state ORDER BY name').all()).toEqual(metadata);
});

test('formatting and object-key order do not become a new imported generation', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  f.adapter.reconcile({ captureActivity: false });
  const before = f.store.db.query('SELECT total_changes() AS count').get();
  const value = groups('a');
  writeFileSync(join(f.directory, 'request-groups.json'), JSON.stringify({ suggestions: value.suggestions,
    ignored: value.ignored, conversations: value.conversations, groups: value.groups, updatedAt: value.updatedAt, version: value.version }));
  utimesSync(join(f.directory, 'request-groups.json'), new Date(), new Date(Date.now() + 1000));
  expect(f.adapter.reconcile({ captureActivity: false }).files).toEqual([]);
  expect(f.store.db.query('SELECT total_changes() AS count').get()).toEqual(before);
});

test('overlapping groups expose a membership conflict and cannot be silently rewritten by a local file writer', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  const otherId = groupIdFor(key('b'));
  applyRemote(f, [{ kind: 'group', key: otherId, value: {
    group: { title: 'Other group', anchor: key('b'), projectRoot: 'repo' }, members: [key('a'), key('b')], suggestions: {},
  } }]);
  const diagnostic = f.adapter.reconcile({ captureActivity: false });
  expect(diagnostic.conflicts).toContainEqual(expect.objectContaining({ kind: 'group-membership', key: key('a') }));
  const before = count(f);
  expect(() => f.adapter.saveFile('request-groups.json', readLedger(f.directory).groups)).toThrow('conflicting decision');
  expect(count(f)).toBe(before);
});

test('external Python-style JSON changes import once, and deleting a known local group writes a tombstone', () => {
  const f = fixture();
  writeFileSync(join(f.directory, 'request-groups.json'), JSON.stringify(groups('a')));
  f.adapter.reconcile({ captureActivity: false });
  const first = count(f);
  f.adapter.reconcile({ captureActivity: false }); expect(count(f)).toBe(first);
  writeFileSync(join(f.directory, 'story.json'), JSON.stringify({ narrative: 'A saved account of the work.', preferences: [] }));
  f.adapter.reconcile({ captureActivity: false });
  expect(state(f).records.get(sharedRecordKey('story', 'current'))?.value).toMatchObject({ narrative: 'A saved account of the work.' });
  writeFileSync(join(f.directory, 'request-groups.json'), JSON.stringify(groups()));
  f.adapter.reconcile({ captureActivity: false });
  expect(state(f).records.get(sharedRecordKey('group', groupIdFor(key('a'))))?.deleted).toBe(true);
});

test('deleted identities revive from their durable tombstone base after restart and peer updates', () => {
  const a = fixture(), b = fixture('device-b');
  const id = groupIdFor(key('a')), identity = sharedRecordKey('group', id);
  a.adapter.saveFile('request-groups.json', groups('a'));
  a.adapter.saveFile('request-groups.json', groups());
  expect(state(a).records.get(identity)).toMatchObject({ deleted: true, revision: '2' });
  replicate(a, b);
  b.adapter.reconcile({ captureActivity: false });
  b.adapter.saveFile('request-groups.json', groups('a'));
  expect(state(b).records.get(identity)).toMatchObject({ deleted: false, revision: '3' });
  replicate(b, a);
  a.adapter.reconcile({ captureActivity: false });
  a.adapter.saveFile('request-groups.json', groups());
  expect(state(a).records.get(identity)).toMatchObject({ deleted: true, revision: '4' });
  const reopened = new SessionStore(a.databasePath);
  disposals.push(() => reopened.close());
  const restarted = new SharedLedgerAdapter(reopened.db, { directory: a.directory, deviceId: a.deviceId });
  restarted.saveFile('request-groups.json', groups('a'));
  expect(state(a).records.get(identity)).toMatchObject({ deleted: false, revision: '5' });
  const before = count(a);
  restarted.reconcile({ captureActivity: false });
  new SharedLedgerAdapter(reopened.db, { directory: a.directory, deviceId: a.deviceId }).reconcile({ captureActivity: false });
  expect(count(a)).toBe(before);
});

test('a legacy human-copy file imports when only the copy file changes', () => {
  const f = fixture();
  f.store.appendWorkStateEntry({ project: 'repo', listName: 'work', fields: {
    task: 'Build a viewer', status: 'doing', request_id: 'request', human_request: 'Build a clear work viewer.',
  } });
  f.adapter.reconcile();
  const source = new WorkStateSource({ databasePath: f.databasePath, ledgerDir: f.directory, localDeviceId: f.deviceId });
  disposals.push(() => source.close());
  const request = source.read().agentView.humanRequests[0];
  const input = createHumanCopyInput(request);
  const copy = { title: 'A clear work viewer', summary: 'Recorded work appears together.', next: 'Check the recorded view.',
    workstreams: input.workstreams.map((stream: any) => ({ id: stream.id, title: 'Build the view', summary: 'The view is underway.' })) };
  const record = () => state(f).records.get(sharedRecordKey('copy', request.id));
  expect(record()).toBeUndefined();
  const before = count(f);
  writeFileSync(join(f.directory, 'human-copy.json'), JSON.stringify({ entries: {
    [request.id]: { fingerprint: humanCopyFingerprint(input), copy, generatedAt: Date.now() },
  } }));
  expect(f.adapter.reconcile().files).toEqual([]);
  expect(record()?.value).toMatchObject({ copy: { title: 'A clear work viewer' } });
  expect(count(f)).toBe(before + 3);
  const after = count(f), changes = f.store.db.query('SELECT total_changes() AS n').get();
  f.adapter.reconcile();
  expect(count(f)).toBe(after);
  expect(f.store.db.query('SELECT total_changes() AS n').get()).toEqual(changes);
  new SharedLedgerAdapter(f.store.db, { directory: f.directory, deviceId: f.deviceId }).reconcile();
  expect(count(f)).toBe(after);
});

test('materialization preserves an independently arriving remote group and never reuploads it', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  const remote = groups('b');
  applyRemote(f, [{ kind: 'group', key: groupIdFor(key('b')), value: { group: remote.groups[groupIdFor(key('b'))], members: [key('b')], suggestions: {} } }]);
  const before = count(f);
  f.adapter.reconcile({ captureActivity: false });
  const ledger = readLedger(f.directory);
  expect(Object.keys(ledger.groups.groups).sort()).toEqual([groupIdFor(key('a')), groupIdFor(key('b'))].sort());
  f.adapter.reconcile({ captureActivity: false });
  expect(count(f)).toBe(before);
  const next = structuredClone(ledger.groups); next.groups[groupIdFor(key('a'))].title = 'A changed';
  f.adapter.saveFile('request-groups.json', next);
  expect(state(f).records.get(sharedRecordKey('group', groupIdFor(key('b'))))?.writer).toBe('device-z');
});

test('a pending write never replaces a newer intent from another connection', () => {
  const f = fixture(); const path = join(f.directory, 'request-groups.json');
  const otherDatabase = new Database(f.databasePath); disposals.push(() => otherDatabase.close());
  otherDatabase.exec('PRAGMA busy_timeout = 1000');
  const other = new SharedLedgerAdapter(otherDatabase, { directory: f.directory, deviceId: f.deviceId });
  const older = f.adapter.stageFile('request-groups.json', groups('a'));
  const newer = other.stageFile('request-groups.json', groups('a', 'b'));
  expect(f.adapter.materializeFile(older).materialization).toBe('pending');
  expect(existsSync(path)).toBe(false);
  expect(f.adapter.pendingMaterialization()).toBe(1);
  expect(other.materializeFile(newer).materialization).toBe('complete');
  expect(Object.keys(readLedger(f.directory).groups.groups)).toHaveLength(2);
  expect(f.adapter.pendingMaterialization()).toBe(0);
});

test('reconcile finishes an interrupted write while holding the write lock', () => {
  const f = fixture();
  const otherDatabase = new Database(f.databasePath); disposals.push(() => otherDatabase.close());
  otherDatabase.exec('PRAGMA busy_timeout = 0');
  f.adapter.stageFile('request-groups.json', groups('a'));
  const updatesForFile = f.adapter.updatesForFile.bind(f.adapter);
  let writeDuringFinish: unknown = null;
  f.adapter.updatesForFile = (name: string, value: unknown) => {
    try { otherDatabase.exec("INSERT INTO sync_state(k, v) VALUES ('concurrent-writer', '1')"); }
    catch (error) { writeDuringFinish = error; }
    return updatesForFile(name, value);
  };
  f.adapter.reconcile({ captureActivity: false });
  expect(String(writeDuringFinish)).toMatch(/locked|busy/i);
  expect(f.adapter.pendingMaterialization()).toBe(0);
  expect(readLedger(f.directory).groups.groups[groupIdFor(key('a'))].title).toBe('Request a');
});

test('a projection read before a newer record is not written over it; the next reconcile uses the newer record', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  const id = groupIdFor(key('a')); const recordKey = sharedRecordKey('group', id);
  const remoteGroup = { ...groups('a').groups[id], title: 'Older projection' };
  applyRemote(f, [{ kind: 'group', key: id, value: { group: remoteGroup, members: [key('a')], suggestions: {} } }]);
  const updatesForFile = f.adapter.updatesForFile.bind(f.adapter);
  let raced = false;
  f.adapter.updatesForFile = (name: string, value: unknown) => {
    if (!raced && name === 'request-groups.json') {
      raced = true;
      publishSharedRecords(f.store.db, { deviceId: f.deviceId, project: 'shared', validateValue: isSharedProjectionValue, updates: [{ kind: 'group', key: id,
        value: { group: { ...remoteGroup, title: 'Newer record' }, members: [key('a')], suggestions: {} }, expectedHash: state(f).records.get(recordKey)?.hash ?? null }] });
    }
    return updatesForFile(name, value);
  };
  f.adapter.reconcile({ captureActivity: false });
  expect(raced).toBe(true);
  expect(readLedger(f.directory).groups.groups[id].title).toBe('Request a');
  f.adapter.reconcile({ captureActivity: false });
  expect(readLedger(f.directory).groups.groups[id].title).toBe('Newer record');
  expect(f.adapter.pendingMaterialization()).toBe(0);
});

test('ledger file names use forward slashes on every platform and stop at the ledger root', () => {
  const root = 'C:\\data\\work-view';
  expect(ledgerRelativeName(root, `${root}\\progress\\g_0123456789ab.json`, win32)).toBe('progress/g_0123456789ab.json');
  expect(ledgerRelativeName(root, `${root}\\story.json`, win32)).toBe('story.json');
  expect(ledgerRelativeName(root, `${root}\\..notes.json`, win32)).toBe('..notes.json');
  expect(ledgerRelativeName(root, 'C:\\data\\other.json', win32)).toBeNull();
  expect(ledgerRelativeName(root, 'D:\\data\\work-view\\story.json', win32)).toBeNull();
  expect(ledgerRelativeName(root, root, win32)).toBeNull();
  expect(ledgerRelativeName('/data/work-view', '/data/work-view/progress/g_0123456789ab.json', posix)).toBe('progress/g_0123456789ab.json');
  expect(ledgerRelativeName('/data/work-view', '/data/other.json', posix)).toBeNull();
});

test('a local external change concurrent with remote canonical change is retained and diagnosed', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  const remoteGroup = groups('a').groups[groupIdFor(key('a'))]; remoteGroup.title = 'Remote choice';
  applyRemote(f, [{ kind: 'group', key: groupIdFor(key('a')), value: { group: remoteGroup, members: [key('a')], suggestions: {} } }]);
  const local = groups('a'); local.groups[groupIdFor(key('a'))].title = 'Local choice';
  writeFileSync(join(f.directory, 'request-groups.json'), JSON.stringify(local));
  const before = count(f); const diagnostic = f.adapter.reconcile({ captureActivity: false });
  expect(diagnostic.files.some(error => error.file === 'request-groups.json')).toBe(true);
  expect(readLedger(f.directory).groups.groups[groupIdFor(key('a'))].title).toBe('Local choice');
  expect(state(f).diagnostics.conflicts).toHaveLength(1);
  expect(count(f)).toBe(before);
});

test('malformed and oversized external files retain prior canonical state and return diagnostics', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  writeFileSync(join(f.directory, 'request-groups.json'), '{broken');
  expect(() => f.adapter.reconcile({ captureActivity: false })).not.toThrow();
  expect(state(f).records.get(sharedRecordKey('group', groupIdFor(key('a'))))?.deleted).toBe(false);
  writeFileSync(join(f.directory, 'request-groups.json'), JSON.stringify({ ...groups('a'), huge: 'x'.repeat(8 * 1024 * 1024) }));
  const result = f.adapter.reconcile({ captureActivity: false });
  expect(result.files.some(error => error.file === 'request-groups.json')).toBe(true);
  expect(state(f).records.get(sharedRecordKey('group', groupIdFor(key('a'))))?.deleted).toBe(false);
});

test('valid JSON with an invalid ledger root cannot erase previous canonical objects', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  const rows = count(f);
  writeFileSync(join(f.directory, 'request-groups.json'), JSON.stringify({ version: 1, groups: [] }));
  const result = f.adapter.reconcile({ captureActivity: false });
  expect(result.files.some(error => error.file === 'request-groups.json')).toBe(true);
  expect(state(f).records.get(sharedRecordKey('group', groupIdFor(key('a'))))?.deleted).toBe(false);
  expect(count(f)).toBe(rows);
});

test('remote tombstones materialize into story and progress compatibility files', () => {
  const f = fixture(); f.adapter.saveFile('request-groups.json', groups('a'));
  f.adapter.saveFile('story.json', { narrative: 'Old story', preferences: [] });
  const groupId = groupIdFor(key('a'));
  f.adapter.saveFile(`progress/${groupId}.json`, { groupId, state: 'in-progress', percent: 20, summary: 'Old progress' });
  const remote = fixture('device-z');
  // First copy current state to the remote, so deletion is authored after the existing revision.
  replicate(f, remote);
  publishSharedRecords(remote.store.db, { deviceId: remote.deviceId, project: 'shared', updates: [{ kind: 'story', key: 'current', deleted: true }, { kind: 'progress', key: groupId, deleted: true }], validateValue: isSharedProjectionValue });
  replicate(remote, f);
  f.adapter.reconcile({ captureActivity: false });
  expect(readLedger(f.directory).story).toBeNull();
  expect(readLedger(f.directory).progress[groupId]).toBeUndefined();
});

test('remote refresh display never becomes local PID or lock ownership', () => {
  const f = fixture();
  const localStatus = { state: 'idle', pid: 123456, checkedAt: '2026-11-01T00:00:00.000Z' };
  writeFileSync(join(f.directory, 'refresh.json'), JSON.stringify(localStatus));
  f.adapter.reconcile({ captureActivity: false });
  applyRemote(f, [{ kind: 'refresh', key: 'device-z', value: { originDeviceId: 'device-z', state: 'running', startedAt: '2026-11-02T00:00:00.000Z' } }]);
  f.adapter.reconcile({ captureActivity: false });
  expect(JSON.parse(readFileSync(join(f.directory, 'refresh.json'), 'utf8'))).toEqual(localStatus);
  expect(state(f).records.get(sharedRecordKey('refresh', f.deviceId))?.value).not.toHaveProperty('pid');
});
