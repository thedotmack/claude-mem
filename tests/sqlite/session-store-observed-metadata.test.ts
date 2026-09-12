import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

interface TableColumnInfo {
  name: string;
}

function sdkSessionColumns(db: Database): string[] {
  return (db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[]).map(col => col.name);
}

/**
 * Seed a pre-v50 database: sdk_sessions without the observed_* columns and a
 * schema_versions table without the v50 stamp. The rest of the constructor
 * chain fills in what it needs.
 */
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

describe('SessionStore observed session metadata', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  describe('fresh database', () => {
    it('creates sdk_sessions with observed_model and observed_billing columns', () => {
      store = new SessionStore(new Database(':memory:'));

      const columns = sdkSessionColumns(store.db);
      expect(columns).toContain('observed_model');
      expect(columns).toContain('observed_billing');
    });

    it('returns null observed fields for a session that never reported them', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-unreported', 'project', 'prompt');

      const session = store.getSessionById(id);
      expect(session?.observed_model).toBeNull();
      expect(session?.observed_billing).toBeNull();
    });
  });

  describe('setSessionObservedMetadata', () => {
    it('stores both fields and getSessionById returns them', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-observed', 'project', 'prompt');

      store.setSessionObservedMetadata(id, 'claude-x', 'max');

      const session = store.getSessionById(id);
      expect(session?.observed_model).toBe('claude-x');
      expect(session?.observed_billing).toBe('max');
    });

    it('keeps the previous model when a later call omits it (COALESCE)', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-coalesce-model', 'project', 'prompt');

      store.setSessionObservedMetadata(id, 'claude-x', 'max');
      store.setSessionObservedMetadata(id, undefined, 'pro');

      const session = store.getSessionById(id);
      expect(session?.observed_model).toBe('claude-x');
      expect(session?.observed_billing).toBe('pro');
    });

    it('keeps the previous billing when a later call omits it (COALESCE)', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-coalesce-billing', 'project', 'prompt');

      store.setSessionObservedMetadata(id, 'claude-x', 'max');
      store.setSessionObservedMetadata(id, 'claude-y', undefined);

      const session = store.getSessionById(id);
      expect(session?.observed_model).toBe('claude-y');
      expect(session?.observed_billing).toBe('max');
    });

    it('keeps the previous model when a later call passes an empty string', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-empty-model', 'project', 'prompt');

      store.setSessionObservedMetadata(id, 'claude-x', 'max');
      store.setSessionObservedMetadata(id, '', 'pro');

      const session = store.getSessionById(id);
      expect(session?.observed_model).toBe('claude-x');
      expect(session?.observed_billing).toBe('pro');
    });

    it('overwrites the model when a later turn reports a different one', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-switch', 'project', 'prompt');

      store.setSessionObservedMetadata(id, 'claude-x', 'max');
      store.setSessionObservedMetadata(id, 'claude-y', 'max');

      expect(store.getSessionById(id)?.observed_model).toBe('claude-y');
    });

    it('does not touch other sessions', () => {
      store = new SessionStore(new Database(':memory:'));
      const a = store.createSDKSession('content-a', 'project', 'prompt');
      const b = store.createSDKSession('content-b', 'project', 'prompt');

      store.setSessionObservedMetadata(a, 'claude-x', 'max');

      expect(store.getSessionById(b)?.observed_model).toBeNull();
      expect(store.getSessionById(b)?.observed_billing).toBeNull();
    });
  });

  describe('migration v50 (legacy sdk_sessions without observed columns)', () => {
    it('adds both columns and stamps schema version 50', () => {
      const db = new Database(':memory:');
      seedLegacySdkSessions(db);
      expect(sdkSessionColumns(db)).not.toContain('observed_model');
      expect(sdkSessionColumns(db)).not.toContain('observed_billing');

      store = new SessionStore(db);

      const columns = sdkSessionColumns(db);
      expect(columns).toContain('observed_model');
      expect(columns).toContain('observed_billing');

      const stamp = db.prepare('SELECT version FROM schema_versions WHERE version = 50').get() as { version: number } | null;
      expect(stamp?.version).toBe(50);
    });

    it('preserves the legacy row and reads it back with null observed fields', () => {
      const db = new Database(':memory:');
      seedLegacySdkSessions(db);

      store = new SessionStore(db);

      const legacy = db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = 'legacy-content'").get() as { id: number };
      const session = store.getSessionById(legacy.id);
      expect(session?.project).toBe('legacy-project');
      expect(session?.observed_model).toBeNull();
      expect(session?.observed_billing).toBeNull();
    });

    it('is idempotent when re-run against an already-migrated database', () => {
      const db = new Database(':memory:');
      seedLegacySdkSessions(db);

      store = new SessionStore(db);
      const versionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM schema_versions').get() as { n: number }).n;

      // Constructing a second store over the same connection replays the
      // whole migration chain; the observed-columns step must be a no-op.
      const again = new SessionStore(db);
      const versionsAfter = (db.prepare('SELECT COUNT(*) AS n FROM schema_versions').get() as { n: number }).n;

      expect(versionsAfter).toBe(versionsBefore);
      expect(sdkSessionColumns(db).filter(name => name === 'observed_model')).toHaveLength(1);
      expect(again.getSessionById(1)?.observed_model).toBeNull();
    });
  });
});
