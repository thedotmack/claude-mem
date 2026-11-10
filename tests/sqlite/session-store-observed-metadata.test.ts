import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

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

  describe('setSessionObservedMetadata', () => {
    it('stores both fields and getSessionById returns them', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-observed', 'project', 'prompt');

      store.setSessionObservedMetadata(id, 'claude-x', 'max');

      const session = store.getSessionById(id);
      expect(session?.observed_model).toBe('claude-x');
      expect(session?.observed_billing).toBe('max');
    });

    it.each([
      [undefined, 'pro', 'claude-x', 'pro'],
      ['claude-y', undefined, 'claude-y', 'max'],
      ['', 'pro', 'claude-x', 'pro'],
    ] as const)('preserves omitted metadata for model=%s billing=%s', (model, billing, expectedModel, expectedBilling) => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.createSDKSession('content-coalesce', 'project', 'prompt');
      store.setSessionObservedMetadata(id, 'claude-x', 'max');
      store.setSessionObservedMetadata(id, model, billing);
      const session = store.getSessionById(id);
      expect(session?.observed_model).toBe(expectedModel);
      expect(session?.observed_billing).toBe(expectedBilling);
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

  });
});
