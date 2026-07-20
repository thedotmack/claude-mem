import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_JOURNAL_SIZE_LIMIT_BYTES } from '../../src/services/sqlite/connection.js';

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

const REVISION_COLUMNS = [
  { table: 'observations', column: 'sync_rev' },
  { table: 'session_summaries', column: 'sync_rev' },
  { table: 'user_prompts', column: 'sync_rev' },
  { table: 'sync_outbox', column: 'rev' },
] as const;

function replaceRevisionColumnAffinity(
  db: Database,
  table: (typeof REVISION_COLUMNS)[number]['table'],
  column: (typeof REVISION_COLUMNS)[number]['column'],
  affinity: 'INTEGER' | 'TEXT',
): void {
  const temporary = `${column}_test_affinity`;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${temporary} ${affinity} NOT NULL DEFAULT 1`);
  db.run(`UPDATE ${table} SET ${temporary} = ${column}`);
  db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.run(`ALTER TABLE ${table} RENAME COLUMN ${temporary} TO ${column}`);
}

function revisionColumnInfo(
  db: Database,
  table: (typeof REVISION_COLUMNS)[number]['table'],
  column: (typeof REVISION_COLUMNS)[number]['column'],
): { name: string; type: string; notnull: number; dflt_value: string | null } {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>).find(info => info.name === column)!;
}

function insertSchemaVersions(db: Database, throughVersion: number): void {
  const now = new Date().toISOString();
  for (let version = 4; version <= throughVersion; version++) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, now);
  }
}

function seedHistoricalSdkSchema(
  db: Database,
  throughVersion: number,
  options: { customTitle?: boolean; platformSource?: boolean; deadPendingColumns?: boolean } = {},
): void {
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
      ${options.platformSource ? "platform_source TEXT NOT NULL DEFAULT 'claude'," : ''}
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0
      ${options.customTitle ? ', custom_title TEXT' : ''}
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
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
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
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
    )
  `);

  if (throughVersion >= 10) {
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
  }

  if (throughVersion >= 16) {
    db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL
        ${options.deadPendingColumns ? ', retry_count INTEGER DEFAULT 0, failed_at_epoch INTEGER, completed_at_epoch INTEGER' : ''},
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
  }

  insertSchemaVersions(db, throughVersion);

  db.prepare(`
    INSERT INTO sdk_sessions (
      id, content_session_id, memory_session_id, project,
      ${options.platformSource ? 'platform_source,' : ''}
      user_prompt, started_at, started_at_epoch, status
    ) VALUES (?, ?, ?, ?, ${options.platformSource ? '?, ' : ''}?, ?, ?, 'active')
  `).run(
    7,
    'historical-content',
    'historical-memory',
    'historical-project',
    ...(options.platformSource ? [''] : []),
    'historical prompt',
    now,
    epoch,
  );

  db.prepare(`
    INSERT INTO observations (
      memory_session_id, project, text, type, content_hash, created_at, created_at_epoch
    ) VALUES (?, ?, ?, 'discovery', ?, ?, ?)
  `).run('historical-memory', 'historical-project', 'historical observation', 'historical-hash', now, epoch + 1);

  if (throughVersion >= 10) {
    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 1, ?, ?, ?)
    `).run('historical-content', 'historical user prompt', now, epoch + 2);
  }

  if (throughVersion >= 16) {
    db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type, status, created_at_epoch
      ) VALUES (?, ?, 'observation', 'pending', ?)
    `).run(7, 'historical-content', epoch + 3);
  }
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

  it('v41 unique origin index does not retrigger the v7 session_summaries rebuild (which would destroy sync metadata)', () => {
    // Regression guard for the v7 predicate (removeSessionSummariesUniqueConstraint):
    // it must only match table-level UNIQUE constraints (PRAGMA origin 'u'),
    // never explicitly created unique indexes (origin 'c') like v41's
    // ux_session_summaries_origin. With the old `origin !== 'pk'` predicate,
    // every constructor run after v41 rebuilt session_summaries with the
    // v7-era column list, silently NULLing synced_at / origin_device_id /
    // origin_local_id and resetting sync_rev — this test fails loudly if
    // anyone reverts the predicate.
    const db = new Database(':memory:');
    try {
      new SessionStore(db);

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('content-v7', 'mem-v7', 'proj-v7', ?, 1751234567000, 'active')
      `).run(new Date().toISOString());
      db.prepare(`
        INSERT INTO session_summaries
          (memory_session_id, project, request, created_at, created_at_epoch,
           synced_at, origin_device_id, origin_local_id, sync_rev)
        VALUES ('mem-v7', 'proj-v7', 'req', ?, 1751234567890, 123456, 'device-a', '7', 2)
      `).run(new Date().toISOString());

      // A second construction over the fully migrated DB must be a no-op for
      // session_summaries.
      new SessionStore(db);

      const row = db.prepare(`
        SELECT synced_at, origin_device_id, origin_local_id, sync_rev
        FROM session_summaries WHERE memory_session_id = 'mem-v7'
      `).get() as { synced_at: number | null; origin_device_id: string | null; origin_local_id: string | null; sync_rev: string };
      expect(row.synced_at).toBe(123456);
      expect(row.origin_device_id).toBe('device-a');
      expect(row.origin_local_id).toBe('7');
      expect(row.sync_rev).toBe('2');

      const index = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_session_summaries_origin'
      `).get() as { name: string } | undefined;
      expect(index?.name).toBe('ux_session_summaries_origin');
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

  it('v46 gives all fresh content and mutation revisions TEXT affinity', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);

      for (const target of REVISION_COLUMNS) {
        const column = revisionColumnInfo(db, target.table, target.column);
        expect(column.type).toBe('TEXT');
        expect(column.notnull).toBe(1);
        expect(column.dflt_value).toBe("'1'");
      }
      expect(db.prepare('SELECT version FROM schema_versions WHERE version = 46').get()).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('v46 upgrades INTEGER-affinity revisions atomically and idempotently without changing indexes or foreign keys', () => {
    const db = new Database(':memory:');
    const signedInt64Max = '9223372036854775807';
    try {
      new SessionStore(db);
      for (const target of REVISION_COLUMNS) {
        replaceRevisionColumnAffinity(db, target.table, target.column, 'INTEGER');
        expect(revisionColumnInfo(db, target.table, target.column).type).toBe('INTEGER');
      }
      db.prepare('DELETE FROM schema_versions WHERE version = 46').run();

      db.prepare(`
        INSERT INTO sdk_sessions
          (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('v46-content', 'v46-memory', 'v46-project', ?, 1751234567000, 'active')
      `).run(new Date().toISOString());
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, content_hash, created_at, created_at_epoch, sync_rev)
        VALUES ('v46-memory', 'v46-project', 'discovery', 'v46 observation', 'v46-hash', ?, 1751234567001, ?)
      `).run(new Date().toISOString(), signedInt64Max);
      db.prepare(`
        INSERT INTO session_summaries
          (memory_session_id, project, request, created_at, created_at_epoch, sync_rev)
        VALUES ('v46-memory', 'v46-project', 'v46 summary', ?, 1751234567002, ?)
      `).run(new Date().toISOString(), signedInt64Max);
      db.prepare(`
        INSERT INTO user_prompts
          (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, sync_rev)
        VALUES (1, 'v46-content', 1, 'v46 prompt', ?, 1751234567003, ?)
      `).run(new Date().toISOString(), signedInt64Max);
      db.prepare(`
        INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
        VALUES ('00000000-0000-4000-8000-000000000046', ?, '{}', 1751234567004)
      `).run(signedInt64Max);

      for (const target of REVISION_COLUMNS) {
        expect(db.prepare(`SELECT typeof(${target.column}) AS storage_type FROM ${target.table}`).get())
          .toEqual({ storage_type: 'integer' });
      }
      const schemaObjectsBefore = db.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE tbl_name IN ('observations', 'session_summaries', 'user_prompts', 'sync_outbox')
          AND type IN ('index', 'trigger')
        ORDER BY type, name
      `).all();
      const foreignKeysBefore = ['observations', 'session_summaries', 'user_prompts']
        .map(table => [table, db.query(`PRAGMA foreign_key_list(${table})`).all()]);

      new SessionStore(db);

      for (const target of REVISION_COLUMNS) {
        expect(revisionColumnInfo(db, target.table, target.column).type).toBe('TEXT');
        expect(db.prepare(`
          SELECT ${target.column} AS revision, typeof(${target.column}) AS storage_type
          FROM ${target.table}
        `).get()).toEqual({ revision: signedInt64Max, storage_type: 'text' });
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = 46').get())
        .toEqual({ n: 1 });
      expect(db.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE tbl_name IN ('observations', 'session_summaries', 'user_prompts', 'sync_outbox')
          AND type IN ('index', 'trigger')
        ORDER BY type, name
      `).all()).toEqual(schemaObjectsBefore);
      expect(['observations', 'session_summaries', 'user_prompts']
        .map(table => [table, db.query(`PRAGMA foreign_key_list(${table})`).all()]))
        .toEqual(foreignKeysBefore);

      expect(() => new SessionStore(db)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).toEqual({ n: 1 });
      for (const target of REVISION_COLUMNS) {
        expect(db.query(`PRAGMA table_info(${target.table})`).all()
          .filter((info: any) => info.name === target.column || info.name.endsWith('_v46')).length).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('v46 refuses an already-rounded REAL revision and rolls the schema transaction back', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);
      replaceRevisionColumnAffinity(db, 'observations', 'sync_rev', 'INTEGER');
      db.prepare('DELETE FROM schema_versions WHERE version = 46').run();
      db.prepare(`
        INSERT INTO sdk_sessions
          (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('v46-real-content', 'v46-real-memory', 'v46-project', ?, 1751234567000, 'active')
      `).run(new Date().toISOString());
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, content_hash, created_at, created_at_epoch, sync_rev)
        VALUES ('v46-real-memory', 'v46-project', 'discovery', 'rounded', 'v46-real-hash', ?, 1751234567001, ?)
      `).run(new Date().toISOString(), '18446744073709551615');
      expect(db.prepare('SELECT typeof(sync_rev) AS storage_type FROM observations').get())
        .toEqual({ storage_type: 'real' });

      expect(() => new SessionStore(db)).toThrow(/observations\.sync_rev row 1 is REAL and unrecoverably rounded/);
      expect(revisionColumnInfo(db, 'observations', 'sync_rev').type).toBe('INTEGER');
      expect(db.prepare('SELECT version FROM schema_versions WHERE version = 46').get()).toBeNull();
      expect(db.query('PRAGMA table_info(observations)').all()
        .some((info: any) => info.name === 'sync_rev_text_v46')).toBe(false);
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

  it('applies required SQLite pragmas to injected worker and search connections', () => {
    const db = new Database(':memory:');
    try {
      db.run('PRAGMA busy_timeout = 0');
      db.run('PRAGMA foreign_keys = OFF');

      new SessionStore(db);

      expect((db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
      expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
      expect((db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1);
      expect((db.query('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit)
        .toBe(SQLITE_JOURNAL_SIZE_LIMIT_BYTES);
      expect((db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2);

      db.run('PRAGMA busy_timeout = 0');
      db.run('PRAGMA foreign_keys = OFF');
      new SessionSearch(db);

      expect((db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
      expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    } finally {
      db.close();
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

  it('directly upgrades a v23-era schema before platform_source existed', () => {
    const db = new Database(':memory:');
    try {
      seedHistoricalSdkSchema(db, 23, { customTitle: true, platformSource: false });

      new SessionStore(db);

      const sessionCols = new Set((db.query('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>).map(col => col.name));
      expect(sessionCols.has('custom_title')).toBe(true);
      expect(sessionCols.has('platform_source')).toBe(true);

      const session = db.prepare('SELECT platform_source FROM sdk_sessions WHERE id = 7').get() as { platform_source: string };
      expect(session.platform_source).toBe('claude');
      expect(hasUniqueIndexOnColumns(db, 'sdk_sessions', ['platform_source', 'content_session_id'])).toBe(true);
    } finally {
      db.close();
    }
  });

  it('directly upgrades a v24-era schema with old global content-session uniqueness', () => {
    const db = new Database(':memory:');
    try {
      seedHistoricalSdkSchema(db, 24, { customTitle: true, platformSource: true });

      new SessionStore(db);

      expect(hasUniqueIndexOnColumns(db, 'sdk_sessions', ['content_session_id'])).toBe(false);
      expect(hasUniqueIndexOnColumns(db, 'sdk_sessions', ['platform_source', 'content_session_id'])).toBe(true);
      expect((db.prepare('SELECT session_db_id FROM user_prompts WHERE content_session_id = ?').get('historical-content') as { session_db_id: number }).session_db_id).toBe(7);
      expect((db.prepare('SELECT session_db_id FROM pending_messages WHERE content_session_id = ?').get('historical-content') as { session_db_id: number }).session_db_id).toBe(7);
    } finally {
      db.close();
    }
  });

  it('directly upgrades a v31-era schema with dead pending columns and old tool indexes', () => {
    const db = new Database(':memory:');
    try {
      seedHistoricalSdkSchema(db, 31, { customTitle: true, platformSource: true, deadPendingColumns: true });

      new SessionStore(db);

      const pendingCols = new Set((db.query('PRAGMA table_info(pending_messages)').all() as Array<{ name: string }>).map(col => col.name));
      expect(pendingCols.has('retry_count')).toBe(false);
      expect(pendingCols.has('failed_at_epoch')).toBe(false);
      expect(pendingCols.has('completed_at_epoch')).toBe(false);
      expect(pendingCols.has('tool_use_id')).toBe(true);
      expect(hasUniqueIndexOnColumns(db, 'pending_messages', ['session_db_id', 'tool_use_id'])).toBe(true);
    } finally {
      db.close();
    }
  });

  it('repairs missing v35-era invariants even when version rows already exist', () => {
    const db = new Database(':memory:');
    try {
      seedHistoricalSdkSchema(db, 35, { customTitle: false, platformSource: false });

      new SessionStore(db);

      const sessionCols = new Set((db.query('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>).map(col => col.name));
      expect(sessionCols.has('custom_title')).toBe(true);
      expect(sessionCols.has('platform_source')).toBe(true);
      expect(hasUniqueIndexOnColumns(db, 'sdk_sessions', ['platform_source', 'content_session_id'])).toBe(true);
      expect(hasUniqueIndexOnColumns(db, 'pending_messages', ['session_db_id', 'tool_use_id'])).toBe(true);
    } finally {
      db.close();
    }
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
