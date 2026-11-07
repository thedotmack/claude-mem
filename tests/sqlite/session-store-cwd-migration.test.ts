// #2864: sdk_sessions.cwd is added by a PRAGMA-guarded migration. The guard
// makes it idempotent on its own, but the schema ledger is how this codebase
// records that a change was applied, so the version has to land too.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const SESSION_CWD_SCHEMA_VERSION = 53;

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function open(): { store: SessionStore; dbPath: string } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-cwd-migration-'));
  const dbPath = path.join(tempRoot, 'claude-mem.db');
  return { store: new SessionStore(dbPath), dbPath };
}

describe('sdk_sessions.cwd migration (#2864)', () => {
  it('records its schema version in the ledger', () => {
    const { store } = open();
    const row = store.db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(SESSION_CWD_SCHEMA_VERSION) as { version: number } | undefined;
    store.close();

    expect(row?.version).toBe(SESSION_CWD_SCHEMA_VERSION);
  });

  it('adds the column and index', () => {
    const { store } = open();
    const cols = store.db.prepare('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
    const idx = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sdk_sessions_cwd'")
      .get() as { name: string } | undefined;
    store.close();

    expect(cols.some(c => c.name === 'cwd')).toBe(true);
    expect(idx?.name).toBe('idx_sdk_sessions_cwd');
  });

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
      store.setSessionCwd(session.id, '/work/legacy-project');
      const stored = db.prepare('SELECT cwd FROM sdk_sessions WHERE id = ?').get(session.id) as { cwd: string };
      expect(stored.cwd).toBe('/work/legacy-project');
    } finally {
      db.close();
    }
  });

  it('reopens cleanly without duplicating the ledger entry', () => {
    const { store, dbPath } = open();
    store.close();
    const reopened = new SessionStore(dbPath);
    const count = (reopened.db
      .prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = ?')
      .get(SESSION_CWD_SCHEMA_VERSION) as { n: number }).n;
    reopened.close();

    expect(count).toBe(1);
  });
});
