import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { heapStats } from 'bun:jsc';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildContentOperation, canonicalJson } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { logger } from '../../../src/utils/logger.js';
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
  // The validator runs inside the read once per row; a full collection there leaves only what the read still holds.
  let state: ReturnType<typeof readSharedRecords> | null = readSharedRecords(db, { deviceId: DEVICE, validateValue: () => {
    validated++;
    Bun.gc(true);
    peakLiveBytes = Math.max(peakLiveBytes, heapStats().heapSize - baseline);
    return true;
  } });

  const current = state.records.get(sharedRecordKey('group', 'g'));
  expect(current?.revision).toBe(String(REVISIONS));
  expect((current?.value as { title: string }).title.startsWith(`revision ${REVISIONS} `)).toBe(true);
  expect(validated).toBe(REVISIONS);
  // Holding every row and parsed value at once costs about three times the history (about 29 MB
  // here); streaming it costs one row. A quarter of the history separates the two by far.
  expect(peakLiveBytes).toBeLessThan(historyBytes / 4);
  // After the read, the result and the kept row summaries hold the current 40 KB object and one
  // payload-free summary per row (about 0.6 MB here). Keeping each row's payload would hold the
  // whole history again; a tenth of it separates the two.
  Bun.gc(true);
  const heldBytes = heapStats().heapSize - baseline;
  state = null;
  Bun.gc(true);
  const keptBytes = heapStats().heapSize - baseline;
  expect(heldBytes).toBeLessThan(historyBytes / 10);
  expect(keptBytes).toBeLessThan(historyBytes / 10);
});

test('the row cache keeps a manifest\'s entry references, not its payload', () => {
  // A manifest row's payload is the JSON of its entry references; the cache keeps those references,
  // which cost about as much as the payload. Keeping the payload as well, or the parsed reference
  // objects, at least doubles that. The entries are left out so that only manifests and commits are kept.
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  const insert = db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES (?,?,?,?,?)');
  let payloadBytes = 0;
  for (let batch = 0; batch < 40; batch++) {
    const batchId = `batch-${batch}`;
    const entries = Array.from({ length: 400 }, (_, index) => createSharedEntry({ batchId, writer: DEVICE, kind: 'group', key: `g-${batch}-${index}`, revision: '1', value: index }));
    for (const row of createSharedBatch(entries, { batchId, writer: DEVICE })) {
      if (row.fields.record === 'entry') continue;
      payloadBytes += row.fields.payload.length;
      insert.run('repo', row.listName, canonicalJson(row.fields), new Date(NOW).toISOString(), NOW);
    }
  }
  Bun.gc(true);
  const baseline = heapStats().heapSize;
  expect(readSharedRecords(db, { deviceId: DEVICE }).diagnostics.pending).toBe(40);
  Bun.gc(true);
  expect(heapStats().heapSize - baseline).toBeLessThan(payloadBytes * 2);
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
  const third = read();
  expect(third).not.toBe(second);
  // A list that only looks like a shared one (its version is not a number) is not a shared row: it is no change either.
  db.prepare("INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES ('repo','__my_work_v1x:notes','{}',?,?)").run(new Date(NOW).toISOString(), NOW);
  expect(read()).toBe(third);
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

// --- Pulled rows rewritten or deleted after the cache has seen them ---

const REMOTE = 'device-z';
function pulledFixture() {
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  const apply = new SyncApply(db, { deviceId: DEVICE });
  let nextLocalId = 1;
  // Each row as the remote device's own row id and revision, the way a pull delivers it.
  const pull = (rows: Array<{ listName: string; fields: unknown; localId?: number }>, rev = '1') => {
    const cursor = Number(apply.getCursor());
    const wires = rows.map((row, index) => ({ seq: String(cursor + index + 1), ...buildContentOperation({ kind: 'work_state', originDeviceId: REMOTE,
      originLocalId: String(row.localId ?? nextLocalId++), entityRev: rev, payload: { project: 'shared', list_name: row.listName,
        fields: row.fields, created_at: new Date(NOW).toISOString(), created_at_epoch: String(NOW) } }) }));
    apply.applyOps(decodeChanges(wires));
  };
  const tombstone = (localId: number, rev = '2') => {
    const cursor = Number(apply.getCursor());
    apply.applyOps(decodeChanges([{ seq: String(cursor + 1), ...buildContentOperation({ kind: 'work_state', originDeviceId: REMOTE,
      originLocalId: String(localId), entityRev: rev, payload: null, deleted: true, deletedAt: new Date(NOW).toISOString() }) }]));
  };
  const batch = (batchId: string, revision: string, value: unknown) => createSharedBatch([createSharedEntry({ batchId, writer: REMOTE,
    kind: 'group', key: 'g', revision, base: null, value })], { batchId, writer: REMOTE });
  return { db, pull, tombstone, batch };
}
const normalized = (state: ReturnType<typeof readSharedRecords>) => canonicalJson({ records: [...state.records].sort(), heads: [...state.heads].sort(),
  revision: state.revision, diagnostics: state.diagnostics });
const groupValue = (state: ReturnType<typeof readSharedRecords>) => state.records.get(sharedRecordKey('group', 'g'))?.value;

test('a pulled higher revision that rewrites a row\'s content is read, not the summary kept for the old content', () => {
  const { db, pull, batch } = pulledFixture();
  pull(batch('b1', '1', 'A').map((row, index) => ({ ...row, localId: index + 1 })));
  const read = createSharedRecordReader(db, { deviceId: DEVICE });
  expect(groupValue(read())).toBe('A');
  expect(groupValue(readSharedRecords(db, { deviceId: DEVICE }))).toBe('A');
  // SyncApply.applyWorkState rewrites the same rows in place (same ids and origin) with new fields and a higher sync_rev.
  pull(batch('b1', '1', 'B').map((row, index) => ({ ...row, localId: index + 1 })), '2');
  expect((db.query("SELECT COUNT(*) AS count FROM work_state_entries WHERE sync_rev = '2'").get() as { count: number }).count).toBe(3);
  expect(groupValue(read())).toBe('B');
  expect(groupValue(readSharedRecords(db, { deviceId: DEVICE }))).toBe('B');
});

test('a pulled tombstone that deletes a row of the current batch is read', () => {
  const { db, pull, tombstone, batch } = pulledFixture();
  pull(batch('b1', '1', 'A'));
  pull(batch('b2', '2', 'B'));
  const read = createSharedRecordReader(db, { deviceId: DEVICE });
  expect(groupValue(read())).toBe('B');
  expect(groupValue(readSharedRecords(db, { deviceId: DEVICE }))).toBe('B');
  // SyncApply.applyOp deletes b2's entry row (remote row 4), which is not the highest id: b2 is pending again.
  tombstone(4);
  expect((db.query('SELECT COUNT(*) AS count FROM work_state_entries').get() as { count: number }).count).toBe(5);
  for (const state of [read(), readSharedRecords(db, { deviceId: DEVICE })]) {
    expect(groupValue(state)).toBe('A');
    expect(state.diagnostics.pending).toBe(1);
  }
});

test('a kept summary that no longer matches its row clears the row cache and reads again once', () => {
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  const insert = db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES (?,?,?,?,?)');
  const write = (batchId: string, revision: string, value: unknown) => createSharedBatch([createSharedEntry({ batchId, writer: DEVICE,
    kind: 'group', key: 'g', revision, base: null, value })], { batchId, writer: DEVICE });
  const ids = (rows: ReturnType<typeof write>) => rows.map(row => Number(insert.run('repo', row.listName, canonicalJson(row.fields), new Date(NOW).toISOString(), NOW).lastInsertRowid));
  const [olderEntry] = ids(write('b1', '1', 'A'));
  const [, , newerCommit] = ids(write('b2', '2', 'B'));
  expect(groupValue(readSharedRecords(db, { deviceId: DEVICE }))).toBe('B');
  // Content that changes without a new sync_rev never happens through sync; if it does, the kept summary of b1's
  // entry is wrong. Once b2 is pending, b1's value is read again from its row and disagrees with that summary.
  db.prepare('UPDATE work_state_entries SET fields = ? WHERE id = ?').run(canonicalJson(write('b1', '1', 'X')[0].fields), olderEntry);
  db.prepare('DELETE FROM work_state_entries WHERE id = ?').run(newerCommit);
  const rows = db.query("SELECT id, list_name, fields, origin_device_id, origin_local_id, sync_rev FROM work_state_entries ORDER BY id").all() as any[];
  const fromRows = normalized(readSharedRecords(db, { deviceId: DEVICE, rows }));
  const errors = spyOn(logger, 'error').mockImplementation(() => {});
  try {
    const state = readSharedRecords(db, { deviceId: DEVICE });
    expect(normalized(state)).toBe(fromRows);
    // b1's rewritten entry no longer matches its manifest, and b2 has no commit.
    expect(state.diagnostics).toMatchObject({ invalid: 1, pending: 1 });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][1])).toContain('cleared this connection');
    // The next read uses the rebuilt cache: no error and no further log.
    expect(normalized(readSharedRecords(db, { deviceId: DEVICE }))).toBe(fromRows);
    expect(errors).toHaveBeenCalledTimes(1);
  } finally { errors.mockRestore(); }
});

