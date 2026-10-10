// Regression tests for #3609 (slice B): SQLite drops a table's triggers along
// with the table, so the v7 (UNIQUE-constraint) and v9 (text-nullable) rebuilds
// silently destroyed the *_ai/_ad/_au FTS sync triggers while the external-
// content index itself survived — and SessionSearch.ensureFTSTables only
// checked for the _fts tables, so nothing ever converged a database that had
// gone through a rebuild. MATCH searches then silently missed every write
// after the rebuild, forever. Both loops are covered here: the rebuilds must
// recreate the triggers when the index survived, and ensureFTSTables must
// detect missing triggers and recreate them (without a backfill — reinserting
// into an existing external-content index corrupts its delete/update
// bookkeeping, so repair is forward-looking by design).
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import {
  OBSERVATIONS_FTS_TRIGGERS_SQL,
  SESSION_SUMMARIES_FTS_TRIGGERS_SQL,
} from '../../src/services/sqlite/SessionSearch.js';

const ISO = '2025-07-01T00:00:00.000Z';
const EPOCH = 1751328000000;

const ALL_FTS_TRIGGERS = [
  'observations_ad',
  'observations_ai',
  'observations_au',
  'session_summaries_ad',
  'session_summaries_ai',
  'session_summaries_au',
];

interface BaseTableOptions {
  /** v9 precondition: observations.text carries the old NOT NULL. */
  observationsTextNotNull?: boolean;
  /** v7 precondition: session_summaries.memory_session_id is table-level UNIQUE. */
  summariesUnique?: boolean;
}

function createBaseTables(db: Database, options: BaseTableOptions = {}): void {
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
  const textNotNull = options.observationsTextNotNull ? ' NOT NULL' : '';
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT${textNotNull},
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  const memorySessionId = options.summariesUnique ? 'TEXT UNIQUE NOT NULL' : 'TEXT NOT NULL';
  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id ${memorySessionId},
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      notes TEXT,
      prompt_number INTEGER,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-healthy', 'mem-healthy', 'proj-a', ?, ?, 'completed')
  `).run(ISO, EPOCH);
}

function createFtsTables(db: Database): void {
  db.run(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title,
      subtitle,
      narrative,
      text,
      facts,
      concepts,
      content='observations',
      content_rowid='id'
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
      request,
      investigated,
      learned,
      completed,
      next_steps,
      notes,
      content='session_summaries',
      content_rowid='id'
    )
  `);
}

function createAllFtsTriggers(db: Database): void {
  db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
  db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
}

function stampVersions(db: Database, versions: number[]): void {
  for (const version of versions) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, ISO);
  }
}

function seedObservation(db: Database, text: string): void {
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', ?, 'discovery', ?, ?)
  `).run(text, ISO, EPOCH);
}

function seedSummary(db: Database, request: string): void {
  db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', ?, ?, ?)
  `).run(request, ISO, EPOCH);
}

