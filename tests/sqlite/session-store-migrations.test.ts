import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function seedLegacyContentHashScenario(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
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
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
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
      content_hash TEXT,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
    )
  `);

  const now = new Date().toISOString();
  const epoch = Date.now();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-a', 'session-a', 'legacy-project', now, epoch);
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-b', 'session-b', 'legacy-project', now, epoch + 1);

  db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, now);

  const insertObs = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `);
  insertObs.run('session-a', 'legacy-project', now, epoch, null);
  insertObs.run('session-a', 'legacy-project', now, epoch + 1, null);
  insertObs.run('session-a', 'legacy-project', now, epoch + 2, null);
  insertObs.run('session-b', 'legacy-project', now, epoch + 3, null);
  insertObs.run('session-b', 'legacy-project', now, epoch + 4, null);
  insertObs.run('session-a', 'legacy-project', now, epoch + 5, 'non-null-duplicate');
  insertObs.run('session-a', 'legacy-project', now, epoch + 6, 'non-null-duplicate');
}

describe('SessionStore migrations', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('preserves legacy NULL content_hash rows, dedupes non-NULL duplicates, and creates the UNIQUE index (v29)', () => {
    const db = new Database(':memory:');
    try {
      seedLegacyContentHashScenario(db);
      new SessionStore(db);

      const totals = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      expect(totals.count).toBe(6);

      const remainingNulls = db.prepare('SELECT COUNT(*) as count FROM observations WHERE content_hash IS NULL').get() as { count: number };
      expect(remainingNulls.count).toBe(0);

      const sessionANulls = db.prepare(`
        SELECT COUNT(*) as count FROM observations
         WHERE memory_session_id = 'session-a' AND content_hash GLOB '__null_migration_*__'
      `).get() as { count: number };
      expect(sessionANulls.count).toBe(3);

      const sessionBNulls = db.prepare(`
        SELECT COUNT(*) as count FROM observations
         WHERE memory_session_id = 'session-b' AND content_hash GLOB '__null_migration_*__'
      `).get() as { count: number };
      expect(sessionBNulls.count).toBe(2);

      const duplicateHashRows = db.prepare(`
        SELECT COUNT(*) as count FROM observations
         WHERE memory_session_id = 'session-a' AND content_hash = 'non-null-duplicate'
      `).get() as { count: number };
      expect(duplicateHashRows.count).toBe(1);

      const index = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_observations_session_hash'
      `).get() as { name: string } | undefined;
      expect(index?.name).toBe('ux_observations_session_hash');
    } finally {
      db.close();
    }
  });

  it('is idempotent: constructing twice over the same db does not throw and leaves data unchanged', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);
      const first = new SessionStore(db);
      first.createSDKSession('content-idem', 'project', 'prompt');

      const versionsBefore = db.prepare('SELECT COUNT(*) as n FROM schema_versions').get() as { n: number };

      expect(() => new SessionStore(db)).not.toThrow();

      const versionsAfter = db.prepare('SELECT COUNT(*) as n FROM schema_versions').get() as { n: number };
      const sessions = db.prepare('SELECT COUNT(*) as n FROM sdk_sessions').get() as { n: number };

      expect(versionsAfter.n).toBe(versionsBefore.n);
      expect(sessions.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('fresh-DB init creates the SessionStore core tables', () => {
    store = new SessionStore(':memory:');
    const expected = ['schema_versions', 'sdk_sessions', 'observations', 'session_summaries', 'user_prompts', 'pending_messages'];

    for (const table of expected) {
      const row = store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { name: string } | undefined;
      expect(row?.name).toBe(table);
    }
  });

  it('a fresh observations FK uses ON UPDATE CASCADE and ON DELETE CASCADE', () => {
    store = new SessionStore(':memory:');
    const fks = store.db.query('PRAGMA foreign_key_list(observations)').all() as Array<{ table: string; on_update: string; on_delete: string }>;
    const sessionFk = fks.find(fk => fk.table === 'sdk_sessions');
    expect(sessionFk?.on_update).toBe('CASCADE');
    expect(sessionFk?.on_delete).toBe('CASCADE');
  });

  it('drops the dead pending_messages columns (retry_count / failed_at_epoch / completed_at_epoch / worker_pid) on a legacy db', () => {
    const db = new Database(':memory:');
    try {
      db.run(`
        CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL)
      `);
      db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          retry_count INTEGER DEFAULT 0,
          failed_at_epoch INTEGER,
          completed_at_epoch INTEGER,
          worker_pid INTEGER
        )
      `);

      new SessionStore(db);

      const cols = new Set((db.query('PRAGMA table_info(pending_messages)').all() as Array<{ name: string }>).map(c => c.name));
      expect(cols.has('retry_count')).toBe(false);
      expect(cols.has('failed_at_epoch')).toBe(false);
      expect(cols.has('completed_at_epoch')).toBe(false);
      expect(cols.has('worker_pid')).toBe(false);
    } finally {
      db.close();
    }
  });
});
