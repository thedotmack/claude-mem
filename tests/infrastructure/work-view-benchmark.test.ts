import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../scripts/benchmark-work-view.ts');
const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, '--cold-runs', '1', '--warm-runs', '1', ...args]);

test('benchmark defaults to synthetic data and reports aggregate query equivalence', () => {
  const result = run('--rows', '10', '--payload-bytes', '1');
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(report.mode).toBe('synthetic-sparse-history');
  expect(report.snapshot.requestCount).toBe(140);
  expect(report.newReader.samples).toBe(1);
  expect(report.queryWindows.map((window: { cutoff: string }) => window.cutoff)).toEqual(['recent-work-state', 'all-history']);
  for (const window of report.queryWindows) {
    expect(window.queries.every((query: { identicalRowsAndOrder: boolean }) => query.identicalRowsAndOrder)).toBe(true);
  }
  expect(new TextDecoder().decode(result.stdout)).not.toContain('Synthetic request');
});

test('explicit database profiling is read-only and refuses database/sidecar report paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'benchmark-readonly-test-'));
  const path = join(directory, 'source.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER,
      tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, prompt_number INTEGER,
      files_modified TEXT, created_at_epoch INTEGER);
    CREATE TABLE deliverables (id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT,
      platform_source TEXT, title TEXT, kind TEXT, source_path TEXT, bucket_path TEXT, created_at_epoch INTEGER);
  `);
  db.close();
  const before = readFileSync(path);
  try {
    const result = run('--db', path);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout)).mode).toBe('explicit-read-only-database');
    expect(readFileSync(path)).toEqual(before);
    for (const output of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      expect(run('--db', path, '--output', output).exitCode).not.toBe(0);
      expect(readFileSync(path)).toEqual(before);
      if (output !== path) expect(existsSync(output)).toBe(false);
    }
    for (const createAlias of [symlinkSync, linkSync]) {
      const alias = join(directory, createAlias === symlinkSync ? 'symlink-report.json' : 'hardlink-report.json');
      createAlias(path, alias);
      expect(run('--db', path, '--output', alias).exitCode).not.toBe(0);
      expect(readFileSync(path)).toEqual(before);
    }
    const sidecar = `${path}-journal`;
    writeFileSync(sidecar, 'protected sidecar');
    const sidecarAlias = join(directory, 'journal-alias.json');
    linkSync(sidecar, sidecarAlias);
    expect(run('--db', path, '--output', sidecarAlias).exitCode).not.toBe(0);
    expect(readFileSync(sidecar, 'utf8')).toBe('protected sidecar');
    rmSync(sidecar);
    const reportPath = join(directory, 'report.json');
    expect(run('--db', path, '--output', reportPath).exitCode).toBe(0);
    expect(run('--db', path, '--output', reportPath).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).mode).toBe('explicit-read-only-database');
    expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('explicit missing database never becomes a newly created database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'benchmark-missing-test-'));
  const path = join(directory, 'missing.db');
  try {
    expect(run('--db', path).exitCode).not.toBe(0);
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('nonexistent sidecars stay protected through symlinked parent directories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'benchmark-parent-alias-test-'));
  const realDirectory = join(directory, 'real');
  const aliasDirectory = join(directory, 'alias');
  mkdirSync(realDirectory);
  symlinkSync(realDirectory, aliasDirectory, 'dir');
  const path = join(realDirectory, 'source.db');
  const db = new Database(path);
  db.exec('CREATE TABLE original (value TEXT)');
  db.close();
  const before = readFileSync(path);
  try {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const output = join(aliasDirectory, `source.db${suffix}`);
      const result = run('--db', path, '--output', output);
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain('Report output cannot overwrite the database or its sidecars');
      expect(existsSync(`${path}${suffix}`)).toBe(false);
      expect(readFileSync(path)).toEqual(before);
    }
    // Selecting the database through a file symlink must also protect the
    // actual SQLite file's sidecar names, not just the selected alias name.
    const databaseAlias = join(directory, 'database-alias.db');
    symlinkSync(path, databaseAlias);
    expect(run('--db', databaseAlias, '--output', `${path}-wal`).exitCode).not.toBe(0);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
