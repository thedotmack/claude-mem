// Regression tests for #3609 slice A (plan-21 step 2): nothing recorded which
// binary version last wrote the database, so an older binary could open a
// newer schema and run its DDL over it. The #3609 timeline has the live case:
// a 13.4.2 copy inside a Claude Desktop sandbox reopened a schema-49 DB, ran
// its v7 rebuild, and dropped discovery_tokens, ON UPDATE CASCADE and the
// three session_summaries FTS triggers — 15 days of silent summary loss.
//
// The stamp is the highest SessionStore migration version this binary knows
// (LATEST_SCHEMA_VERSION), not the plugin semver (#4602 review): most
// releases don't touch the schema, so a semver comparison turned harmless
// downgrades — one bad patch rolled back, two hosts sharing ~/.claude-mem on
// different bundled versions, the plan-16 stale-plugin-dir spawn — into full
// outages. The refusal (#4602 review) fires only when the database's schema
// is newer than the running binary's chain, before any DDL, with a typed
// schema_newer_than_binary error. Same shape as assertChromaStoreCompatible
// for the chroma data dir.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import {
  LATEST_SCHEMA_VERSION,
  SchemaNewerThanBinaryError,
  assertSchemaWriterCompatible,
  claimSchemaWriter,
  openGuardedSqliteDatabase,
  readSchemaWriterStamp,
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
  it('pins LATEST_SCHEMA_VERSION to MAX(version) FROM schema_versions after a fresh open (#4602 review)', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'claude-mem-test.db');

    const store = new SessionStore(dbPath);
    const maxApplied = store.db.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as { v: number };
    expect(maxApplied.v).toBe(LATEST_SCHEMA_VERSION);
    store.close();
  });

  it('refuses a newer-schema DB at the SessionStore constructor and leaves the file untouched', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);
    const newerStamp = LATEST_SCHEMA_VERSION + 1;
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
    expect(typed.message).toContain(`schema v${newerStamp}`);
    expect(typed.message).toContain(`knows up to schema v${LATEST_SCHEMA_VERSION}`);
    expect(typed.message).toMatch(/upgrade claude-mem/i);

    const after = snapshotFile(dbPath);
    expect(after).toEqual(before);
  });

  it('refuses a newer-schema DB at the SessionSearch constructor and leaves the file untouched', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);
    const raw = new Database(dbPath);
    raw.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
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
    expect(readSchemaWriterStamp(store.db)).toBe(LATEST_SCHEMA_VERSION);
    store.close();
  });

  it('plugin semver rollback with an unchanged schema is not an outage: an equally-stamped DB reopens', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'claude-mem-test.db');

    // "Newer plugin" writes the DB: the stamp names the schema, not the semver.
    const first = new SessionStore(dbPath);
    const stampAfterFirst = readSchemaWriterStamp(first.db);
    expect(stampAfterFirst).toBe(LATEST_SCHEMA_VERSION);
    first.close();

    // The rollback case from #4602 review: an older bundled plugin whose chain
    // ends at the same migration reopens the file — only schema versions are
    // compared, so an equal stamp adopts regardless of either binary's semver.
    const second = new SessionStore(dbPath);
    expect(readSchemaWriterStamp(second.db)).toBe(stampAfterFirst);
    second.close();
  });

  it('refuses only a schema newer than this binary\'s chain: equal adopts, 0 adopts, older adopts', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE marker (id INTEGER)');

    claimSchemaWriter(db, LATEST_SCHEMA_VERSION);
    expect(() => assertSchemaWriterCompatible(db, LATEST_SCHEMA_VERSION)).not.toThrow();
    expect(() => assertSchemaWriterCompatible(db, LATEST_SCHEMA_VERSION + 5)).not.toThrow();

    db.run('PRAGMA user_version = 0');
    expect(() => assertSchemaWriterCompatible(db, LATEST_SCHEMA_VERSION)).not.toThrow();

    db.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    expect(() => assertSchemaWriterCompatible(db, LATEST_SCHEMA_VERSION - 1)).toThrow(SchemaNewerThanBinaryError);
    db.close();
  });

  it('migrates an older schema stamp up to the current version', () => {
    const dir = makeTempDir();
    const db = new Database(path.join(dir, 'claude-mem-test.db'));
    db.run('CREATE TABLE marker (id INTEGER)');
    const olderStamp = LATEST_SCHEMA_VERSION - 14;
    db.run(`PRAGMA user_version = ${olderStamp}`);

    claimSchemaWriter(db, LATEST_SCHEMA_VERSION);
    expect(readSchemaWriterStamp(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(readSchemaWriterStamp(db)).toBeGreaterThan(olderStamp);
    db.close();
  });

  it('stamps before the migration chain, so a mid-chain failure still refuses older binaries', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);

    // Fail a late chain step after earlier steps have committed their DDL.
    const prototype = SessionStore.prototype as unknown as Record<string, () => void>;
    const original = prototype.ensureWorkStateTable;
    prototype.ensureWorkStateTable = function injectedMidChainFailure(): never {
      throw new Error('injected mid-chain failure');
    };
    try {
      expect(() => new SessionStore(dbPath)).toThrow('injected mid-chain failure');
    } finally {
      prototype.ensureWorkStateTable = original;
    }

    // The partial DDL is on disk and the stamp was written before the chain
    // ran, so a binary whose chain stops below this one is refused over the
    // partially-upgraded file.
    const probe = new Database(dbPath, { readonly: true });
    expect(readSchemaWriterStamp(probe)).toBe(LATEST_SCHEMA_VERSION);
    probe.close();
    const older = new Database(dbPath);
    expect(() => assertSchemaWriterCompatible(older, LATEST_SCHEMA_VERSION - 1)).toThrow(SchemaNewerThanBinaryError);
    older.close();

    // The same-chain version reopens and completes the idempotent chain.
    const retried = new SessionStore(dbPath);
    expect(readSchemaWriterStamp(retried.db)).toBe(LATEST_SCHEMA_VERSION);
    retried.close();
  });

  it('shared open path refuses before pragmas: a newer-schema DELETE-mode DB stays DELETE', () => {
    const dir = makeTempDir();
    const dbPath = createLegacyDbFile(dir);
    const raw = new Database(dbPath);
    raw.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();
    const journalMode = (db: Database): string =>
      (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    expect(journalMode(new Database(dbPath, { readonly: true }))).toBe('delete');

    const before = snapshotFile(dbPath);
    expect(() => openGuardedSqliteDatabase(dbPath)).toThrow(SchemaNewerThanBinaryError);

    expect(snapshotFile(dbPath)).toEqual(before);
    // The refusal ran before journal_mode = WAL, so the file keeps DELETE mode.
    expect(journalMode(new Database(dbPath, { readonly: true }))).toBe('delete');

    // The guard ordering does not affect the normal path: a compatible DB is
    // still pragma-configured by the same helper.
    const adoptedPath = path.join(dir, 'claude-mem-adopted.db');
    new Database(adoptedPath).close();
    const adopted = openGuardedSqliteDatabase(adoptedPath);
    expect(journalMode(adopted)).toBe('wal');
    adopted.close();
  });

  it('stamps after SessionSearch recreates missing FTS tables — the #3609 damage scenario', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'claude-mem-test.db');
    const store = new SessionStore(dbPath);
    expect(readSchemaWriterStamp(store.db)).toBe(LATEST_SCHEMA_VERSION);
    // The migration chain builds no FTS objects; an older binary (or the
    // 13.4.2 lax probe from #3609) leaves the DB without them.
    expect((store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%fts%'").all()).length).toBe(0);

    // Reset the stamp to 0 first: an assertion against the value SessionStore
    // already wrote proves nothing about SessionSearch's own write path, so
    // only a fresh write from the FTS DDL can satisfy it (#4602 review).
    store.db.run('PRAGMA user_version = 0');
    expect(readSchemaWriterStamp(store.db)).toBe(0);

    new SessionSearch(store.db);

    expect(readSchemaWriterStamp(store.db)).toBe(LATEST_SCHEMA_VERSION);
    const ftsTables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_fts'").all() as { name: string }[];
    expect(ftsTables.map(row => row.name).sort()).toEqual(['observations_fts', 'session_summaries_fts']);
    store.close();
  });

  describe('check-and-stamp is atomic across connections (#4602 review)', () => {
    /**
     * A connection that lets another worker stamp the file in the window
     * after the constructor's first read-only check and before its first
     * schema write: the pragma step sits exactly there in both constructors.
     */
    class ConnectionRacedByNewerWorker extends Database {
      private raced = false;
      constructor(dbPath: string, private readonly newerWorkerStamp: number) {
        super(dbPath);
      }
      override run(sql: string, ...bindings: unknown[]): ReturnType<Database['run']> {
        if (!this.raced && sql.startsWith('PRAGMA journal_mode')) {
          this.raced = true;
          const newerWorker = new Database(this.filename);
          newerWorker.run(`PRAGMA user_version = ${this.newerWorkerStamp}`);
          newerWorker.close();
        }
        return super.run(sql, ...(bindings as []));
      }
    }

    it('SessionStore refuses when a newer worker stamps after its first check, and runs no migration', () => {
      const dir = makeTempDir();
      const dbPath = createLegacyDbFile(dir);
      const newerStamp = LATEST_SCHEMA_VERSION + 1;
      const raced = new ConnectionRacedByNewerWorker(dbPath, newerStamp);

      expect(() => new SessionStore(raced)).toThrow(SchemaNewerThanBinaryError);
      raced.close();

      const after = snapshotFile(dbPath);
      // The newer worker's stamp survives, and the legacy file was not migrated.
      expect(after.stamp).toBe(newerStamp);
      expect(after.tables).toEqual(['observations', 'schema_versions', 'sdk_sessions']);
    });

    it('SessionSearch refuses when a newer worker stamps after its first check, and writes no FTS DDL', () => {
      const dir = makeTempDir();
      const dbPath = path.join(dir, 'claude-mem-test.db');
      new SessionStore(dbPath).close();
      const newerStamp = LATEST_SCHEMA_VERSION + 1;
      const raced = new ConnectionRacedByNewerWorker(dbPath, newerStamp);

      expect(() => new SessionSearch(raced)).toThrow(SchemaNewerThanBinaryError);
      raced.close();

      const after = snapshotFile(dbPath);
      expect(after.stamp).toBe(newerStamp);
      expect(after.tables.filter(name => name.endsWith('_fts'))).toEqual([]);
    });

    it('an older connection that read the stamp earlier cannot claim after a newer one stamped', () => {
      const dir = makeTempDir();
      const dbPath = createLegacyDbFile(dir);
      const olderVersion = LATEST_SCHEMA_VERSION - 1;

      const older = new Database(dbPath);
      expect(() => assertSchemaWriterCompatible(older, olderVersion)).not.toThrow();

      // The newer worker claims, stamps and migrates in between.
      new SessionStore(dbPath).close();

      expect(() => claimSchemaWriter(older, olderVersion)).toThrow(SchemaNewerThanBinaryError);
      expect(readSchemaWriterStamp(older)).toBe(LATEST_SCHEMA_VERSION);
      older.close();
    });

    it('the claim takes the write lock: it waits on a concurrent writer and re-checks after it commits', () => {
      const dir = makeTempDir();
      const dbPath = createLegacyDbFile(dir);
      const newer = new Database(dbPath);
      const older = new Database(dbPath);
      older.run('PRAGMA busy_timeout = 0');

      newer.run('BEGIN IMMEDIATE');
      expect(() => claimSchemaWriter(older, LATEST_SCHEMA_VERSION - 1)).toThrow(/locked|busy/i);
      newer.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
      newer.run('COMMIT');

      expect(() => claimSchemaWriter(older, LATEST_SCHEMA_VERSION - 1)).toThrow(SchemaNewerThanBinaryError);
      expect(readSchemaWriterStamp(older)).toBe(LATEST_SCHEMA_VERSION);
      newer.close();
      older.close();
    });

    it('the claim raises an older stamp and never lowers an equal one', () => {
      const db = new Database(':memory:');
      db.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION - 3}`);
      claimSchemaWriter(db, LATEST_SCHEMA_VERSION);
      expect(readSchemaWriterStamp(db)).toBe(LATEST_SCHEMA_VERSION);
      claimSchemaWriter(db, LATEST_SCHEMA_VERSION);
      expect(readSchemaWriterStamp(db)).toBe(LATEST_SCHEMA_VERSION);
      db.close();
    });
  });
});
