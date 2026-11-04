import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../src/services/sync/CloudSync.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildContentOperation, canonicalJson, parseCanonicalOperation } from '../../../src/services/sync/CanonicalContent.js';
import { publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { createSharedEntry, createSharedBatch, isSharedWorkList, sharedRecordKey, SHARED_WORK_MAX_VALUE_BYTES } from '../../../src/services/work-view/shared-records.mjs';

const disposables: Array<() => void> = [];
const NOW = Date.parse('2026-11-01T00:00:00Z');
function fixture(deviceId: string) {
  const db = new Database(':memory:');
  const store = new SessionStore(db);
  store.setLocalSyncDeviceId(deviceId);
  disposables.push(() => db.close());
  return { db, store, deviceId };
}
afterEach(() => { for (const dispose of disposables.splice(0).reverse()) dispose(); });
function nativeRows(db: Database) {
  return db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as Array<Record<string, any>>;
}
function wireRows(device: ReturnType<typeof fixture>, rows = nativeRows(device.db)) {
  return rows.map(row => buildContentOperation({ kind: 'work_state', originDeviceId: device.deviceId,
    originLocalId: String(row.id), entityRev: String(row.sync_rev), payload: {
      project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields),
      created_at: row.created_at, created_at_epoch: String(row.created_at_epoch),
    } }));
}
function applyWires(target: ReturnType<typeof fixture>, wires: ReturnType<typeof wireRows>, from = 1) {
  return new SyncApply(target.db, { deviceId: target.deviceId, now: () => NOW })
    .applyOps(decodeChanges(wires.map((wire, i) => ({ ...wire, seq: String(from + i) }))));
}
const read = (device: ReturnType<typeof fixture>) => readSharedRecords(device.db, { deviceId: device.deviceId });

