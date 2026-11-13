import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { LATEST_SCHEMA_VERSION } from '../../src/services/sqlite/connection.js';
import { WAITING_FOR, type WaitingFor } from '../../src/services/work-view/waiting-for.mjs';

const summary = (waiting_for?: WaitingFor | null) => ({
  request: 'Ship the release cards', investigated: '', learned: '', completed: 'Built the cards', next_steps: '', notes: null,
  ...(waiting_for === undefined ? {} : { waiting_for }),
});

function session(store: SessionStore, memorySessionId: string): string {
  store.updateMemorySessionId(store.createSDKSession(`content-${memorySessionId}`, 'project', 'prompt'), memorySessionId);
  return memorySessionId;
}

const waitingFor = (store: SessionStore, id: number | null) =>
  (store.db.query('SELECT waiting_for FROM session_summaries WHERE id = ?').get(id) as { waiting_for: string | null }).waiting_for;

describe('what a summary says its turn waits for', () => {
  it('is added to a database created before the column, leaving old summaries null and the schema version alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-waiting-for-'));
    const path = join(dir, 'db.sqlite');
    let store = new SessionStore(path, { syncOpsEnabled: false });
    try {
      const old = store.storeSummary(session(store, 'mem-old'), 'project', summary()).id;
      store.db.run('ALTER TABLE session_summaries DROP COLUMN waiting_for');
      store.close();

      store = new SessionStore(path, { syncOpsEnabled: false });
      expect(waitingFor(store, old)).toBeNull();
      expect(store.getSummaryForSession('mem-old')?.completed).toBe('Built the cards');
      const added = store.storeSummary(session(store, 'mem-new'), 'project', summary('approval')).id;
      expect(waitingFor(store, added)).toBe('approval');
      const versions = store.db.query('SELECT MAX(version) AS version FROM schema_versions').get() as { version: number };
      expect(versions.version).toBe(LATEST_SCHEMA_VERSION);
      store.close();

      store = new SessionStore(path, { syncOpsEnabled: false });
      expect(waitingFor(store, added)).toBe('approval');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('round-trips every value through both store paths, and stores null when the summary did not say', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      for (const value of WAITING_FOR) {
        expect(waitingFor(store, store.storeSummary(session(store, `mem-a-${value}`), 'project', summary(value)).id)).toBe(value);
        expect(waitingFor(store, store.storeObservations(session(store, `mem-b-${value}`), 'project', [], summary(value), 1).summaryId)).toBe(value);
      }
      expect(waitingFor(store, store.storeSummary(session(store, 'mem-unsaid'), 'project', summary()).id)).toBeNull();
      expect(waitingFor(store, store.storeObservations(session(store, 'mem-null'), 'project', [], summary(null), 1).summaryId)).toBeNull();
    } finally { store.close(); }
  });

  it('a later stop in the same prompt replaces it, an unsaid value included', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const mem = session(store, 'mem-merge');
      const first = store.storeObservations(mem, 'project', [], summary('answer'), 3).summaryId;
      expect(store.storeObservations(mem, 'project', [], summary('nothing'), 3).summaryId).toBe(first);
      expect(waitingFor(store, first)).toBe('nothing');
      store.storeObservations(mem, 'project', [], summary(), 3);
      expect(waitingFor(store, first)).toBeNull();
    } finally { store.close(); }
  });

  it('survives the session_summaries rebuilds of an old database, value included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-waiting-for-'));
    const path = join(dir, 'db.sqlite');
    // A v4-era layout: the table-level UNIQUE constraint and the missing ON UPDATE CASCADE each make SessionStore
    // rebuild session_summaries from a fixed column list on open.
    const old = new Database(path);
    old.run('CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL)');
    old.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL, platform_source TEXT NOT NULL DEFAULT 'claude', user_prompt TEXT, started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL,
      completed_at TEXT, completed_at_epoch INTEGER, status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active')`);
    old.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL, text TEXT NOT NULL,
      type TEXT NOT NULL, discovery_tokens INTEGER DEFAULT 0, created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE)`);
    old.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT UNIQUE NOT NULL, project TEXT NOT NULL,
      request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, files_read TEXT, files_edited TEXT, notes TEXT, waiting_for TEXT,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE)`);
    old.run("INSERT INTO schema_versions (version, applied_at) VALUES (4, '2025-07-01T00:00:00.000Z')");
    old.run(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('content-old', 'mem-old', 'project', '2025-07-01T00:00:00.000Z', 1751328000000, 'completed')`);
    old.run(`INSERT INTO session_summaries (memory_session_id, project, request, waiting_for, created_at, created_at_epoch)
      VALUES ('mem-old', 'project', 'Ship the release cards', 'review', '2025-07-01T00:00:00.000Z', 1751328000000)`);
    old.close();

    const store = new SessionStore(path, { syncOpsEnabled: false });
    try {
      const table = (store.db.query("SELECT sql FROM sqlite_master WHERE name = 'session_summaries'").get() as { sql: string }).sql;
      expect(table).not.toContain('UNIQUE');
      expect(table).toContain('ON UPDATE CASCADE');
      expect(store.db.query("SELECT waiting_for FROM session_summaries WHERE memory_session_id = 'mem-old'").get()).toEqual({ waiting_for: 'review' });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
