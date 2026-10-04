import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function seedDatabase(): Database {
  const db = new Database(':memory:');
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
