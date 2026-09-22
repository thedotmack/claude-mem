import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

interface TableColumnInfo {
  name: string;
}

function sdkSessionColumns(db: Database): string[] {
  return (db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[]).map(col => col.name);
}

function seedLegacySdkSessions(db: Database): void {
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

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'completed')
  `).run('legacy-content', 'legacy-memory', 'legacy-project', now, Date.now());
}

describe('SessionStore sdk_sessions session_kind', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('creates sdk_sessions with the session_kind column on a fresh database', () => {
    store = new SessionStore(new Database(':memory:'));

    const columns = sdkSessionColumns(store.db);
    expect(columns).toContain('session_kind');
  });

  it('migrates a legacy sdk_sessions table by adding session_kind and stamping schema version 53', () => {
    const db = new Database(':memory:');
    seedLegacySdkSessions(db);
    expect(sdkSessionColumns(db)).not.toContain('session_kind');

    store = new SessionStore(db);

    const columns = sdkSessionColumns(db);
    expect(columns).toContain('session_kind');
    const stamp = db.prepare('SELECT version FROM schema_versions WHERE version = 53').get() as { version: number } | null;
    expect(stamp?.version).toBe(53);

    const legacy = db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = 'legacy-content'").get() as { id: number };
    expect(store.getSessionById(legacy.id)?.session_kind).toBe('user');
  });
});
