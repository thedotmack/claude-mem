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

function getIndexColumns(db: Database, indexName: string): string[] {
  return (db.query(`PRAGMA index_info(${JSON.stringify(indexName)})`).all() as Array<{ name: string }>).map(col => col.name);
}

function hasUniqueIndexOnColumns(db: Database, table: string, columns: string[]): boolean {
  const indexes = db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  return indexes.some(index => {
    if (index.unique !== 1) return false;
    const indexColumns = getIndexColumns(db, index.name);
    return indexColumns.length === columns.length
      && indexColumns.every((column, i) => column === columns[i]);
  });
}

function seedLegacyGlobalContentIdentityScenario(db: Database): void {
  const now = new Date().toISOString();
  const epoch = Date.now();

  db.run(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

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
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT
    )
  `);

  db.run(`
    CREATE TABLE observations (
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
      content_hash TEXT,
      agent_type TEXT,
      agent_id TEXT,
      merged_into_project TEXT,
      generated_by_model TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      merged_into_project TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      tool_use_id TEXT,
      message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
      created_at_epoch INTEGER NOT NULL,
      agent_type TEXT,
      agent_id TEXT,
      FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE UNIQUE INDEX ux_pending_session_tool
    ON pending_messages(content_session_id, tool_use_id)
    WHERE tool_use_id IS NOT NULL
  `);

  for (let version = 4; version <= 32; version++) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, now);
  }

  db.prepare(`
    INSERT INTO sdk_sessions (
      id, content_session_id, memory_session_id, project, platform_source,
      user_prompt, started_at, started_at_epoch, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(101, 'shared-raw-id', 'memory-legacy', 'legacy-project', '', 'legacy prompt', now, epoch);

  db.prepare(`
    INSERT INTO observations (
      memory_session_id, project, text, type, title, narrative,
      content_hash, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('memory-legacy', 'legacy-project', null, 'discovery', 'legacy observation', 'kept', 'legacy-hash', now, epoch + 1);

  db.prepare(`
    INSERT INTO session_summaries (
      memory_session_id, project, request, completed, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('memory-legacy', 'legacy-project', 'legacy request', 'done', now, epoch + 2);

  db.prepare(`
    INSERT INTO user_prompts (
      content_session_id, prompt_number, prompt_text, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?)
  `).run('shared-raw-id', 1, 'legacy user prompt', now, epoch + 3);

  db.prepare(`
    INSERT INTO pending_messages (
      session_db_id, content_session_id, tool_use_id, message_type,
      tool_name, status, created_at_epoch
    ) VALUES (?, ?, ?, 'observation', 'Read', 'pending', ?)
  `).run(101, 'shared-raw-id', 'tool-1', epoch + 4);
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

  it('fresh DB uses composite sdk session identity and session-scoped prompt/pending indexes', () => {
    store = new SessionStore(':memory:');

    expect(hasUniqueIndexOnColumns(store.db, 'sdk_sessions', ['content_session_id'])).toBe(false);
    expect(hasUniqueIndexOnColumns(store.db, 'sdk_sessions', ['platform_source', 'content_session_id'])).toBe(true);
    expect(hasUniqueIndexOnColumns(store.db, 'pending_messages', ['session_db_id', 'tool_use_id'])).toBe(true);

    const promptCols = new Set((store.db.query('PRAGMA table_info(user_prompts)').all() as Array<{ name: string }>).map(col => col.name));
    expect(promptCols.has('session_db_id')).toBe(true);

    const promptFks = store.db.query('PRAGMA foreign_key_list(user_prompts)').all() as Array<{ table: string; from: string; to: string }>;
    expect(promptFks.some(fk => fk.table === 'sdk_sessions' && fk.from === 'session_db_id' && fk.to === 'id')).toBe(true);
    expect(promptFks.some(fk => fk.table === 'sdk_sessions' && fk.from === 'content_session_id')).toBe(false);
  });

  it('migrates a single-platform DB without losing observations, summaries, prompts, or pending rows', () => {
    const db = new Database(':memory:');
    try {
      seedLegacyGlobalContentIdentityScenario(db);

      const migrated = new SessionStore(db);

      const legacySession = db.prepare(`
        SELECT id, platform_source
        FROM sdk_sessions
        WHERE content_session_id = 'shared-raw-id' AND platform_source = 'claude'
      `).get() as { id: number; platform_source: string } | undefined;
      expect(legacySession?.id).toBe(101);
      expect(legacySession?.platform_source).toBe('claude');

      expect(hasUniqueIndexOnColumns(db, 'sdk_sessions', ['content_session_id'])).toBe(false);
      expect(hasUniqueIndexOnColumns(db, 'sdk_sessions', ['platform_source', 'content_session_id'])).toBe(true);
      expect(hasUniqueIndexOnColumns(db, 'pending_messages', ['session_db_id', 'tool_use_id'])).toBe(true);

      expect((db.prepare("SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = 'memory-legacy'").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = 'memory-legacy'").get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT session_db_id FROM user_prompts WHERE content_session_id = ?').get('shared-raw-id') as { session_db_id: number }).session_db_id).toBe(101);
      expect((db.prepare('SELECT session_db_id FROM pending_messages WHERE content_session_id = ?').get('shared-raw-id') as { session_db_id: number }).session_db_id).toBe(101);

      const cursorId = migrated.createSDKSession('shared-raw-id', 'cursor-project', 'cursor prompt', undefined, 'cursor');
      expect(cursorId).not.toBe(101);

      expect(migrated.getPromptNumberFromUserPrompts('shared-raw-id', 101)).toBe(1);
      expect(migrated.getPromptNumberFromUserPrompts('shared-raw-id', cursorId)).toBe(0);

      migrated.saveUserPrompt('shared-raw-id', 1, 'cursor user prompt', cursorId);
      expect(migrated.getPromptNumberFromUserPrompts('shared-raw-id', 101)).toBe(1);
      expect(migrated.getPromptNumberFromUserPrompts('shared-raw-id', cursorId)).toBe(1);

      db.prepare(`
        INSERT INTO pending_messages (
          session_db_id, content_session_id, tool_use_id, message_type, status, created_at_epoch
        ) VALUES (?, ?, ?, 'observation', 'pending', ?)
      `).run(cursorId, 'shared-raw-id', 'tool-1', Date.now());

      expect((db.prepare("SELECT COUNT(*) AS n FROM pending_messages WHERE content_session_id = 'shared-raw-id'").get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
    }
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
