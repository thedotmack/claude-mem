import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('sdk_sessions.cwd migration (#2864)', () => {
  // v33 rebuilds sdk_sessions from a fixed column list when the table still has
  // the old global UNIQUE(content_session_id). A cwd column added before that
  // rebuild is silently dropped, and every later ingest then fails on
  // setSessionCwd — so the column has to survive a direct pre-v33 upgrade.
  it('survives the v33 sdk_sessions rebuild when upgrading a pre-v33 database', () => {
    const db = new Database(':memory:');
    try {
      db.run('CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL)');
      db.run(`
        CREATE TABLE sdk_sessions (
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
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
        VALUES ('legacy-content', 'legacy-memory', 'legacy-project', ?, ?)
      `).run(new Date().toISOString(), Date.now());

      const store = new SessionStore(db);
      const cols = db.prepare('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
      expect(cols.some(c => c.name === 'cwd')).toBe(true);

      const session = db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = 'legacy-content'").get() as { id: number };
      store.setSessionCwd(session.id, '/work/legacy-project', 'path');
      const stored = db.prepare('SELECT cwd, project_key_source FROM sdk_sessions WHERE id = ?').get(session.id) as { cwd: string; project_key_source: string };
      expect(stored).toEqual({ cwd: '/work/legacy-project', project_key_source: 'path' });
    } finally {
      db.close();
    }
  });
});
