import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache, redactJsonStrings } from '../../../src/utils/redaction.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { buildContentOperation, canonicalJson } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { createSharedBatch, createSharedEntry, sharedRecordKey, sharedValueHash } from '../../../src/services/work-view/shared-records.mjs';
import { isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';

const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const cleanup: Array<() => void> = [];
let settings: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  settings?.mockRestore(); settings = null; _resetRedactionConfigCache();
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function policy(enabled: boolean, custom: string[] = []) {
  settings?.mockRestore();
  settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: String(enabled),
    CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: JSON.stringify(custom.map((regex, index) => ({ name: `custom${index}`, regex }))),
  }));
  _resetRedactionConfigCache();
}
function fixture(deviceId: string, path = ':memory:') {
  const db = new Database(path); const store = new SessionStore(db); store.setLocalSyncDeviceId(deviceId);
  cleanup.push(() => db.close());
  return { db, deviceId };
}
type Fixture = ReturnType<typeof fixture>;
const read = (f: Fixture) => readSharedRecords(f.db, { deviceId: f.deviceId, validateValue: isSharedProjectionValue });
const rows = (f: Fixture) => f.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as any[];
function wires(f: Fixture, input = rows(f)) {
  return input.map(row => buildContentOperation({ kind: 'work_state', originDeviceId: f.deviceId, originLocalId: String(row.id), entityRev: row.sync_rev, payload: {
    project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch),
  } }));
}
function apply(f: Fixture, operations: ReturnType<typeof wires>, first = 1) {
  return new SyncApply(f.db, { deviceId: f.deviceId }).applyOps(decodeChanges(operations.map((wire, index) => ({ ...wire, seq: String(first + index) }))));
}
function story(f: Fixture, narrative: string) {
  return publishSharedRecords(f.db, { deviceId: f.deviceId, project: 'repo', updates: [{ kind: 'story', key: 'current', value: { narrative, preferences: [] } }], validateValue: isSharedProjectionValue });
}
function serializedDatabase(f: Fixture) {
  const tables = f.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  return tables.map(({ name }) => JSON.stringify(f.db.query(`SELECT * FROM "${name}"`).all())).join('\n');
}

test('origin redaction precedes payload and manifest hashes', () => {
  policy(true);
  const a = fixture('a'), b = fixture('b'); story(a, `origin ${AWS}`);
  expect(serializedDatabase(a)).not.toContain(AWS);
  expect(read(a).records.get(sharedRecordKey('story', 'current'))?.value).toMatchObject({ narrative: "origin <redacted type='aws_access_key'/>" });
  expect(apply(b, wires(a))).toMatchObject({ applied: 3, cursor: '3', quarantined: 0 });
  expect(read(b).records).toEqual(read(a).records);
  expect(read(b).diagnostics).toMatchObject({ pending: 0, invalid: 0 });
});

test('origin identity metadata that needs redaction is refused before any canonical row is written', () => {
  policy(true, ['PRIVATE_ID']); const a = fixture('a');
  for (const input of [
    { deviceId: 'PRIVATE_ID', project: 'repo', kind: 'story', key: 'current' },
    { deviceId: 'a', project: 'PRIVATE_ID', kind: 'story', key: 'current' },
    { deviceId: 'a', project: 'repo', kind: 'story', key: 'PRIVATE_ID' },
  ]) expect(() => publishSharedRecords(a.db, { deviceId: input.deviceId, project: input.project, updates: [{ kind: input.kind, key: input.key, value: { narrative: 'Safe content', preferences: [] } }] })).toThrow('identity');
  expect(a.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 0 });
});

