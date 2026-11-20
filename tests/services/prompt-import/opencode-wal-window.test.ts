import { Database } from 'bun:sqlite';
import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const DAY = 86_400_000;
const NOW = Date.now();
const SINCE = NOW - 30 * DAY;
let home: string | undefined;
let writer: Database | undefined;

afterEach(() => {
  writer?.close();
  writer = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function fixture(eventAt = NOW): string {
  home = mkdtempSync(join(tmpdir(), 'cm-opencode-wal-'));
  const file = join(home, '.local/share/opencode/opencode.db');
  mkdirSync(dirname(file), { recursive: true });
  writer = new Database(file);
  expect(writer.query('PRAGMA journal_mode = WAL').get()).toEqual({ journal_mode: 'wal' });
  writer.exec('PRAGMA wal_autocheckpoint = 0');
  writer.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `);
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  utimesSync(file, (SINCE - DAY) / 1000, (SINCE - DAY) / 1000);
  writer.run('INSERT INTO session VALUES (?, ?, ?)', ['session', '/work/app', null]);
  writer.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['user', 'session', eventAt, JSON.stringify({ role: 'user' })]);
  writer.run('INSERT INTO part VALUES (?, ?, ?)', ['text', 'user', JSON.stringify({ type: 'text', text: 'please retain my current OpenCode prompt' })]);
  writer.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['assistant', 'session', eventAt, JSON.stringify({ role: 'assistant', tokens: { input: 100, output: 23 } })]);
  // The committed rows really are in the database while only the WAL is fresh.
  expect(writer.query('SELECT COUNT(*) AS count FROM message').get()).toEqual({ count: 2 });
  expect(statSync(file).mtimeMs).toBeLessThan(SINCE);
  expect(statSync(`${file}-wal`).mtimeMs).toBeGreaterThanOrEqual(SINCE);
  return file;
}

async function scan(): Promise<{ prompts: string[]; tokens: number }> {
  const prompts = await scanOwnerPrompts({ sinceEpochMs: SINCE, homeDirectory: home!, agents: ['opencode'], resolveProject: () => 'app', excludedProjects: '' });
  const usage = await scanTokenUsage({ sinceEpochMs: SINCE, homeDirectory: home!, agents: ['opencode'] });
  expect(prompts.skippedSources).toEqual([]);
  expect(usage.agents[0].skippedSources).toBe(0);
  return { prompts: prompts.ownerPrompts.map(prompt => prompt.text), tokens: usage.agents[0].tokens };
}

it('reads committed current prompts and usage from a fresh WAL beside an old database file', async () => {
  fixture();
  expect(await scan()).toEqual({ prompts: ['please retain my current OpenCode prompt'], tokens: 123 });
});

it('a fresh WAL does not include rows outside the requested event window', async () => {
  fixture(SINCE - DAY);
  expect(await scan()).toEqual({ prompts: [], tokens: 0 });
});
