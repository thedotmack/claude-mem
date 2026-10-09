// Regression tests for #3609 slice A (plan-21 step 2): nothing recorded which
// binary version last wrote the database, so an older binary could open a
// newer schema and run its DDL over it. The #3609 timeline has the live case:
// a 13.4.2 copy inside a Claude Desktop sandbox reopened a schema-49 DB, ran
// its v7 rebuild, and dropped discovery_tokens, ON UPDATE CASCADE and the
// three session_summaries FTS triggers — 15 days of silent summary loss.
// The fix stamps PRAGMA user_version (major*1e6 + minor*1e3 + patch) after the
// migration chain and refuses — before any DDL, with a typed
// schema_newer_than_binary error — when the stamp is newer than the running
// binary. Same shape as assertChromaStoreCompatible for the chroma data dir.
//
// Under `bun test` the build-time __DEFAULT_PACKAGE_VERSION__ define is
// absent, so CURRENT_BINARY_VERSION resolves to '0.0.0-dev' (stamp 0): the
// constructor-level "older stamp migrates and raises to current" case is
// covered at the exported-function level instead, and every positive stamp
// correctly refuses the test binary.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import {
  CURRENT_BINARY_VERSION,
  SchemaNewerThanBinaryError,
  assertSchemaWriterCompatible,
  decodeSchemaWriterStamp,
  encodeSchemaWriterVersion,
  readSchemaWriterStamp,
  stampSchemaWriterVersion,
} from '../../src/services/sqlite/connection.js';

const ISO = '2025-07-01T00:00:00.000Z';
const EPOCH = 1751328000000;

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-writer-version-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

/** A pre-v7 file DB: the observations FK lacks ON UPDATE CASCADE and the table lacks discovery_tokens. */
function createLegacyDbFile(dir: string): string {
  const dbPath = path.join(dir, 'claude-mem-test.db');
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
    )
  `);
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
    )
  `);
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-legacy', 'mem-legacy', 'proj-a', ?, ?, 'completed')
  `).run(ISO, EPOCH);
  db.close();
  return dbPath;
}

function snapshotFile(dbPath: string): { stamp: number; integrity: string; tables: string[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stamp = readSchemaWriterStamp(db);
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    ).map(row => row.name);
    return { stamp, integrity, tables };
  } finally {
    db.close();
  }
}

describe('schema writer-version stamp', () => {
  it('refuses a newer-stamped DB at the SessionStore constructor and leaves the file untouched', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);
    const newerStamp = encodeSchemaWriterVersion('99.0.0');
    const raw = new Database(dbPath);
    raw.run(`PRAGMA user_version = ${newerStamp}`);
    raw.close();

    const before = snapshotFile(dbPath);
    expect(before.stamp).toBe(newerStamp);

    let thrown: unknown;
    try {
      new SessionStore(dbPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaNewerThanBinaryError);
    const typed = thrown as SchemaNewerThanBinaryError;
    expect(typed.reason).toBe('schema_newer_than_binary');
    expect(typed.message).toContain('99.0.0');
    expect(typed.message).toContain(CURRENT_BINARY_VERSION);
    expect(typed.message).toMatch(/upgrade claude-mem/i);

    const after = snapshotFile(dbPath);
    expect(after).toEqual(before);
  });

  it('refuses a newer-stamped DB at the SessionSearch constructor and leaves the file untouched', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);
    const raw = new Database(dbPath);
    raw.run(`PRAGMA user_version = ${encodeSchemaWriterVersion('99.0.0')}`);
    raw.close();

    const before = snapshotFile(dbPath);

    expect(() => new SessionSearch(dbPath)).toThrow(SchemaNewerThanBinaryError);

    expect(snapshotFile(dbPath)).toEqual(before);
  });

  it('adopts a stamp-less legacy DB, runs the migration chain, then stamps it', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);
    expect(snapshotFile(dbPath).stamp).toBe(0);

    const store = new SessionStore(dbPath);

    // The chain ran: v21 rebuilt the observations FK with ON UPDATE CASCADE
    // and ensureDiscoveryTokensColumn backfilled the column.
    const fkSql = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'observations'").get() as { sql: string };
    expect(fkSql.sql).toContain('ON UPDATE CASCADE');
    expect(() => store.db.prepare('SELECT discovery_tokens FROM observations LIMIT 0').run()).not.toThrow();
    expect(readSchemaWriterStamp(store.db)).toBe(encodeSchemaWriterVersion(CURRENT_BINARY_VERSION));
    store.close();
  });

  it('reopens an equally-stamped DB without refusing', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'claude-mem-test.db');

    const first = new SessionStore(dbPath);
    const stampAfterFirst = readSchemaWriterStamp(first.db);
    first.close();

    const second = new SessionStore(dbPath);
    expect(readSchemaWriterStamp(second.db)).toBe(stampAfterFirst);
    second.close();
  });

  it('stamps after SessionSearch recreates missing FTS tables — the #3609 damage scenario', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'claude-mem-test.db');
    const store = new SessionStore(dbPath);
    expect(readSchemaWriterStamp(store.db)).toBe(encodeSchemaWriterVersion(CURRENT_BINARY_VERSION));
    // The migration chain builds no FTS objects; an older binary (or the
    // 13.4.2 lax probe from #3609) leaves the DB without them.
    expect((store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%fts%'").all()).length).toBe(0);

    new SessionSearch(store.db);

    expect(readSchemaWriterStamp(store.db)).toBe(encodeSchemaWriterVersion(CURRENT_BINARY_VERSION));
    const ftsTables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_fts'").all() as { name: string }[];
    expect(ftsTables.map(row => row.name).sort()).toEqual(['observations_fts', 'session_summaries_fts']);
    store.close();
  });

  it('migrates an older stamp up to the current version', () => {
    const dir = makeTempDir();
    const db = new Database(path.join(dir, 'claude-mem-test.db'));
    db.run('CREATE TABLE marker (id INTEGER)');
    const olderStamp = encodeSchemaWriterVersion('13.33.0');
    db.run(`PRAGMA user_version = ${olderStamp}`);

    expect(() => assertSchemaWriterCompatible(db, '13.34.0')).not.toThrow();
    stampSchemaWriterVersion(db, '13.34.0');
    expect(readSchemaWriterStamp(db)).toBe(encodeSchemaWriterVersion('13.34.0'));
    expect(readSchemaWriterStamp(db)).toBeGreaterThan(olderStamp);
    db.close();
  });

  it('compares prerelease suffixes by their base, like compareVersionsDescending', () => {
    expect(encodeSchemaWriterVersion('13.34.2-rc.1')).toBe(encodeSchemaWriterVersion('13.34.2'));
    expect(decodeSchemaWriterStamp(encodeSchemaWriterVersion('13.34.2'))).toBe('13.34.2');

    const db = new Database(':memory:');
    db.run(`PRAGMA user_version = ${encodeSchemaWriterVersion('13.34.2')}`);
    expect(() => assertSchemaWriterCompatible(db, '13.34.2-rc.1')).not.toThrow();
    db.close();
  });
});
