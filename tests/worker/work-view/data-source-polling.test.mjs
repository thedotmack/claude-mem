import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import { workStateRowsRevision } from '../../../src/services/work-view/shared-record-store.mjs';

const START = Date.parse('2026-10-28T00:00:00Z');
const POLL = { maxActivityAgeMs: 120_000 };
let directory, writer, source, titleCachePath;

beforeEach(() => {
  setSystemTime(START);
  directory = mkdtempSync(join(tmpdir(), 'work-view-poll-'));
  const databasePath = join(directory, 'source.db');
  titleCachePath = join(directory, 'titles.json');
  writer = new Database(databasePath);
  writer.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
    CREATE TABLE unrelated_activity (id INTEGER PRIMARY KEY);
  `);
  source = new WorkStateSource({ databasePath, titleCachePath, ledgerDir: directory });
});

afterEach(() => {
  source.close();
  writer.close();
  Bun.gc(true);
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  setSystemTime();
});

test('activity commits do not rebuild on every poll, but the window has a fixed deadline', () => {
  const initial = source.read(POLL).agentView.revision;
  for (let second = 1; second < 120; second++) {
    setSystemTime(START + second * 1000);
    writer.exec(`INSERT INTO unrelated_activity VALUES (${second})`);
    expect(source.read(POLL).agentView.revision).toBe(initial);
  }
  setSystemTime(START + 120_000);
  expect(source.read(POLL).agentView.revision).toBe(initial + 1);
});

test('ordinary reads still check current evidence during the polling window', () => {
  const initial = source.read(POLL).agentView.revision;
  writer.exec('INSERT INTO unrelated_activity VALUES (1)');
  expect(source.read().agentView.revision).toBe(initial + 1);
});

test('a known content commit invalidates cached activity before the polling deadline', () => {
  const initial = source.read(POLL).agentView.revision;
  writer.exec('INSERT INTO unrelated_activity VALUES (1)');
  expect(source.read(POLL).agentView.revision).toBe(initial);
  source.invalidateActivity();
  expect(source.read(POLL).agentView.revision).toBe(initial + 1);
});

test('work-state writes bypass the activity window', () => {
  const initial = source.read(POLL).agentView.revision;
  writer.prepare('INSERT INTO work_state_entries VALUES (1, ?, ?, ?, ?)')
    .run('project', 'work', JSON.stringify({ task: 'Review the result', status: 'todo' }), START);
  const next = source.read(POLL);
  expect(next.agentView.revision).toBe(initial + 1);
  expect(next.entryCount).toBe(1);
});

test('idle reads reuse the work-state aggregate until another connection commits', () => {
  const database = source.openDatabase();
  const prepare = database.prepare.bind(database);
  let aggregateReads = 0;
  database.prepare = (sql) => {
    if (sql.includes('SELECT COUNT(*) AS count, MAX(id) AS id')) aggregateReads++;
    return prepare(sql);
  };
  const initial = source.read(POLL);
  expect(aggregateReads).toBe(1);
  for (let second = 1; second <= 5; second++) {
    setSystemTime(START + second * 1000);
    const next = source.read(POLL);
    expect(next.entryCount).toBe(initial.entryCount);
    expect(next.agentView.revision).toBe(initial.agentView.revision);
  }
  expect(aggregateReads).toBe(1);
  writer.prepare('INSERT INTO work_state_entries VALUES (1, ?, ?, ?, ?)')
    .run('project', 'work', JSON.stringify({ task: 'Review the result', status: 'todo' }), START);
  expect(source.read(POLL).entryCount).toBe(1);
  expect(aggregateReads).toBe(2);
  writer.exec('DELETE FROM work_state_entries');
  expect(source.read(POLL).entryCount).toBe(0);
  expect(aggregateReads).toBe(3);
});

test('synced edits with the same row id invalidate the cached work-state aggregate', () => {
  writer.exec('ALTER TABLE work_state_entries ADD COLUMN sync_rev INTEGER DEFAULT 1');
  writer.prepare('INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (1, ?, ?, ?, ?)')
    .run('project', 'work', JSON.stringify({ task: 'Review the result', status: 'todo' }), START);
  const initial = source.read(POLL);
  writer.prepare('UPDATE work_state_entries SET fields = ?, sync_rev = sync_rev + 1 WHERE id = 1')
    .run(JSON.stringify({ task: 'Review the result', status: 'done' }));
  const edited = source.read(POLL);
  expect(edited.agentView.revision).toBe(initial.agentView.revision + 1);
  expect(edited.lists[0].tasks[0].status).toBe('done');
});

test('title-cache changes bypass the activity window', () => {
  const initial = source.read(POLL).agentView.revision;
  writeFileSync(titleCachePath, JSON.stringify({ request: 'Updated title' }));
  expect(source.read(POLL).agentView.revision).toBe(initial + 1);
});

test('ledger updates bypass the activity window', () => {
  const initial = source.read(POLL).agentView.revision;
  writeFileSync(join(directory, 'refresh.json'), JSON.stringify({ state: 'ok' }));
  expect(source.read(POLL).agentView.revision).toBe(initial + 1);
});

test('source health is still checked while activity is cached', () => {
  source.read(POLL);
  writer.exec('DROP TABLE work_state_entries');
  const unavailable = source.read(POLL);
  expect(unavailable.source.connected).toBe(false);
});

test('reopening the source cannot reuse the old connection activity signature', () => {
  const initial = source.read(POLL).agentView.revision;
  source.close();
  writer.exec('INSERT INTO unrelated_activity VALUES (1)');
  expect(source.read(POLL).agentView.revision).toBe(initial + 1);
});

test('a clock rollback does not extend cached activity freshness', () => {
  const initial = source.read(POLL).agentView.revision;
  writer.exec('INSERT INTO unrelated_activity VALUES (1)');
  setSystemTime(START - 1000);
  expect(source.read(POLL).agentView.revision).toBe(initial + 1);
});

test('activity freshness is not renewed by a cached database-read heartbeat', () => {
  const first = source.read(POLL).agentView.source;
  expect(first.activityCheckedAt).toBe(new Date(START).toISOString());
  setSystemTime(START + 30_000);
  const cached = source.read(POLL).agentView.source;
  expect(cached.lastCheckedAt).toBe(new Date(START + 30_000).toISOString());
  expect(cached.activityCheckedAt).toBe(first.activityCheckedAt);
  setSystemTime(START + 120_000);
  expect(source.read(POLL).agentView.source.activityCheckedAt).toBe(new Date(START + 120_000).toISOString());
});

test('the work-state revision changes when one row moves one revision higher past 2^53 or past 2^63 - 1', () => {
  writer.exec("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'");
  const insert = writer.prepare("INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch, sync_rev) VALUES ('repo', 'notes', '{}', 1, ?)");
  for (const [before, after] of [['18014398509481984', '18014398509481985'], ['18446744073709551614', '18446744073709551615']]) {
    writer.exec('DELETE FROM work_state_entries');
    for (let row = 0; row < 3; row++) insert.run(before);
    const first = workStateRowsRevision(writer);
    writer.prepare('UPDATE work_state_entries SET sync_rev = ? WHERE id = (SELECT MIN(id) FROM work_state_entries)').run(after);
    expect(workStateRowsRevision(writer)).not.toBe(first);
  }
});

test('revisions summed past the integer range do not fail the read', () => {
  // sync_rev is a canonical decimal from another device; SUM past 2^63 - 1 is an SQLite "integer overflow" error.
  writer.exec("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'");
  const insert = writer.prepare("INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch, sync_rev) VALUES ('repo', 'notes', '{}', 1, ?)");
  insert.run('9223372036854775807');
  insert.run('9223372036854775807');
  const snapshot = source.read();
  expect(snapshot.source.error).toBeNull();
  expect(snapshot.source.connected).toBe(true);
});
