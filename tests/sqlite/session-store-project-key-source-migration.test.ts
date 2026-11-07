// Gate P1-2: sdk_sessions.project_key_source records how a session's project
// key was derived (folder path, git-remote slug, environment), beside its
// recorded checkout, so worktree adoption can tell a deleted worktree from a
// deleted clone of a slug-named repository.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const PROJECT_KEY_SOURCE_SCHEMA_VERSION = 59;

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function open(): { store: SessionStore; dbPath: string } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-key-source-migration-'));
  const dbPath = path.join(tempRoot, 'claude-mem.db');
  return { store: new SessionStore(dbPath), dbPath };
}

describe('sdk_sessions.project_key_source migration (gate P1-2)', () => {
  it('adds the column and records its schema version once', () => {
    const { store, dbPath } = open();
    const cols = store.db.prepare('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
    store.close();
    expect(cols.some(c => c.name === 'project_key_source')).toBe(true);

    const reopened = new SessionStore(dbPath);
    const count = (reopened.db
      .prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = ?')
      .get(PROJECT_KEY_SOURCE_SCHEMA_VERSION) as { n: number }).n;
    reopened.close();
    expect(count).toBe(1);
  });

  it('records the key source with the checkout, first write wins for both', () => {
    const { store } = open();
    const sessionDbId = store.createSDKSession('content-a', 'acme/api', 'prompt');
    store.setSessionCwd(sessionDbId, '/work/api', 'git-remote');
    store.setSessionCwd(sessionDbId, '/work/api/sub', 'path');
    const row = store.db
      .prepare('SELECT cwd, project_key_source FROM sdk_sessions WHERE id = ?')
      .get(sessionDbId) as { cwd: string; project_key_source: string | null };
    store.close();
    expect(row).toEqual({ cwd: '/work/api', project_key_source: 'git-remote' });
  });

  // v33 rebuilds sdk_sessions from a fixed column list; a column added before
  // that rebuild would be dropped on a direct pre-v33 upgrade.
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
      const session = db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = 'legacy-content'").get() as { id: number };
      store.setSessionCwd(session.id, '/work/legacy-project', 'path');
      const stored = db.prepare('SELECT project_key_source FROM sdk_sessions WHERE id = ?').get(session.id) as { project_key_source: string };
      expect(stored.project_key_source).toBe('path');
    } finally {
      db.close();
    }
  });
});