test('stricter recipient redaction verifies the original before storing private-safe content and receipts', () => {
  policy(false); const a = fixture('a'), b = fixture('b'); story(a, `recipient ${AWS} PRIVATE_WORD`);
  const wire = wires(a); policy(true, ['PRIVATE_WORD']);
  expect(apply(b, [...wire].reverse())).toMatchObject({ applied: 3, cursor: '3', quarantined: 0 });
  const state = read(b), received = state.records.get(sharedRecordKey('story', 'current'))!;
  expect(state.diagnostics).toMatchObject({ pending: 0, invalid: 0 });
  expect(received.value).toMatchObject({ narrative: "recipient <redacted type='aws_access_key'/> <redacted type='custom0'/>" });
  expect(received.hash).toBe(read(a).records.get(sharedRecordKey('story', 'current'))!.hash);
  expect(received.valueHash).not.toBe(received.hash);
  expect(serializedDatabase(b)).not.toContain(AWS);
  expect(serializedDatabase(b)).not.toContain('PRIVATE_WORD');
  const receipt = b.db.query('SELECT * FROM local_shared_work_redactions').get() as any;
  expect(Object.keys(receipt).sort()).toEqual(['origin_device_id', 'origin_local_id', 'original_ref_json', 'row_id', 'stored_fields_hash', 'sync_rev']);
  const count = b.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get();
  expect(publishSharedRecords(b.db, { deviceId: b.deviceId, project: 'repo', updates: [{ kind: 'story', key: 'current', value: received.value, expectedHash: received.hash }], validateValue: isSharedProjectionValue }).changed).toBe(0);
  expect(b.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual(count);
});

test('origin and recipient custom policies keep the same verified identity with locally stricter display', () => {
  policy(true, ['ORIGIN_WORD']); const a = fixture('a'), b = fixture('b'); story(a, 'ORIGIN_WORD RECEIVER_WORD');
  expect(serializedDatabase(a)).not.toContain('ORIGIN_WORD');
  const sourceHash = read(a).records.get(sharedRecordKey('story', 'current'))!.hash;
  policy(true, ['RECEIVER_WORD']); apply(b, wires(a));
  expect(serializedDatabase(b)).not.toContain('ORIGIN_WORD'); expect(serializedDatabase(b)).not.toContain('RECEIVER_WORD');
  expect(read(b).records.get(sharedRecordKey('story', 'current'))!.hash).toBe(sourceHash);
  expect(read(b).diagnostics.invalid).toBe(0);
});

test('redacted complete state survives restart and remains previous state until every later batch member arrives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-redaction-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  policy(false); const a = fixture('a'), b = fixture('b', join(dir, 'state.db')); story(a, `first ${AWS}`); const first = wires(a);
  policy(true); apply(b, first); const revision = read(b).revision;
  const reader = new Database(join(dir, 'state.db'), { readonly: true });
  try { expect(readSharedRecords(reader, { deviceId: 'b', validateValue: isSharedProjectionValue }).revision).toBe(revision); } finally { reader.close(); }
  policy(false); story(a, `second ${AWS}`); const next = wires(a, rows(a).slice(3)); policy(true);
  apply(b, [next[2]], 4);
  expect(read(b).revision).toBe(revision); expect(read(b).diagnostics.pending).toBe(1);
  apply(b, next.slice(0, 2), 5);
  expect(read(b).records.get(sharedRecordKey('story', 'current'))!.value).toMatchObject({ narrative: "second <redacted type='aws_access_key'/>" });
  expect(read(b).diagnostics).toMatchObject({ pending: 0, invalid: 0 });
});

test('a receipt never blesses modified sanitized fields or a changed origin binding', () => {
  policy(false); const a = fixture('a'), b = fixture('b'); story(a, `private ${AWS}`); policy(true); apply(b, wires(a));
  const row = b.db.query("SELECT * FROM work_state_entries WHERE list_name='__my_work_v1:entry'").get() as any;
  const fields = JSON.parse(row.fields); fields.payload = canonicalJson({ narrative: 'tampered', preferences: [] });
  b.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(canonicalJson(fields), row.id);
  expect(read(b).records.size).toBe(0); expect(read(b).diagnostics.invalid).toBe(1);
  b.db.query('UPDATE work_state_entries SET fields=?, sync_rev=? WHERE id=?').run(row.fields, '2', row.id);
  expect(read(b).records.size).toBe(0); expect(read(b).diagnostics.invalid).toBe(1);
});

test('an original hash mismatch cannot become valid merely because redaction would match its forged hash', () => {
  policy(false); const a = fixture('a'), b = fixture('b');
  const value = { narrative: `forged ${AWS}`, preferences: [] };
  const entry = createSharedEntry({ writer: 'a', batchId: 'forged', kind: 'story', key: 'current', revision: '1', value });
  entry.hash = sharedValueHash('story', 'current', redactJsonStrings(value, { enabled: true }));
  const insert = a.db.query('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES(?,?,?,?,?)');
  for (const row of createSharedBatch([entry], { writer: 'a', batchId: 'forged' })) insert.run('repo', row.listName, canonicalJson(row.fields), '2026-11-01T00:00:00Z', 1793491200000);
  policy(true); const result = apply(b, wires(a));
  expect(result.quarantined).toBe(1); expect(read(b).records.size).toBe(0);
  expect(serializedDatabase(b)).not.toContain(AWS);
});

test('receipt persistence failure rolls back the transformed entry and retains previous complete state', () => {
  policy(false); const a = fixture('a'), b = fixture('b'); story(a, `first ${AWS}`); policy(true); apply(b, wires(a));
  const previous = read(b).revision;
  b.db.exec("CREATE TRIGGER reject_redaction_receipt BEFORE INSERT ON local_shared_work_redactions BEGIN SELECT RAISE(ABORT, 'receipt blocked'); END");
  policy(false); story(a, `second ${AWS}`); const next = wires(a, rows(a).slice(3)); policy(true);
  expect(apply(b, next, 4).quarantined).toBe(1);
  expect(read(b).revision).toBe(previous);
  expect(read(b).diagnostics.pending).toBe(1);
  expect(b.db.query('SELECT COUNT(*) AS n FROM local_shared_work_redactions').get()).toEqual({ n: 1 });
  expect(serializedDatabase(b)).not.toContain(AWS);
});

test('the rules-only reader binds redaction receipts without needing a local story file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-redaction-rules-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  policy(false); const a = fixture('a'), b = fixture('b', join(dir, 'state.db'));
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'story', key: 'current', value: { preferences: [{ preference: `Avoid ${AWS}`, kind: 'directive', quotes: [{ quote: 'Keep private data private.' }] }] } }] });
  policy(true); apply(b, wires(a));
  const source = new WorkStateSource({ databasePath: join(dir, 'state.db'), ledgerDir: join(dir, 'work-view'), localDeviceId: 'b' });
  try { const result = source.readRules(); expect(result.source.connected).toBe(true); expect(JSON.stringify(result)).not.toContain(AWS); expect(result.rules).toHaveLength(1); } finally { source.close(); }
});
