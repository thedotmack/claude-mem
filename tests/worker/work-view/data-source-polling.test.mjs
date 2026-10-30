import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';

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

test('work-state writes bypass the activity window', () => {
  const initial = source.read(POLL).agentView.revision;
  writer.prepare('INSERT INTO work_state_entries VALUES (1, ?, ?, ?, ?)')
    .run('project', 'work', JSON.stringify({ task: 'Review the result', status: 'todo' }), START);
  const next = source.read(POLL);
  expect(next.agentView.revision).toBe(initial + 1);
  expect(next.entryCount).toBe(1);
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