describe('shared My Work records', () => {
  test('validates preloaded rows without another query and excludes unrelated malformed rows', () => {
    const a = fixture('device-a');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'a', value: 'A' }] });
    const expected = read(a);
    const rows = [...nativeRows(a.db), { list_name: 'my-rules', fields: '{broken', origin_device_id: null }];
    const state = readSharedRecords({ prepare() { throw new Error('unexpected query'); } } as unknown as Database, { deviceId: a.deviceId, rows });
    expect([...state.records]).toEqual([...expected.records]);
    expect(state.diagnostics).toEqual(expected.diagnostics);
  });

  test('a restarted read-only process reconstructs complete state without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-record-restart-'));
    const path = join(dir, 'state.db');
    disposables.push(() => rmSync(dir, { recursive: true, force: true }));
    const writer = new Database(path);
    new SessionStore(writer);
    publishSharedRecords(writer, { deviceId: 'device-a', project: 'repo', updates: [{ kind: 'group', key: 'g', value: { title: 'Durable' } }] });
    const before = readSharedRecords(writer, { deviceId: 'device-a' }).revision;
    writer.close();
    const reader = new Database(path, { readonly: true });
    try {
      const state = readSharedRecords(reader, { deviceId: 'device-a' });
      expect(state.revision).toBe(before);
      expect(state.records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'Durable' });
      expect(state.diagnostics).toEqual({ pending: 0, invalid: 0, unsupported: 0, conflicts: [] });
    } finally { reader.close(); }
  });

  test('a failed commit-marker insert rolls back every entry in the local batch', () => {
    const a = fixture('device-a');
    a.db.exec("CREATE TRIGGER reject_shared_commit BEFORE INSERT ON work_state_entries WHEN NEW.list_name = '__my_work_v1:commit' BEGIN SELECT RAISE(ABORT, 'fixture refused commit'); END");
    expect(() => publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [
      { kind: 'group', key: 'a', value: 1 }, { kind: 'group', key: 'b', value: 2 },
    ] })).toThrow('fixture refused commit');
    expect(nativeRows(a.db)).toHaveLength(0);
  });

  test('deduplicates unchanged values, preserves independent keys, and applies explicit deletion', () => {
    const a = fixture('device-a');
    const first = publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: NOW,
      updates: [{ kind: 'group', key: 'a', value: { title: 'A' } }, { kind: 'group', key: 'b', value: { title: 'B' } }] });
    expect(first.changed).toBe(2);
    expect(first.rowIds).toHaveLength(4); // two entries, one manifest, one commit
    expect(publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: NOW,
      updates: [{ kind: 'group', key: 'a', value: { title: 'A' } }] }).changed).toBe(0);
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: NOW,
      updates: [{ kind: 'group', key: 'a', deleted: true }] });
    expect(read(a).records.get(sharedRecordKey('group', 'a'))).toMatchObject({ deleted: true, revision: '2', value: null });
    expect(read(a).records.get(sharedRecordKey('group', 'b'))?.value).toEqual({ title: 'B' });
  });

  test('refuses stale expected content and rolls back an oversized or duplicate batch', () => {
    const a = fixture('device-a');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'a', value: 1 }] });
    const before = nativeRows(a.db).length;
    expect(() => publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'a', value: 2, expectedHash: null }] })).toThrow('changed since read');
    expect(() => publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [
      { kind: 'group', key: 'b', value: 2 }, { kind: 'story', key: 'global', value: 'é'.repeat(SHARED_WORK_MAX_VALUE_BYTES) },
    ] })).toThrow('byte limit');
    expect(() => publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [
      { kind: 'group', key: 'b', value: 2 }, { kind: 'group', key: 'b', value: 3 },
    ] })).toThrow('duplicate');
    expect(nativeRows(a.db)).toHaveLength(before);
  });

  test('retains the previous complete version while a new batch arrives commit-first', () => {
    const a = fixture('device-a'), b = fixture('device-b');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'progress', key: 'g', value: 25 }] });
    const first = wireRows(a);
    applyWires(b, first);
    const second = publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [
      { kind: 'progress', key: 'g', value: 60 }, { kind: 'group', key: 'g', value: { title: 'Grouped' } },
    ] });
    const next = wireRows(a, nativeRows(a.db).filter(row => second.rowIds.includes(row.id)));
    applyWires(b, [next.at(-1)!], first.length + 1);
    expect(read(b).records.get(sharedRecordKey('progress', 'g'))?.value).toBe(25);
    expect(read(b).diagnostics.pending).toBe(1);
    applyWires(b, next.slice(0, -1).reverse(), first.length + 2);
    expect(read(b).records.get(sharedRecordKey('progress', 'g'))?.value).toBe(60);
    expect(read(b).records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'Grouped' });
    expect(read(b).diagnostics.pending).toBe(0);
  });

  test('opposite arrival orders converge on independent keys and disclose concurrent conflicts', () => {
    const a = fixture('device-a'), b = fixture('device-b'), c = fixture('device-c'), d = fixture('device-d');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [
      { kind: 'group', key: 'a', value: 'A' }, { kind: 'progress', key: 'shared', value: 20 },
    ] });
    publishSharedRecords(b.db, { deviceId: b.deviceId, project: 'repo', updates: [
      { kind: 'group', key: 'b', value: 'B' }, { kind: 'progress', key: 'shared', value: 30 },
    ] });
    const aw = wireRows(a), bw = wireRows(b);
    applyWires(c, [...aw, ...bw]); applyWires(d, [...bw, ...aw].reverse());
    expect([...read(c).records]).toEqual([...read(d).records]);
    expect(read(c).records.size).toBe(3);
    expect(read(c).diagnostics.conflicts).toEqual([{ kind: 'progress', key: 'shared', revision: '1', writers: ['device-a', 'device-b'] }]);
    expect(read(c).records.get(sharedRecordKey('progress', 'shared'))?.value).toBe(30);
    expect(() => publishSharedRecords(c.db, { deviceId: c.deviceId, project: 'repo', updates: [
      { kind: 'progress', key: 'shared', value: 50 },
    ] })).toThrow('unresolved conflict');
    const current = read(c).records.get(sharedRecordKey('progress', 'shared'))!;
    publishSharedRecords(c.db, { deviceId: c.deviceId, project: 'repo', updates: [
      { kind: 'progress', key: 'shared', value: 50, expectedHash: current.hash },
    ] });
    expect(read(c).records.get(sharedRecordKey('progress', 'shared'))?.value).toBe(50);
    expect(read(c).diagnostics.conflicts).toEqual([]);
  });

  test('logical revisions beyond JavaScript safe integers remain exact and clocks do not choose winners', () => {
    const a = fixture('device-a');
    const large = '9007199254740993';
    const rows = createSharedBatch([createSharedEntry({ batchId: 'large-revision', writer: a.deviceId, kind: 'progress', key: 'g', revision: large, value: 40 })], { batchId: 'large-revision', writer: a.deviceId });
    for (const row of rows) a.db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES (?,?,?,?,?)')
      .run('repo', row.listName, canonicalJson(row.fields), new Date(NOW).toISOString(), NOW);
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: 1, updates: [{ kind: 'progress', key: 'g', value: 50 }] });
    expect(read(a).records.get(sharedRecordKey('progress', 'g'))?.revision).toBe('9007199254740994');
    expect(read(a).records.get(sharedRecordKey('progress', 'g'))?.value).toBe(50);
  });

  test('an explicit current-winner conflict choice publishes a new revision while ordinary equal writes remain no-ops', () => {
    const a = fixture('device-a'), b = fixture('device-b');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'A' }] });
    publishSharedRecords(b.db, { deviceId: b.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'B' }] });
    applyWires(a, wireRows(b));
    const current = read(a).records.get(sharedRecordKey('group', 'g'))!;
    expect(read(a).diagnostics.conflicts).toHaveLength(1);
    expect(() => publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: current.value }] })).toThrow('unresolved conflict');
    expect(publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: current.value, expectedHash: current.hash }] }).changed).toBe(1);
    expect(read(a).records.get(sharedRecordKey('group', 'g'))?.revision).toBe('2');
    expect(read(a).diagnostics.conflicts).toEqual([]);
    expect(publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: current.value }] }).changed).toBe(0);
  });

  test('a corrupted newer batch cannot activate or remove previous complete content', () => {
    const a = fixture('device-a');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'story', key: 'main', value: 'old' }] });
    const next = publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'story', key: 'main', value: 'new' }] });
    const entryId = next.rowIds[0];
    const row = a.db.query('SELECT fields FROM work_state_entries WHERE id=?').get(entryId) as { fields: string };
    const fields = JSON.parse(row.fields); fields.payload = '"corrupted"';
    a.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(JSON.stringify(fields), entryId);
    expect(read(a).records.get(sharedRecordKey('story', 'main'))?.value).toBe('old');
    expect(read(a).diagnostics.invalid).toBeGreaterThan(0);
  });

  test('semantic validation rejects the whole batch before choosing new object versions', () => {
    const a = fixture('device-a');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: { title: 'Valid' } }] });
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [
      { kind: 'group', key: 'g', value: 42 }, { kind: 'progress', key: 'g', value: 70 },
    ] });
    const validateValue = (kind: string, _key: string, value: unknown, deleted: boolean) => deleted
      || kind !== 'group' || (value !== null && typeof value === 'object' && typeof (value as { title?: unknown }).title === 'string');
    const state = readSharedRecords(a.db, { deviceId: a.deviceId, validateValue });
    expect(state.records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'Valid' });
    expect(state.records.has(sharedRecordKey('progress', 'g'))).toBe(false);
    expect(state.diagnostics.invalid).toBe(1);
    expect(() => publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', validateValue,
      updates: [{ kind: 'group', key: 'x', value: 0 }] })).toThrow('invalid object');
  });

  test('invalid and future records cannot replace complete content or impersonate the origin', () => {
    const a = fixture('device-a');
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'good' }] });
    const malicious = createSharedBatch([createSharedEntry({ batchId: 'tampered', writer: 'device-b', kind: 'group', key: 'g', revision: '9', value: 'bad' })], { batchId: 'tampered', writer: 'device-b' });
    for (const [index, row] of malicious.entries()) a.db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch,origin_device_id,origin_local_id) VALUES (?,?,?,?,?,?,?)')
      .run('repo', row.listName, canonicalJson(row.fields), new Date(NOW).toISOString(), NOW, 'device-c', String(index + 100));
    a.db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES (?,?,?,?,?)')
      .run('repo', '__my_work_v2:entry', '{"version":2}', new Date(NOW).toISOString(), NOW);
    const state = read(a);
    expect(state.records.get(sharedRecordKey('group', 'g'))?.value).toBe('good');
    expect(state.diagnostics.invalid).toBe(3);
    expect(state.diagnostics.unsupported).toBe(1);
    expect(isSharedWorkList('__my_work_v2:entry')).toBe(true);
    expect(isSharedWorkList('ordinary-list')).toBe(false);
  });

  test('chunked manifests activate only when every referenced part is present', () => {
    const a = fixture('device-a'), b = fixture('device-b');
    const updates = Array.from({ length: 200 }, (_, i) => ({ kind: 'group', key: `${i}-${'k'.repeat(300)}`, value: i }));
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', updates });
    const rows = nativeRows(a.db), manifests = rows.filter(row => row.list_name.endsWith(':manifest'));
    expect(manifests.length).toBeGreaterThan(1);
    const missing = manifests[0].id;
    applyWires(b, wireRows(a, rows.filter(row => row.id !== missing)));
    expect(read(b).records.size).toBe(0);
    expect(read(b).diagnostics.pending).toBe(1);
    applyWires(b, wireRows(a, rows.filter(row => row.id === missing)), rows.length);
    expect(read(b).records.size).toBe(200);
  });

  test('CloudSync sends existing canonical work_state and replicas do not echo it', async () => {
    const a = fixture('device-a'), b = fixture('device-b');
    // Receiving row IDs deliberately differ from the origin IDs.
    b.store.appendWorkStateEntry({ project: 'repo', listName: 'ordinary', fields: { note: 'local' } });
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: NOW, updates: [{ kind: 'group', key: 'g', value: { title: 'Shared title' } }] });
    const directory = mkdtempSync(join(tmpdir(), 'shared-record-sync-'));
    disposables.push(() => rmSync(directory, { recursive: true, force: true }));
    const captured: ReturnType<typeof wireRows> = [];
    let seq = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/sync/status')) return Response.json({ protocol_version: 2, epoch: '1', head_seq: String(seq), projected_seq: String(seq), content_kinds: ['observation', 'summary', 'prompt', 'work_state'] });
      const { ops } = JSON.parse(String(init?.body));
      captured.push(...ops);
      return Response.json({ acked: ops.map((op: any) => {
        const body = parseCanonicalOperation(op);
        return { id: body.id, kind: body.kind, origin_local_id: body.origin_local_id, entity_rev: body.entity_rev, operation_sha256: op.operation_sha256, seq: String(++seq) };
      }), head_seq: String(seq), projected_seq: String(seq) });
    }) as typeof fetch;
    const sync = new CloudSync(a.db, { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'fixture-token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'fixture-user', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: a.deviceId, CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'fixture', CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'true' }, { fetchImpl, settingsPath: join(directory, 'settings.json') });
    try {
      await sync.flush();
      expect(captured.length).toBe(3);
      expect(captured.every(op => parseCanonicalOperation(op).kind === 'work_state')).toBe(true);
      applyWires(b, captured);
      expect(read(b).records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'Shared title' });
      expect(b.db.query("SELECT COUNT(*) AS n FROM work_state_entries WHERE origin_device_id IS NOT NULL AND synced_at IS NULL").get()).toEqual({ n: 0 });
      expect(read(a).revision).toBe(read(b).revision);
    } finally { sync.stop(); }
  });

  test('CloudSync keeps shared rows and frozen bytes pending by default while ordinary work state continues', async () => {
    const a = fixture('device-a');
    const directory = mkdtempSync(join(tmpdir(), 'shared-upload-gate-'));
    disposables.push(() => rmSync(directory, { recursive: true, force: true }));
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: NOW,
      updates: [{ kind: 'group', key: 'a', value: { title: 'Frozen shared value' } }] });
    const sent: ReturnType<typeof wireRows> = [];
    let rejectPush = true, seq = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/sync/status')) return Response.json({ protocol_version: 2, epoch: '1', head_seq: String(seq), projected_seq: String(seq), content_kinds: ['observation', 'summary', 'prompt', 'work_state'] });
      const { ops } = JSON.parse(String(init?.body));
      sent.push(...ops);
      if (rejectPush) return new Response('fixture retryable failure', { status: 503 });
      return Response.json({ acked: ops.map((op: any) => {
        const body = parseCanonicalOperation(op);
        return { id: body.id, kind: body.kind, origin_local_id: body.origin_local_id, entity_rev: body.entity_rev, operation_sha256: op.operation_sha256, seq: String(++seq) };
      }), head_seq: String(seq), projected_seq: String(seq) });
    }) as typeof fetch;
    const settings = { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'fixture-token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'fixture-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: a.deviceId, CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'fixture' };
    const createSync = (enabled = false) => {
      const sync = new CloudSync(a.db, { ...settings, ...(enabled ? { CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'true' } : {}) },
        { fetchImpl, settingsPath: join(directory, 'settings.json') });
      disposables.push(() => sync.stop());
      return sync;
    };
    const enabled = createSync(true);
    await enabled.flush(); enabled.stop();
    const frozen = a.db.query('SELECT * FROM sync_content_outbox ORDER BY id').all() as Array<{ body: string; operation_sha256: string }>;
    expect(frozen).toHaveLength(3);
    expect(frozen.map(({ body, operation_sha256 }) => ({ body, operation_sha256 }))).toEqual(sent);

    // A second batch has never reached the outbox; default-off must gate both paths.
    publishSharedRecords(a.db, { deviceId: a.deviceId, project: 'repo', now: NOW,
      updates: [{ kind: 'group', key: 'b', value: { title: 'Unfrozen shared value' } }] });
    a.store.appendWorkStateEntry({ project: 'repo', listName: 'ordinary', fields: { task: 'Normal work keeps syncing', status: 'doing' } });
    const sharedRows = () => (a.db.query("SELECT * FROM work_state_entries WHERE list_name GLOB '__my_work_v*' ORDER BY id").all() as any[]);
    const retainedRows = sharedRows();
    sent.length = 0; rejectPush = false;
    const disabled = createSync();
    await disabled.flush();
    expect(sent).toHaveLength(1);
    expect(parseCanonicalOperation(sent[0]).payload?.list_name).toBe('ordinary');
    expect(a.db.query("SELECT synced_at FROM work_state_entries WHERE list_name='ordinary'").get()).not.toEqual({ synced_at: null });
    expect(sharedRows()).toEqual(retainedRows);
    expect(a.db.query('SELECT * FROM sync_content_outbox ORDER BY id').all()).toEqual(frozen);
    const heads = a.db.query('SELECT * FROM sync_entity_heads ORDER BY entity_id').all();
    const rowCount = nativeRows(a.db).length;
    for (let index = 0; index < 3; index++) await disabled.flush();
    expect(sent).toHaveLength(1);
    expect(sharedRows()).toEqual(retainedRows);
    expect(nativeRows(a.db)).toHaveLength(rowCount);
    expect(a.db.query('SELECT * FROM sync_content_outbox ORDER BY id').all()).toEqual(frozen);
    expect(a.db.query('SELECT * FROM sync_entity_heads ORDER BY entity_id').all()).toEqual(heads);
    disabled.stop();

    sent.length = 0;
    const resumed = createSync(true);
    await resumed.flush();
    expect(sent).toHaveLength(6);
    for (const stored of frozen) expect(sent.find(op => op.operation_sha256 === stored.operation_sha256)?.body).toBe(stored.body);
    expect(sent.every(op => isSharedWorkList(parseCanonicalOperation(op).payload?.list_name))).toBe(true);
    expect(a.db.query('SELECT * FROM sync_content_outbox').all()).toEqual([]);
    expect(sharedRows().every(row => row.synced_at !== null)).toBe(true);
    expect(sharedRows().map(row => [row.id, row.fields, row.sync_rev])).toEqual(retainedRows.map(row => [row.id, row.fields, row.sync_rev]));
    resumed.stop();
  });
});
