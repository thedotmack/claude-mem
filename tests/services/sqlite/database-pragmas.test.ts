import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SQLITE_BUSY_TIMEOUT_MS, enableIncrementalAutoVacuumIfFresh } from '../../../src/services/sqlite/connection.js';

const AUTO_VACUUM_NONE = 0;
const AUTO_VACUUM_INCREMENTAL = 2;

function autoVacuumMode(db: Database): number {
  return (db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
}

function busyTimeout(db: Database): number {
  return Number((db.query('PRAGMA busy_timeout').get() as { timeout: number | string }).timeout);
}

describe('SQLite database pragmas', () => {
  let tempDir: string;
  const openedDbs: Database[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-sqlite-pragmas-'));
  });

  afterEach(() => {
    while (openedDbs.length > 0) {
      openedDbs.pop()?.close();
    }
    rmSync(tempDir, { force: true, recursive: true });
  });

  function openTestDb(name: string): Database {
    const db = new Database(join(tempDir, name), { create: true, readwrite: true });
    openedDbs.push(db);
    return db;
  }

  it('enables incremental auto-vacuum only for fresh file databases', () => {
    const freshStore = new SessionStore(join(tempDir, 'fresh-store.sqlite'));
    openedDbs.push(freshStore.db);

    expect(autoVacuumMode(freshStore.db)).toBe(AUTO_VACUUM_INCREMENTAL);

    const legacyDb = openTestDb('legacy.sqlite');
    legacyDb.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(autoVacuumMode(legacyDb)).toBe(AUTO_VACUUM_NONE);

    expect(enableIncrementalAutoVacuumIfFresh(legacyDb)).toBe(false);
    expect(autoVacuumMode(legacyDb)).toBe(AUTO_VACUUM_NONE);
  });

  it('keeps dropped-table legacy files at NONE when they are not truly fresh', () => {
    const db = openTestDb('dropped.sqlite');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, payload BLOB)');
    db.prepare('INSERT INTO t (payload) VALUES (?)').run(Buffer.alloc(4096, 1));
    db.run('DROP TABLE t');

    const tableCount = (db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count: number }).count;
    const pageCount = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;

    expect(tableCount).toBe(0);
    expect(pageCount).toBeGreaterThan(1);
    expect(enableIncrementalAutoVacuumIfFresh(db)).toBe(false);
    expect(autoVacuumMode(db)).toBe(AUTO_VACUUM_NONE);
  });

  it('applies busy_timeout to primary path-owned SessionStore and SessionSearch connections', () => {
    const store = new SessionStore(join(tempDir, 'store.sqlite'));
    const search = new SessionSearch(join(tempDir, 'search.sqlite'));
    openedDbs.push(store.db);
    openedDbs.push((search as unknown as { db: Database }).db);

    expect(busyTimeout(store.db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(busyTimeout((search as unknown as { db: Database }).db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('applies busy_timeout when services receive an existing shared Database', () => {
    const db = new Database(':memory:');
    openedDbs.push(db);

    new SessionStore(db);
    expect(busyTimeout(db)).toBe(SQLITE_BUSY_TIMEOUT_MS);

    db.run('PRAGMA busy_timeout = 0');
    new SessionSearch(db);
    expect(busyTimeout(db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });
});
