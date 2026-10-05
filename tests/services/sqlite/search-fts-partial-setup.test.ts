import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seedDatabase(path = ':memory:'): Database {
  const db = new Database(path);
  databases.push(db);
  const store = new SessionStore(db);
  new SessionSearch(db);
  const session = store.createSDKSession('partial-fts', 'fts-recovery', 'prompt');
  store.ensureMemorySessionIdRegistered(session, 'partial-memory');
  store.storeObservation('partial-memory', 'fts-recovery', {
    type: 'discovery', title: 'distinct observation marker', subtitle: null,
    narrative: 'searchable observation', facts: [], concepts: [], files_read: [], files_modified: [],
  }, 1);
  store.storeSummary('partial-memory', 'fts-recovery', {
    request: 'distinct summary marker', investigated: '', learned: '', completed: '', next_steps: '', notes: null,
  }, 1, 0);
  return db;
}

for (const missing of ['observations', 'session_summaries'] as const) {
  describe(`FTS setup with missing ${missing} index`, () => {
    it('recreates and backfills only the missing index, retaining the working index', () => {
      const db = seedDatabase();
      for (const suffix of ['ai', 'ad', 'au']) db.run(`DROP TRIGGER ${missing}_${suffix}`);
      db.run(`DROP TABLE ${missing}_fts`);

      const search = new SessionSearch(db);
      expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').get(`${missing}_fts`)).not.toBeNull();
      expect(search.searchObservations('distinct observation', { project: 'fts-recovery' })).toHaveLength(1);
      expect(search.searchSessions('distinct summary', { project: 'fts-recovery' })).toHaveLength(1);
      for (const table of ['observations', 'session_summaries']) {
        // rank=1 also checks agreement between the external content and index.
        expect(() => db.run(`INSERT INTO ${table}_fts(${table}_fts, rank) VALUES('integrity-check', 1)`)).not.toThrow();
      }

      db.run("UPDATE observations SET title = 'updated observation marker'");
      db.run("UPDATE session_summaries SET request = 'updated summary marker'");
      expect(search.searchObservations('updated observation', { project: 'fts-recovery' })).toHaveLength(1);
      expect(search.searchSessions('updated summary', { project: 'fts-recovery' })).toHaveLength(1);
      expect(search.searchObservations('distinct observation', { project: 'fts-recovery' })).toEqual([]);
      expect(search.searchSessions('distinct summary', { project: 'fts-recovery' })).toEqual([]);
    });
  });
}

describe('FTS initialization failure recovery', () => {
  it('rolls back partial creation so a later startup can retry both indexes', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY, title TEXT, subtitle TEXT, narrative TEXT,
      text TEXT, facts TEXT, concepts TEXT
    )`);
    db.run("INSERT INTO observations(id, title) VALUES(1, 'recoverable finding')");

    // Missing summary schema makes the second index backfill fail.
    new SessionSearch(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'observations_fts'").get()).toBeNull();
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'observations_ai'").get()).toBeNull();

    db.run(`CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY, request TEXT, investigated TEXT, learned TEXT,
      completed TEXT, next_steps TEXT, notes TEXT
    )`);
    new SessionSearch(db);
    expect(db.query("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'recoverable'").all()).toEqual([{ rowid: 1 }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'session_summaries_fts'").get()).not.toBeNull();
  });
});


describe('concurrent missing-index discovery', () => {
  it('rechecks index ownership before backfill when another connection finishes first', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-fts-race-'));
    directories.push(directory);
    const path = join(directory, 'sessions.db');
    const first = seedDatabase(path);
    for (const suffix of ['ai', 'ad', 'au']) first.run(`DROP TRIGGER observations_${suffix}`);
    first.run('DROP TABLE observations_fts');
    const second = new Database(path);
    databases.push(second);
    let interleaved = false;
    const prepare = first.prepare.bind(first);
    // Retain the real first connection's discovery snapshot, then allow a real
    // second connection to finish setup before the first decides to backfill.
    (first as any).prepare = (sql: string, ...parameters: any[]) => {
      const statement = (prepare as any)(sql, ...parameters);
      if (!interleaved && sql.includes("name LIKE '%_fts'")) {
        const all = statement.all.bind(statement);
        statement.all = (...args: any[]) => {
          const snapshot = all(...args);
          interleaved = true;
          new SessionSearch(second);
          return snapshot;
        };
      }
      return statement;
    };
    const search = new SessionSearch(first);
    expect(interleaved).toBe(true);
    expect(() => first.run("INSERT INTO observations_fts(observations_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
    first.run("UPDATE observations SET title = 'concurrent updated marker'");
    expect(search.searchObservations('distinct observation', { project: 'fts-recovery' })).toEqual([]);
    expect(search.searchObservations('concurrent updated', { project: 'fts-recovery' })).toHaveLength(1);
    first.run('DELETE FROM observations');
    expect(search.searchObservations('concurrent updated', { project: 'fts-recovery' })).toEqual([]);
    expect(() => first.run("INSERT INTO observations_fts(observations_fts, rank) VALUES('integrity-check', 1)")).not.toThrow();
  });
});
