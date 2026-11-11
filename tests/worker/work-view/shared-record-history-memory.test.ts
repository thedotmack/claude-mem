import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { heapStats } from 'bun:jsc';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { canonicalJson } from '../../../src/services/sync/CanonicalContent.js';
import { createSharedRecordReader, publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { createSharedBatch, createSharedEntry, sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';

// Shared My Work rows are an append-only history: every revision of every object stays. The
// cloud viewer read all of it (24,424 rows, 50 MB, for 1,587 current objects) every few seconds
// and was killed for memory on its 1 GB machine, because each read held every row and every
// parsed value at once. A read must hold the current objects, not the history.

const disposables: Array<() => void> = [];
afterEach(() => { for (const dispose of disposables.splice(0).reverse()) dispose(); });

const DEVICE = 'device-a';
const NOW = Date.parse('2026-11-01T00:00:00Z');
// 240 revisions of one 40 KB object: about 9.6 MB of history for 40 KB of current state.
const REVISIONS = 240;
const VALUE_CHARS = 40_000;

function historyFixture() {
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  const insert = db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES (?,?,?,?,?)');
  let base: string | null = null;
  let historyBytes = 0;
  for (let revision = 1; revision <= REVISIONS; revision++) {
    const batchId = `revision-${revision}`;
    const entry = createSharedEntry({ batchId, writer: DEVICE, kind: 'group', key: 'g', revision: String(revision), base,
      value: { title: `revision ${revision} ${'x'.repeat(VALUE_CHARS)}` } });
    base = entry.hash;
    historyBytes += entry.payload.length;
    for (const row of createSharedBatch([entry], { batchId, writer: DEVICE })) {
      insert.run('repo', row.listName, canonicalJson(row.fields), new Date(NOW).toISOString(), NOW);
    }
  }
  return { db, historyBytes };
}

test('reading a long shared history keeps the current objects in memory, not every revision', () => {
  const { db, historyBytes } = historyFixture();
  Bun.gc(true);
  const baseline = heapStats().heapSize;
  let validated = 0;
  let peakLiveBytes = 0;
  // The validator runs inside the read; a full collection there leaves only what the read still holds.
  const state = readSharedRecords(db, { deviceId: DEVICE, validateValue: () => {
    if (++validated % 40 === 0) {
      Bun.gc(true);
      peakLiveBytes = Math.max(peakLiveBytes, heapStats().heapSize - baseline);
    }
    return true;
  } });

  const current = state.records.get(sharedRecordKey('group', 'g'));
  expect(current?.revision).toBe(String(REVISIONS));
  expect((current?.value as { title: string }).title.startsWith(`revision ${REVISIONS} `)).toBe(true);
  expect(validated).toBe(REVISIONS);
  // Holding every row and parsed value at once costs about three times the history (about 29 MB
  // here); streaming it costs one row. A quarter of the history separates the two by far.
  expect(peakLiveBytes).toBeLessThan(historyBytes / 4);
});

test('a kept reader reuses its last read until the shared rows change', () => {
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'A' }] });
  const read = createSharedRecordReader(db, { deviceId: DEVICE });
  const first = read();
  // A commit that touches no shared row (as most pulled pages are) reuses the read.
  db.prepare("INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES ('repo','my-rules','{}',?,?)").run(new Date(NOW).toISOString(), NOW);
  expect(read()).toBe(first);
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'B' }] });
  const second = read();
  expect(second).not.toBe(first);
  expect(second.records.get(sharedRecordKey('group', 'g'))?.value).toBe('B');
  // A pulled higher revision rewrites a row in place (SyncApply.applyWorkState): that is a change too.
  db.prepare("UPDATE work_state_entries SET sync_rev = '7' WHERE id = (SELECT MIN(id) FROM work_state_entries WHERE list_name GLOB '__my_work_v[0-9]*:*')").run();
  expect(read()).not.toBe(second);
});

test('a kept reader never keeps rows a transaction rolled back', () => {
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'A' }] });
  const read = createSharedRecordReader(db, { deviceId: DEVICE });
  read();
  db.exec('BEGIN');
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'Rolled back' }] });
  expect(read().records.get(sharedRecordKey('group', 'g'))?.value).toBe('Rolled back');
  db.exec('ROLLBACK');
  // Rows written after the rollback reuse the same ids; the reader must still read them.
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'C' }] });
  expect(read().records.get(sharedRecordKey('group', 'g'))?.value).toBe('C');
  expect(readSharedRecords(db, { deviceId: DEVICE }).records.get(sharedRecordKey('group', 'g'))?.value).toBe('C');
});

test('a later read parses only the shared rows it has not seen', () => {
  const { db } = historyFixture();
  let validated = 0;
  const validateValue = () => { validated++; return true; };
  readSharedRecords(db, { deviceId: DEVICE, validateValue });
  expect(validated).toBe(REVISIONS);
  validated = 0;
  const unchanged = readSharedRecords(db, { deviceId: DEVICE, validateValue });
  expect(validated).toBe(0);
  expect(unchanged.records.get(sharedRecordKey('group', 'g'))?.revision).toBe(String(REVISIONS));
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: { title: 'newest' } }] });
  validated = 0;
  const next = readSharedRecords(db, { deviceId: DEVICE, validateValue });
  expect(validated).toBe(1);
  expect(next.records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'newest' });
});

test('a kept reader parses only the shared rows it has not seen', () => {
  // The shared-work-sync thread reads only through a kept reader, and every read it makes runs in the
  // reader's own transaction. Those reads must fill the row cache too, or each shared change parses the
  // whole history again.
  const { db } = historyFixture();
  let validated = 0;
  const read = createSharedRecordReader(db, { deviceId: DEVICE, validateValue: () => { validated++; return true; } });
  read();
  expect(validated).toBe(REVISIONS);
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: { title: 'newest' } }] });
  validated = 0;
  const next = read();
  expect(validated).toBe(1);
  expect(next.records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'newest' });
  // A read inside a caller's transaction may see rows that roll back: it must not keep them.
  db.exec('BEGIN');
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: { title: 'rolled back' } }] });
  expect(read().records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'rolled back' });
  db.exec('ROLLBACK');
  publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', updates: [{ kind: 'group', key: 'g', value: { title: 'after rollback' } }] });
  validated = 0;
  expect(read().records.get(sharedRecordKey('group', 'g'))?.value).toEqual({ title: 'after rollback' });
  expect(validated).toBe(1);
});