function existingFtsTriggers(db: Database): string[] {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN ('observations_ai', 'observations_ad', 'observations_au',
                   'session_summaries_ai', 'session_summaries_ad', 'session_summaries_au')
    ORDER BY name
  `).all() as { name: string }[];
  return rows.map(row => row.name);
}

function ftsMatches(db: Database, ftsTable: 'observations_fts' | 'session_summaries_fts', term: string): unknown[] {
  return db.prepare(`SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?`).all(term);
}

describe('FTS sync triggers survive table rebuilds and converge when missing (#3609)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDbPath(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-fts-triggers-'));
    return path.join(tempDir, 'claude-mem.db');
  }

  it('a drifted database with both indexes but zero triggers self-heals and indexes new writes without backfilling', () => {
    const dbPath = makeTempDbPath();
    const db = new Database(dbPath);
    db.run('PRAGMA foreign_keys = OFF');
    createBaseTables(db);
    createFtsTables(db);
    // The post-rebuild drift: both index tables exist, no sync triggers at all.
    stampVersions(db, [4, 11, 21]);
    seedObservation(db, 'prehistoric mammoth census');
    seedSummary(db, 'prehistoric sabertooth ledger');
    db.run('PRAGMA foreign_keys = ON');
    db.close();

    const store = new SessionStore(dbPath);
    const search = new SessionSearch(store.db);

    expect(existingFtsTriggers(store.db)).toEqual(ALL_FTS_TRIGGERS);

    // Writes after the repair reach the index immediately.
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'post-repair walrus survey', 'discovery', ?, ?)
    `).run(ISO, EPOCH);
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'post-repair quokka synopsis', ?, ?)
    `).run(ISO, EPOCH);

    expect(search.searchObservations('walrus')).toHaveLength(1);
    expect(search.searchSessions('quokka')).toHaveLength(1);

    // Repair is forward-looking: the pre-existing rows were never backfilled
    // into the index. MATCH is the probe that counts here — a bare scan of an
    // external-content table is answered from the base table, the index is not.
    expect(ftsMatches(store.db, 'observations_fts', 'prehistoric')).toEqual([]);
    expect(ftsMatches(store.db, 'session_summaries_fts', 'prehistoric')).toEqual([]);
    expect(ftsMatches(store.db, 'observations_fts', 'walrus')).toHaveLength(1);
    expect(ftsMatches(store.db, 'session_summaries_fts', 'quokka')).toHaveLength(1);

    store.close();
  });

  it('the v7 UNIQUE-constraint rebuild no longer drops the session_summaries FTS triggers', () => {
    const dbPath = makeTempDbPath();
    const db = new Database(dbPath);
    db.run('PRAGMA foreign_keys = OFF');
    createBaseTables(db, { summariesUnique: true });
    createFtsTables(db);
    createAllFtsTriggers(db);
    stampVersions(db, [4, 11, 21]);
    seedSummary(db, 'pre-rebuild heron ledger');
    db.run('PRAGMA foreign_keys = ON');
    db.close();

    // SessionStore only: the triggers must be restored by the rebuild itself,
    // not by SessionSearch's convergence pass.
    const store = new SessionStore(dbPath);

    expect(existingFtsTriggers(store.db)).toEqual(ALL_FTS_TRIGGERS);

    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'post-rebuild pangolin dossier', ?, ?)
    `).run(ISO, EPOCH);
    expect(ftsMatches(store.db, 'session_summaries_fts', 'pangolin')).toHaveLength(1);
    // The rebuild preserved rowids, so entries indexed before it (the seeded
    // row was written while the old triggers were still attached) stay valid —
    // the index carries across the rebuild continuously.
    expect(ftsMatches(store.db, 'session_summaries_fts', 'heron')).toHaveLength(1);

    store.close();
  });

  it('the v9 text-nullable rebuild no longer drops the observations FTS triggers', () => {
    const dbPath = makeTempDbPath();
    const db = new Database(dbPath);
    db.run('PRAGMA foreign_keys = OFF');
    createBaseTables(db, { observationsTextNotNull: true });
    createFtsTables(db);
    createAllFtsTriggers(db);
    // v9 must be unstamped so the NOT NULL text column actually rebuilds.
    stampVersions(db, [4, 7, 11, 21]);
    seedObservation(db, 'pre-rebuild ibex census');
    db.run('PRAGMA foreign_keys = ON');
    db.close();

    const store = new SessionStore(dbPath);

    expect(existingFtsTriggers(store.db)).toEqual(ALL_FTS_TRIGGERS);

    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'post-rebuild caracal sighting', 'discovery', ?, ?)
    `).run(ISO, EPOCH);
    expect(ftsMatches(store.db, 'observations_fts', 'caracal')).toHaveLength(1);
    // See the v7 case: index entries made before the rebuild stay valid.
    expect(ftsMatches(store.db, 'observations_fts', 'ibex')).toHaveLength(1);

    store.close();
  });

  it('a fully provisioned database is untouched by a second boot', () => {
    const dbPath = makeTempDbPath();
    const db = new Database(dbPath);
    db.run('PRAGMA foreign_keys = OFF');
    createBaseTables(db);
    createFtsTables(db);
    createAllFtsTriggers(db);
    stampVersions(db, [4, 7, 9, 11, 21]);
    db.run('PRAGMA foreign_keys = ON');
    db.close();

    const first = new SessionStore(dbPath);
    new SessionSearch(first.db);
    const before = first.db.prepare(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'
    ).all();
    first.close();

    const second = new SessionStore(dbPath);
    new SessionSearch(second.db);
    const after = second.db.prepare(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'
    ).all();

    expect(after).toEqual(before);
    second.close();
  });

  it('v54 still rescopes a legacy unscoped observations_au after a converged database boots', () => {
    const dbPath = makeTempDbPath();
    const db = new Database(dbPath);
    db.run('PRAGMA foreign_keys = OFF');
    createBaseTables(db);
    createFtsTables(db);
    // A pre-v54-shaped update trigger: no UPDATE OF column list. Created first,
    // so the IF NOT EXISTS trigger SQL fills in the remaining five.
    db.run(`
      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `);
    createAllFtsTriggers(db);
    stampVersions(db, [4, 7, 9, 11, 21]);
    db.run('PRAGMA foreign_keys = ON');
    db.close();

    const store = new SessionStore(dbPath);
    new SessionSearch(store.db);

    const auSql = (store.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'observations_au'"
    ).get() as { sql: string }).sql;
    expect(auSql).toContain('UPDATE OF');
    expect(existingFtsTriggers(store.db)).toEqual(ALL_FTS_TRIGGERS);

    store.close();
  });
});