test('a publish reuses only a kept reader of its own database, device and validator', () => {
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  const other = new Database(':memory:');
  new SessionStore(other).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => other.close());
  const validateValue = () => true;
  const publish = (reader: unknown) => publishSharedRecords(db, { deviceId: DEVICE, project: 'repo', validateValue,
    updates: [{ kind: 'group', key: 'g', value: Math.random() }], reader: reader as any });
  for (const reader of [
    createSharedRecordReader(db, { deviceId: 'device-b', validateValue }),
    createSharedRecordReader(db, { deviceId: DEVICE }),
    createSharedRecordReader(db, { deviceId: DEVICE, validateValue: () => true }),
    createSharedRecordReader(other, { deviceId: DEVICE, validateValue }),
    () => readSharedRecords(db, { deviceId: DEVICE, validateValue }),
  ]) expect(() => publish(reader)).toThrow('the reader reads another database, device or validator');
  expect(publish(createSharedRecordReader(db, { deviceId: DEVICE, validateValue })).changed).toBe(1);
});

test('a row cache past the history size the machine was sized for logs an error once and drops nothing', () => {
  // The ceiling (599,925 rows, shared-record-store.mjs) is where the kept summaries in two threads would use the
  // margin the cloud viewer's 1,536 MB leaves. Rows of an unsupported version are the cheapest shared rows to scan.
  const db = new Database(':memory:');
  new SessionStore(db).setLocalSyncDeviceId(DEVICE);
  disposables.push(() => db.close());
  const rows = 600_000;
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) SELECT 'repo', '__my_work_v2:entry', '{}', '', 0 FROM n`).run(rows);
  const errors = spyOn(logger, 'error').mockImplementation(() => {});
  try {
    expect(readSharedRecords(db, { deviceId: DEVICE }).diagnostics.unsupported).toBe(rows);
    expect(readSharedRecords(db, { deviceId: DEVICE }).diagnostics.unsupported).toBe(rows);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][2]).toMatchObject({ rows, ceiling: 599_925 });
  } finally { errors.mockRestore(); }
});
