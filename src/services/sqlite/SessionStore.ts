import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { DATA_DIR, DB_PATH, ensureDir, OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from './types.js';
import { computeObservationContentHash } from './observations/store.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
import { findRecentDuplicateUserPrompt as findRecentDuplicateUserPromptRecord } from './prompts/get.js';
import { normalizeStoredPromptText } from './prompt-storage.js';
import { applySqliteConnectionPragmas } from './connection.js';
import {
  assertCanonicalDecimal,
  incrementCanonicalDecimal,
  validateCanonicalMutation,
  type CanonicalMutation,
} from '../sync/CanonicalContent.js';

interface IndexColumnInfo {
  seqno: number;
  cid: number;
  name: string;
}

interface RecentSessionStatusRow {
  memory_session_id: string | null;
  status: string;
  started_at: string;
  user_prompt: string | null;
  has_summary: boolean;
}

interface SessionObservationRow {
  title: string;
  subtitle: string;
  type: string;
  prompt_number: number | null;
}

interface SummaryDetailRow {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

interface SdkSessionDetailRow {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  platform_source: string;
  user_prompt: string;
  custom_title: string | null;
  status: string;
}

export class SessionStore {
  public db: Database;

  constructor(dbPathOrDb: string | Database = DB_PATH) {
    if (dbPathOrDb instanceof Database) {
      this.db = dbPathOrDb;
    } else {
      if (dbPathOrDb !== ':memory:') {
        ensureDir(DATA_DIR);
      }
      this.db = new Database(dbPathOrDb);
    }

    applySqliteConnectionPragmas(this.db);

    this.initializeSchema();

    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.renameSessionIdColumns();
    this.addFailedAtEpochColumn();
    this.addOnUpdateCascadeToForeignKeys();
    this.addObservationContentHashColumn();
    this.addSessionCustomTitleColumn();
    this.addSessionPlatformSourceColumn();
    this.addObservationModelColumns();
    this.ensureMergedIntoProjectColumns();
    this.addObservationSubagentColumns();
    this.addObservationsUniqueContentHashIndex();
    this.addObservationsMetadataColumn();
    this.dropDeadPendingMessagesColumns();
    this.ensurePendingMessagesToolUseIdColumn();
    this.dropWorkerPidColumn();
    this.ensureSDKSessionsPlatformContentIdentity();
    this.ensureUserPromptsSessionDbId();
    this.ensurePendingMessagesSessionToolUniqueIndex();
    this.ensureSyncedAtColumns();
    this.ensureSyncOriginColumns();
    this.ensureSyncOutbox();
    this.ensureSyncEntityLedger();
    this.ensureSyncRevisionTextAffinity();
    this.initializeSyncHubLaunchBaseline();
    this.normalizeConceptTags();
  }

  private getIndexColumns(indexName: string): string[] {
    return (this.db.query(`PRAGMA index_info(${JSON.stringify(indexName)})`).all() as IndexColumnInfo[])
      .map(col => col.name);
  }

  private hasUniqueIndexOnColumns(table: string, columns: string[]): boolean {
    const indexes = this.db.query(`PRAGMA index_list(${table})`).all() as IndexInfo[];
    return indexes.some(index => {
      if (index.unique !== 1) return false;
      const indexColumns = this.getIndexColumns(index.name);
      return indexColumns.length === columns.length
        && indexColumns.every((column, i) => column === columns[i]);
    });
  }

  private resolvePromptSessionDbId(contentSessionId: string, sessionDbId?: number, platformSource?: string): number | null {
    if (sessionDbId !== undefined) return sessionDbId;

    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    if (normalizedPlatformSource) {
      const row = this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource, contentSessionId) as { id: number } | undefined;

      return row?.id ?? null;
    }

    const row = this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')
        WHEN '${DEFAULT_PLATFORM_SOURCE}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(contentSessionId) as { id: number } | undefined;

    return row?.id ?? null;
  }

  private dropWorkerPidColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(32) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasColumn = cols.some(c => c.name === 'worker_pid');
    if (applied && !hasColumn) return;

    if (hasColumn) {
      try {
        this.db.run('DROP INDEX IF EXISTS idx_pending_messages_worker_pid');
        this.db.run('ALTER TABLE pending_messages DROP COLUMN worker_pid');
        logger.debug('DB', 'Dropped worker_pid column and its index from pending_messages');
      } catch (error) {
        logger.warn('DB', 'Failed to drop worker_pid column from pending_messages', {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(32, new Date().toISOString());
    }
  }

  private ensureSDKSessionsPlatformContentIdentity(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(33) as SchemaVersion | undefined;
    const hasGlobalContentUnique = this.hasUniqueIndexOnColumns('sdk_sessions', ['content_session_id']);
    const hasCompositeUnique = this.hasUniqueIndexOnColumns('sdk_sessions', ['platform_source', 'content_session_id']);
    const columns = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasPlatformSource = columns.some(col => col.name === 'platform_source');

    if (applied && !hasGlobalContentUnique && hasCompositeUnique && hasPlatformSource) return;

    if (!hasPlatformSource) {
      this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
    }

    this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);

    if (hasGlobalContentUnique) {
      this.db.run('PRAGMA foreign_keys = OFF');
      this.db.run('BEGIN TRANSACTION');
      try {
        this.rebuildSdkSessionsWithCompositeIdentity(applied);
        this.db.run('COMMIT');
      } catch (error) {
        this.db.run('ROLLBACK');
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('DB', 'Failed to rebuild sdk_sessions with composite identity, rolled back', {}, err);
        throw error;
      } finally {
        this.db.run('PRAGMA foreign_keys = ON');
      }
      return;
    }

    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(33, new Date().toISOString());
    }
  }

  private rebuildSdkSessionsWithCompositeIdentity(applied: SchemaVersion | undefined): void {
    this.db.run('DROP TABLE IF EXISTS sdk_sessions_new');
    this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}',
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
    this.db.run(`
      INSERT INTO sdk_sessions_new (
        id, content_session_id, memory_session_id, project, platform_source,
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      )
      SELECT
        id, content_session_id, memory_session_id, project,
        COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `);
    this.db.run('DROP TABLE sdk_sessions');
    this.db.run('ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');
    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)');
    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(33, new Date().toISOString());
    }
  }

  private ensureUserPromptsSessionDbId(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(34) as SchemaVersion | undefined;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all() as TableNameRow[];
    if (tables.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(34, new Date().toISOString());
      return;
    }

    const cols = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
    const hasSessionDbId = cols.some(col => col.name === 'session_db_id');
    const fks = this.db.query('PRAGMA foreign_key_list(user_prompts)').all() as Array<{ table: string; from: string; to: string }>;
    const hasContentSessionFk = fks.some(fk => fk.table === 'sdk_sessions' && fk.from === 'content_session_id');

    if (applied && hasSessionDbId && !hasContentSessionFk) return;

    const hasFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all() as { name: string }[]).length > 0;
    const sessionDbIdSelect = hasSessionDbId
      ? `COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')
            WHEN '${DEFAULT_PLATFORM_SOURCE}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`
      : `(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')
            WHEN '${DEFAULT_PLATFORM_SOURCE}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;

    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.run('BEGIN TRANSACTION');
    try {
      this.rebuildUserPromptsWithSessionDbId(applied, sessionDbIdSelect, hasFTS);
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DB', 'Failed to rebuild user_prompts with session_db_id, rolled back', {}, err);
      throw error;
    } finally {
      this.db.run('PRAGMA foreign_keys = ON');
    }
  }

  private rebuildUserPromptsWithSessionDbId(applied: SchemaVersion | undefined, sessionDbIdSelect: string, hasFTS: boolean): void {
    this.db.run('DROP TRIGGER IF EXISTS user_prompts_ai');
    this.db.run('DROP TRIGGER IF EXISTS user_prompts_ad');
    this.db.run('DROP TRIGGER IF EXISTS user_prompts_au');
    this.db.run('DROP TABLE IF EXISTS user_prompts_new');
    this.db.run(`
      CREATE TABLE user_prompts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO user_prompts_new (
        id, session_db_id, content_session_id, prompt_number,
        prompt_text, created_at, created_at_epoch
      )
      SELECT
        up.id,
        ${sessionDbIdSelect},
        up.content_session_id,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
    `);
    this.db.run('DROP TABLE user_prompts');
    this.db.run('ALTER TABLE user_prompts_new RENAME TO user_prompts');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)');

    if (hasFTS) {
      this.db.run(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;

        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END;

        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;
      `);
      this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')");
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(34, new Date().toISOString());
    }
  }

  private ensurePendingMessagesSessionToolUniqueIndex(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(35) as SchemaVersion | undefined;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all() as TableNameRow[];
    if (tables.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
      return;
    }

    const hasExpectedIndex = this.hasUniqueIndexOnColumns('pending_messages', ['session_db_id', 'tool_use_id']);
    if (applied && hasExpectedIndex) return;

    this.db.run('BEGIN TRANSACTION');
    try {
      this.recreatePendingSessionToolUniqueIndex(applied);
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DB', 'Failed to recreate ux_pending_session_tool index, rolled back', {}, err);
      throw error;
    }
  }

  private recreatePendingSessionToolUniqueIndex(applied: SchemaVersion | undefined): void {
    this.db.run('DROP INDEX IF EXISTS ux_pending_session_tool');
    this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `);
    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
    }
  }

  private ensureSyncedAtColumns(): void {
    // Not gated on a schema_versions row: the community-edge line already
    // consumed versions 36-38 without adding synced_at, so affected DBs have
    // those version rows but not the columns. The PRAGMA checks are the real
    // guard; version 39 is recorded for bookkeeping only.
    for (const table of ['observations', 'session_summaries', 'user_prompts']) {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const hasSyncedAt = tableInfo.some(col => col.name === 'synced_at');

      if (!hasSyncedAt) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN synced_at INTEGER`);
        logger.debug('DB', `Added synced_at column to ${table} table`);
      }

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_unsynced ON ${table}(id) WHERE synced_at IS NULL`);
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(39, new Date().toISOString());
  }

  /**
   * Two-lane sync origins (version 41): every synced table learns where a row
   * came from. Native rows keep the origin columns NULL (NULL = this device);
   * rows applied from the sync hub carry the origin device's id and that
   * device's local rowid, and the partial unique index makes re-applying the
   * same remote op an upsert instead of a duplicate (kind is implicit per
   * table, so the index needs only the device/local pair). `sync_rev` is the
   * entity revision used by the mutation-op rev guard (SyncApply); it starts
   * at 1 for every existing and native row. `sync_state` is the pull cursor
   * store (`cursor`, `epoch`) — advanced inside the same transaction as row
   * application for crash-safe exactly-once (see SyncApply.applyOps).
   *
   * Same shape as ensureSyncedAtColumns: the PRAGMA checks are the real
   * guard; version 41 is recorded for bookkeeping only.
   */
  private ensureSyncOriginColumns(): void {
    for (const table of ['observations', 'session_summaries', 'user_prompts']) {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const columnNames = new Set(tableInfo.map(col => col.name));

      if (!columnNames.has('origin_device_id')) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN origin_device_id TEXT`);
        logger.debug('DB', `Added origin_device_id column to ${table} table`);
      }
      if (!columnNames.has('origin_local_id')) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN origin_local_id TEXT`);
        logger.debug('DB', `Added origin_local_id column to ${table} table`);
      }
      if (!columnNames.has('sync_rev')) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`);
        logger.debug('DB', `Added sync_rev column to ${table} table`);
      }

      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_origin
        ON ${table}(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      `);
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_state (
        k TEXT PRIMARY KEY,
        v TEXT
      )
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(41, new Date().toISOString());
  }

  /**
   * Mutation outbox (version 42): durable queue for the four mutation sites
   * (custom title, prompt→session repair, the two project remaps). Each row
   * is one `kind='mutation'` op for the sync hub: `op_uuid` is the op's
   * origin_id — minted ONCE at enqueue time and reused on every push retry
   * (the hub dedupes on (origin_device, kind, origin_id, rev)); `rev` follows
   * the REV MINTING RULES in SyncApply.ts; `body` is the mutation envelope
   * JSON. The push drain (CloudSync.drainMutations) DELETEs rows on ack —
   * unlike the row tables, outbox rows are pure queue entries, not data.
   *
   * Same shape as ensureSyncOriginColumns: CREATE IF NOT EXISTS is the real
   * guard; version 42 is recorded for bookkeeping only.
   */
  private ensureSyncOutbox(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_uuid TEXT NOT NULL UNIQUE,
        rev TEXT NOT NULL DEFAULT '1',
        body TEXT NOT NULL,
        canonical_body TEXT,
        operation_sha256 TEXT,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    const columns = new Set(
      (this.db.query('PRAGMA table_info(sync_outbox)').all() as TableColumnInfo[]).map(column => column.name)
    );
    if (!columns.has('canonical_body')) {
      this.db.run('ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT');
    }
    if (!columns.has('operation_sha256')) {
      this.db.run('ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(42, new Date().toISOString());
  }

  /**
   * Canonical uint64 revision storage (version 46). SQLite INTEGER tops out
   * at signed int64, so INTEGER affinity silently converts larger decimal
   * strings to REAL and destroys their exact value. Keep every row/content
   * revision as canonical decimal TEXT instead.
   *
   * v41 and the original v42 created INTEGER-affinity columns. SQLite cannot
   * alter a column's declared type in place, so each affected column is
   * replaced transactionally with ADD/COPY/DROP/RENAME. This leaves the
   * tables themselves (and therefore their indexes, triggers, and foreign
   * keys) intact. The PRAGMA affinity checks are the real idempotency guard;
   * the version row is bookkeeping only.
   *
   * A legacy REAL value is already rounded and cannot be recovered. Refuse
   * the upgrade loudly instead of freezing scientific notation as a fake
   * revision. Every copied INTEGER/TEXT value is also validated as a
   * positive canonical uint64 before any schema change commits.
   */
  private ensureSyncRevisionTextAffinity(): void {
    const targets = [
      { table: 'observations', column: 'sync_rev', temporary: 'sync_rev_text_v46' },
      { table: 'session_summaries', column: 'sync_rev', temporary: 'sync_rev_text_v46' },
      { table: 'user_prompts', column: 'sync_rev', temporary: 'sync_rev_text_v46' },
      { table: 'sync_outbox', column: 'rev', temporary: 'rev_text_v46' },
    ] as const;

    const columnInfo = (table: string, column: string): TableColumnInfo | undefined =>
      (this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[])
        .find(info => info.name === column);
    const isText = (info: TableColumnInfo | undefined): boolean =>
      info?.type.trim().toUpperCase() === 'TEXT';
    const applied = this.db.prepare(
      'SELECT version FROM schema_versions WHERE version = ?'
    ).get(46) as SchemaVersion | undefined;

    if (applied && targets.every(target => isText(columnInfo(target.table, target.column)))) {
      return;
    }

    const tx = this.db.transaction(() => {
      for (const target of targets) {
        const columns = this.db.query(`PRAGMA table_info(${target.table})`).all() as TableColumnInfo[];
        const source = columns.find(info => info.name === target.column);
        if (!source) {
          throw new Error(`schema v46: missing ${target.table}.${target.column}`);
        }

        for (const raw of this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${target.column}) AS storage_type,
                 CAST(${target.column} AS TEXT) AS revision
          FROM ${target.table}
        `).iterate()) {
          const row = raw as { row_id: string; storage_type: string; revision: string | null };
          if (row.storage_type === 'real') {
            throw new Error(
              `schema v46: ${target.table}.${target.column} row ${row.row_id} is REAL and unrecoverably rounded`
            );
          }
          if (row.storage_type !== 'integer' && row.storage_type !== 'text') {
            throw new Error(
              `schema v46: ${target.table}.${target.column} row ${row.row_id} has unsupported ${row.storage_type} storage`
            );
          }
          try {
            assertCanonicalDecimal(row.revision, { positive: true });
          } catch {
            throw new Error(
              `schema v46: ${target.table}.${target.column} row ${row.row_id} is not a positive canonical uint64 revision`
            );
          }
        }

        if (isText(source)) continue;
        if (columns.some(info => info.name === target.temporary)) {
          throw new Error(`schema v46: unexpected temporary column ${target.table}.${target.temporary}`);
        }

        this.db.run(
          `ALTER TABLE ${target.table} ADD COLUMN ${target.temporary} TEXT NOT NULL DEFAULT '1'`
        );
        this.db.run(
          `UPDATE ${target.table} SET ${target.temporary} = CAST(${target.column} AS TEXT)`
        );
        const mismatch = this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${target.table}
          WHERE ${target.temporary} <> CAST(${target.column} AS TEXT)
          LIMIT 1
        `).get() as { row_id: string } | undefined;
        if (mismatch) {
          throw new Error(
            `schema v46: failed to copy ${target.table}.${target.column} row ${mismatch.row_id} exactly`
          );
        }
        this.db.run(`ALTER TABLE ${target.table} DROP COLUMN ${target.column}`);
        this.db.run(
          `ALTER TABLE ${target.table} RENAME COLUMN ${target.temporary} TO ${target.column}`
        );
      }

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(46, new Date().toISOString());
    });
    tx();
  }

  /**
   * Canonical-v2 entity heads and durable tombstone queue. Revisions remain
   * decimal TEXT so a remote value is never rounded through a JS number.
   */
  private ensureSyncEntityLedger(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_entity_heads (
        entity_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_device_id TEXT NOT NULL,
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at_epoch INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_content_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        body TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(entity_id, entity_rev)
      )
    `);
    const contentColumns = new Set(
      (this.db.query('PRAGMA table_info(sync_content_outbox)').all() as TableColumnInfo[]).map(column => column.name)
    );
    if (!contentColumns.has('deleted')) {
      this.db.run('ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
      this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `);
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL CHECK (lane IN ('content', 'mutation')),
        queue_key TEXT NOT NULL,
        kind TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(lane, queue_key, entity_rev, reason)
      )
    `);
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
      .run(44, new Date().toISOString());
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
      .run(45, new Date().toISOString());
  }


  /**
   * One-time launch boundary (v47) plus its durable revision exclusions
   * (v48). This product line has no released cloud corpus to migrate, so the
   * exact native revisions present at launch are a local-only baseline. The
   * exclusion ledger survives Hub epoch changes; if one of those rows is
   * edited later, its higher revision is eligible for ordinary sync/rebuild.
   * Fresh databases run this while empty.
   */
  private initializeSyncHubLaunchBaseline(): void {
    const tables = [
      { table: 'observations', kind: 'observation' },
      { table: 'session_summaries', kind: 'summary' },
      { table: 'user_prompts', kind: 'prompt' },
    ] as const;
    const exclusionTableExisted = this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get() !== undefined;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        through_rev TEXT NOT NULL,
        PRIMARY KEY (kind, origin_local_id)
      )
    `);

    const applied = this.db.prepare(
      'SELECT version, applied_at FROM schema_versions WHERE version = ?'
    ).get(47) as { version: number; applied_at: string } | undefined;

    if (!applied) {
      const now = Date.now();
      const tx = this.db.transaction(() => {
        // Recompute if a migration fixture deliberately removes v47. In a
        // real pre-v47 database this table is newly created and already empty.
        this.db.run('DELETE FROM sync_launch_exclusions');
        for (const { table, kind } of tables) {
          this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${table}
            WHERE origin_device_id IS NULL
          `).run(kind);
          this.db.prepare(`
            UPDATE ${table} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(now);
        }
        this.db.run('DELETE FROM sync_outbox');
        this.db.run('DELETE FROM sync_content_outbox');
        this.db.run('DELETE FROM sync_dead_letter');
        // Adopt the launch Hub as a genuinely first epoch. Retaining a cursor
        // or epoch from a pre-launch test Hub would make SyncApply interpret
        // the first connection as a rebuild. Parked mutations belong to that
        // discarded test log, so pre-launch sync_state is stale control-plane
        // state; the exclusion ledger above is the only boundary state kept.
        this.db.run('DELETE FROM sync_state');
        const appliedAt = new Date(now).toISOString();
        this.db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(47, appliedAt);
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(48, appliedAt);
      });
      tx();
      return;
    }

    // Repair databases that ran the earlier v47 implementation before the
    // explicit exclusion ledger existed. v47 stamped the launch baseline at
    // its applied_at millisecond. Rows still stamped at/before that boundary
    // are the excluded launch revisions; NULL or later stamps are post-launch
    // writes/acks and must remain eligible for an epoch rebuild.
    const exclusionsApplied = this.db.prepare(
      'SELECT version FROM schema_versions WHERE version = ?'
    ).get(48) as SchemaVersion | undefined;
    if (exclusionsApplied && exclusionTableExisted) return;
    const boundaryMs = Date.parse(applied.applied_at);
    if (!Number.isSafeInteger(boundaryMs) || boundaryMs < 0) {
      throw new Error(`schema v48: invalid v47 applied_at ${applied.applied_at}`);
    }
    const repair = this.db.transaction(() => {
      for (const { table, kind } of tables) {
        this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${table}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(kind, boundaryMs);
      }
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(48, new Date().toISOString());
    });
    repair();
  }

  // v49 (#3379): the context-injection query matches concepts exactly
  // (ObservationCompiler `WHERE value IN (...)`), so historical rows written
  // as "keyword: description" never matched. Truncate each stored concept at
  // the first ':' and trim; the parser now enforces the same shape on write.
  //
  // `json_valid` guard: a non-JSON concepts value containing ':' would make
  // json_each throw and abort the whole constructor migration chain (worker
  // never initializes — the #3378 failure class). Invalid-JSON rows are
  // equally unreadable before and after v49 for every json_each reader, so
  // skipping them changes no behavior; this is an explicit domain-state
  // check, not error swallowing.
  //
  // Corrected NATIVE rows must re-sync: the row body changed, so bump
  // sync_rev and re-null synced_at (mirroring requeuePromptSync) — the next
  // drain re-pushes the corrected body at the higher rev and replicas apply
  // it via the rev guard. Replica rows (origin_device_id NOT NULL) are
  // normalized locally only; their repair travels from THEIR origin device.
  private normalizeConceptTags(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(49) as SchemaVersion | undefined;
    if (applied) return;

    let changedCount = 0;
    const tx = this.db.transaction(() => {
      const affected = this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM observations
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `).all() as Array<{ id: string; origin_device_id: string | null; sync_rev: string }>;
      changedCount = affected.length;

      this.db.run(`
        UPDATE observations
        SET concepts = (
          SELECT json_group_array(
            CASE WHEN instr(value, ':') > 0
                 THEN trim(substr(value, 1, instr(value, ':') - 1))
                 ELSE value END)
          FROM json_each(observations.concepts))
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `);

      for (const row of affected) {
        if (row.origin_device_id !== null) continue;
        const nextRev = incrementCanonicalDecimal(row.sync_rev);
        this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(nextRev, row.id);
      }

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(49, new Date().toISOString());
    });
    tx();
    logger.debug('DB', `Normalized prefixed concept tags in ${changedCount} observations (v49)`);
  }

  private dropDeadPendingMessagesColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(31) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const colNames = new Set(cols.map(c => c.name));
    const deadColumns = ['retry_count', 'failed_at_epoch', 'completed_at_epoch'];
    const toDrop = deadColumns.filter(name => colNames.has(name));
    if (applied && toDrop.length === 0) return;

    if (toDrop.length > 0) {
      this.db.run('BEGIN TRANSACTION');
      try {
        this.db.run(`DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')`);
        for (const colName of toDrop) {
          this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${colName}`);
          logger.debug('DB', `Dropped dead column ${colName} from pending_messages`);
        }
        if (!applied) {
          this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
        }
        this.db.run('COMMIT');
      } catch (error) {
        this.db.run('ROLLBACK');
        logger.warn('DB', 'Failed to drop dead columns from pending_messages', {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      return;
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
    }
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    this.db.run(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
  }

  private ensureWorkerPortColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  private ensurePromptTrackingColumns(): void {
    const sessionsInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  // #3378: legacy DBs contain child rows whose memory_session_id has no
  // sdk_sessions parent (written historically while foreign_keys was OFF).
  // The v7/v9 rebuilds copy those children into a freshly created table via
  // INSERT ... SELECT with foreign_keys = ON (the connection pragma; these
  // rebuilds, unlike v21/v33/v34, never disable it), so a single orphan
  // aborts the whole constructor migration chain with 'FOREIGN KEY
  // constraint failed' and the worker never reports ready. Orphaned children
  // are live user data served by context injection — the missing side is the
  // parent, so create a minimal completed stub session per orphaned
  // memory_session_id immediately before the copy, mirroring
  // SyncApply.ensureSessionForMemoryId (INSERT ... ON CONFLICT DO NOTHING;
  // content_session_id falls back to the memory id). COUNT-then-INSERT for
  // the log figure, per the bun:sqlite `.run().changes` trap documented in
  // SyncApply.ts.
  private repairOrphanedSessionParents(childTable: 'observations' | 'session_summaries'): void {
    const orphaned = (this.db.prepare(`
      SELECT COUNT(DISTINCT c.memory_session_id) AS n
      FROM ${childTable} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
    `).get() as { n: number }).n;
    if (orphaned === 0) return;

    this.db.run(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      SELECT
        c.memory_session_id,
        c.memory_session_id,
        MIN(c.project),
        MIN(c.created_at),
        MIN(c.created_at_epoch),
        'completed'
      FROM ${childTable} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
      GROUP BY c.memory_session_id
      ON CONFLICT DO NOTHING
    `);
    logger.warn('DB', `Created ${orphaned} stub sdk_sessions parent(s) for orphaned ${childTable} rows before rebuild (#3378)`);
  }

  private removeSessionSummariesUniqueConstraint(): void {
    const summariesIndexes = this.db.query('PRAGMA index_list(session_summaries)').all() as IndexInfo[];
    // Only table-level UNIQUE constraints (PRAGMA origin 'u' — the v7 target,
    // `memory_session_id TEXT UNIQUE`) require the rebuild; they cannot be
    // dropped any other way. Explicitly created unique indexes (origin 'c',
    // e.g. v41's ux_session_summaries_origin) were never this migration's
    // concern — matching them here would retrigger the rebuild on every boot
    // and silently drop every post-v7 column.
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1 && idx.origin === 'u');

    if (!hasUniqueConstraint) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    this.db.run('BEGIN TRANSACTION');

    // The copy below runs with foreign_keys = ON; repair orphaned parents
    // first or a single orphan aborts the migration chain (#3378).
    this.repairOrphanedSessionParents('session_summaries');

    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    this.db.run(`
      CREATE TABLE session_summaries_new (
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
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    this.db.run('DROP TABLE session_summaries');

    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  private addObservationHierarchicalFields(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(8) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());

    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  private makeObservationsTextNullable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(9) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    this.db.run('BEGIN TRANSACTION');

    // The copy below runs with foreign_keys = ON; repair orphaned parents
    // first or a single orphan aborts the migration chain (#3378).
    this.repairOrphanedSessionParents('observations');

    this.db.run('DROP TABLE IF EXISTS observations_new');

    this.db.run(`
      CREATE TABLE observations_new (
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
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    this.db.run('DROP TABLE observations');

    this.db.run('ALTER TABLE observations_new RENAME TO observations');

    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  private createUserPromptsTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(10) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
    if (tableInfo.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    this.db.run('BEGIN TRANSACTION');

    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_session ON user_prompts(session_db_id);
      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number);
      CREATE INDEX idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number);
    `);

    const ftsCreateSQL = `
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `;
    const ftsTriggersSQL = `
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `;

    try {
      this.db.run(ftsCreateSQL);
      this.db.run(ftsTriggersSQL);
    } catch (ftsError) {
      if (ftsError instanceof Error) {
        logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, ftsError);
      } else {
        logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, new Error(String(ftsError)));
      }
      this.db.run('COMMIT');
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      logger.debug('DB', 'Created user_prompts table (without FTS5)');
      return;
    }

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

    logger.debug('DB', 'Successfully created user_prompts table');
  }

  private ensureDiscoveryTokensColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as SchemaVersion | undefined;
    if (applied) return;

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
  }

  private createPendingMessagesTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(16) as SchemaVersion | undefined;
    if (applied) return;

    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all() as TableNameRow[];
    if (tables.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating pending_messages table');

    this.db.run(`
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
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());

    logger.debug('DB', 'pending_messages table created successfully');
  }

  private renameSessionIdColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(17) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    const safeRenameColumn = (table: string, oldCol: string, newCol: string): boolean => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) {
        return false;
      }

      if (hasOldCol) {
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    if (safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    if (safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  private addFailedAtEpochColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(20) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'failed_at_epoch');

    if (!hasColumn) {
      this.db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER');
      logger.debug('DB', 'Added failed_at_epoch column to pending_messages table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(20, new Date().toISOString());
  }

  private addOnUpdateCascadeToForeignKeys(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(21) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TRIGGER IF EXISTS observations_ai');
    this.db.run('DROP TRIGGER IF EXISTS observations_ad');
    this.db.run('DROP TRIGGER IF EXISTS observations_au');

    this.db.run('DROP TABLE IF EXISTS observations_new');

    const observationsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const observationsHasMetadata = observationsCols.some(c => c.name === 'metadata');
    const observationsHasContentHash = observationsCols.some(c => c.name === 'content_hash');
    const metadataColumnSQL = observationsHasMetadata ? ',\n        metadata TEXT' : '';
    const metadataSelectSQL = observationsHasMetadata ? ', metadata' : '';
    const contentHashColumnSQL = observationsHasContentHash ? ',\n        content_hash TEXT' : '';
    const contentHashSelectSQL = observationsHasContentHash ? ', content_hash' : '';

    const observationsNewSQL = `
      CREATE TABLE observations_new (
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
        created_at_epoch INTEGER NOT NULL${metadataColumnSQL}${contentHashColumnSQL},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const observationsCopySQL = `
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${metadataSelectSQL}${contentHashSelectSQL}
      FROM observations
    `;
    const observationsIndexesSQL = `
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `;
    const observationsFTSTriggersSQL = `
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `;

    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');

    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    const summariesNewSQL = `
      CREATE TABLE session_summaries_new (
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
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const summariesCopySQL = `
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `;
    const summariesIndexesSQL = `
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `;
    const summariesFTSTriggersSQL = `
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `;

    try {
      this.recreateObservationsWithCascade(observationsNewSQL, observationsCopySQL, observationsIndexesSQL, observationsFTSTriggersSQL);
      this.recreateSessionSummariesWithCascade(summariesNewSQL, summariesCopySQL, summariesIndexesSQL, summariesFTSTriggersSQL);

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());
      this.db.run('COMMIT');
      this.db.run('PRAGMA foreign_keys = ON');
      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } catch (error) {
      this.db.run('ROLLBACK');
      this.db.run('PRAGMA foreign_keys = ON');
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  private recreateObservationsWithCascade(createSQL: string, copySQL: string, indexesSQL: string, ftsTriggersSQL: string): void {
    this.db.run(createSQL);
    this.db.run(copySQL);
    this.db.run('DROP TABLE observations');
    this.db.run('ALTER TABLE observations_new RENAME TO observations');
    this.db.run(indexesSQL);

    const hasFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all() as { name: string }[]).length > 0;
    if (hasFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private recreateSessionSummariesWithCascade(createSQL: string, copySQL: string, indexesSQL: string, ftsTriggersSQL: string): void {
    this.db.run(createSQL);
    this.db.run(copySQL);
    this.db.run('DROP TABLE session_summaries');
    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');
    this.db.run(indexesSQL);

    const hasSummariesFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all() as { name: string }[]).length > 0;
    if (hasSummariesFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private addObservationContentHashColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'content_hash');

    if (hasColumn) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
      return;
    }

    this.db.run('ALTER TABLE observations ADD COLUMN content_hash TEXT');
    this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    logger.debug('DB', 'Added content_hash column to observations table with backfill and index');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
  }

  private addSessionCustomTitleColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(23) as SchemaVersion | undefined;
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'custom_title');

    if (applied && hasColumn) return;

    if (!hasColumn) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT');
      logger.debug('DB', 'Added custom_title column to sdk_sessions table');
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(23, new Date().toISOString());
    }
  }

  private addSessionPlatformSourceColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'platform_source');
    const indexInfo = this.db.query('PRAGMA index_list(sdk_sessions)').all() as IndexInfo[];
    const hasIndex = indexInfo.some(index => index.name === 'idx_sdk_sessions_platform_source');
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;

    if (applied && hasColumn && hasIndex) return;

    if (!hasColumn) {
      this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
      logger.debug('DB', 'Added platform_source column to sdk_sessions table');
    }

    this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);

    if (!hasIndex) {
      this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
  }

  private addObservationModelColumns(): void {
    const columns = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasGeneratedByModel = columns.some(col => col.name === 'generated_by_model');
    const hasRelevanceCount = columns.some(col => col.name === 'relevance_count');

    if (hasGeneratedByModel && hasRelevanceCount) return;

    if (!hasGeneratedByModel) {
      this.db.run('ALTER TABLE observations ADD COLUMN generated_by_model TEXT');
    }
    if (!hasRelevanceCount) {
      this.db.run('ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(26, new Date().toISOString());
  }

  private ensureMergedIntoProjectColumns(): void {
    const obsCols = this.db
      .query('PRAGMA table_info(observations)')
      .all() as TableColumnInfo[];
    if (!obsCols.some(c => c.name === 'merged_into_project')) {
      this.db.run('ALTER TABLE observations ADD COLUMN merged_into_project TEXT');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)'
    );

    const sumCols = this.db
      .query('PRAGMA table_info(session_summaries)')
      .all() as TableColumnInfo[];
    if (!sumCols.some(c => c.name === 'merged_into_project')) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)'
    );
  }

  private addObservationSubagentColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(27) as SchemaVersion | undefined;

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasAgentType = obsCols.some(col => col.name === 'agent_type');
    const obsHasAgentId = obsCols.some(col => col.name === 'agent_id');

    if (!obsHasAgentType) {
      this.db.run('ALTER TABLE observations ADD COLUMN agent_type TEXT');
    }
    if (!obsHasAgentId) {
      this.db.run('ALTER TABLE observations ADD COLUMN agent_id TEXT');
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)');

    const pendingCols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    if (pendingCols.length > 0) {
      const pendingHasAgentType = pendingCols.some(col => col.name === 'agent_type');
      const pendingHasAgentId = pendingCols.some(col => col.name === 'agent_id');
      if (!pendingHasAgentType) {
        this.db.run('ALTER TABLE pending_messages ADD COLUMN agent_type TEXT');
      }
      if (!pendingHasAgentId) {
        this.db.run('ALTER TABLE pending_messages ADD COLUMN agent_id TEXT');
      }
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(27, new Date().toISOString());
    }
  }

  private ensurePendingMessagesToolUseIdColumn(): void {
    const tables = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).all() as TableNameRow[];
    if (tables.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
      return;
    }

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasToolUseId = cols.some(c => c.name === 'tool_use_id');

    if (!hasToolUseId) {
      this.db.run('ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT');
    }

    this.db.run('BEGIN TRANSACTION');
    try {
      this.dedupePendingMessagesByToolUseId();
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DB', 'Failed to de-dupe pending_messages by tool_use_id, rolled back', {}, err);
      throw error;
    }
  }

  private dedupePendingMessagesByToolUseId(): void {
    this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `);
    this.db.run(`
      -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
      -- only for rows that came from a concrete tool-use event.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
  }

  private addObservationsUniqueContentHashIndex(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(29) as SchemaVersion | undefined;
    if (applied) return;

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasMem = obsCols.some(c => c.name === 'memory_session_id');
    const hasHash = obsCols.some(c => c.name === 'content_hash');
    if (!hasMem || !hasHash) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
      return;
    }

    this.db.run('BEGIN TRANSACTION');
    try {
      this.dedupeObservationsByContentHash();
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('DB', 'Failed to de-dupe observations by content_hash, rolled back', {}, err);
      throw error;
    }
  }

  private dedupeObservationsByContentHash(): void {
    this.db.run(`
      UPDATE observations
         SET content_hash = '__null_migration_' || id || '__'
       WHERE content_hash IS NULL
    `);

    this.db.run(`
      DELETE FROM observations
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY memory_session_id, content_hash
                      ORDER BY id
                    ) AS duplicate_rank
               FROM observations
           )
          WHERE duplicate_rank > 1
       )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
      ON observations(memory_session_id, content_hash)
    `);
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
  }

  private addObservationsMetadataColumn(): void {
    const cols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = cols.some(c => c.name === 'metadata');

    if (!hasColumn) {
      this.db.run('ALTER TABLE observations ADD COLUMN metadata TEXT');
      logger.debug('DB', 'Added metadata column to observations table (#2116)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(30, new Date().toISOString());
  }

  updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): void {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(memorySessionId, sessionDbId);
    if (memorySessionId) this.requeuePromptSync(sessionDbId);
  }

  /**
   * Enqueue one mutation op for the sync hub (kind='mutation'). The op UUID
   * is minted HERE, once, and stored with the queued op — CloudSync's drain
   * reuses it on every push retry so the hub's
   * (origin_device, kind, origin_id, rev) index dedupes replays (REV MINTING
   * RULES, SyncApply.ts). Pure SQL, no notify(): callers on the worker
   * connection nudge CloudSync themselves; the startup drain catches the
   * rest.
   */
  private enqueueMutationOp(rev: string | number, body: CanonicalMutation): void {
    // set_prompt_session records NULL as the durable "this device" marker;
    // validate the exact mutation shape/UTF-8 bounds with a temporary valid
    // device id before appending. CloudSync substitutes the resolved device
    // id exactly once when it snapshots the canonical wire operation.
    const candidate = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    if (candidate.op === 'set_prompt_session') {
      const target = candidate.target as Record<string, unknown> | undefined;
      if (target?.origin_device_id === null) target.origin_device_id = 'self';
    }
    validateCanonicalMutation(candidate);
    this.db.prepare(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), String(rev), JSON.stringify(body), Date.now());
  }

  /**
   * Prompt→session repair as an ordered sync op (plan Phase 3 task 2):
   * prompts are captured (and pushed) before the SDK session registers its
   * memory_session_id, so their first push carries NULL join fields. Once
   * the mapping lands, each affected NATIVE prompt row gets sync_rev bumped
   * by 1 with synced_at re-nulled — the next flush re-pushes the corrected
   * row body at the higher rev (replicas apply it via the row-op rev guard),
   * and a set_prompt_session mutation op is enqueued at that same post-bump
   * rev (SyncApply REV MINTING RULES) so replicas that already hold the
   * rev-1 row link it to the session even before the corrected row op lands.
   * target.origin_device_id is stored as NULL ("this device") — CloudSync's
   * drain substitutes its resolved device id at push time, keeping device
   * identity single-sourced (see DEVICE IDENTITY in SyncApply.ts).
   *
   * Replica prompt rows (origin_device_id NOT NULL) are untouched: their
   * repair travels through the log from THEIR origin device.
   *
   * This bump-then-repush ordering is also what made CloudSync's old
   * stampGuard unnecessary: the drain stamps synced_at only where the acked
   * rev still equals the row's sync_rev, so a registration landing while a
   * POST is in flight leaves the row unsynced and it re-pushes corrected.
   */
  private requeuePromptSync(sessionDbId: number): void {
    const session = this.db.prepare(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as {
      memory_session_id: string | null;
      project: string | null;
      content_session_id: string | null;
      platform_source: string | null;
    } | undefined;
    if (!session?.memory_session_id) return;

    const tx = this.db.transaction(() => {
      const prompts = this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(sessionDbId) as Array<{ id: string; sync_rev: string }>;
      if (prompts.length === 0) return;

      for (const prompt of prompts) {
        const nextRev = incrementCanonicalDecimal(prompt.sync_rev);
        this.db.prepare(`
          UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(nextRev, prompt.id);
        this.enqueueMutationOp(nextRev, {
          op: 'set_prompt_session',
          target: { origin_device_id: null, origin_local_id: prompt.id },
          fields: {
            memory_session_id: session.memory_session_id,
            project: session.project,
            content_session_id: session.content_session_id,
            platform_source: session.platform_source,
          },
        });
      }
    });
    tx();
  }

  markSessionCompleted(sessionDbId: number): void {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(nowIso, nowEpoch, sessionDbId);
  }

  ensureMemorySessionIdRegistered(
    sessionDbId: number,
    memorySessionId: string,
    workerPort?: number
  ): void {
    const session = this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as { id: number; memory_session_id: string | null; worker_port: number | null } | undefined;

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    if (session.memory_session_id !== memorySessionId) {
      this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(memorySessionId, sessionDbId);
      this.requeuePromptSync(sessionDbId);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }

    // Session identity (#2533): record which worker owns this session before
    // any observation is accepted, so a row is never persisted for a session
    // whose identity is half-set. Only write when we have a port and it isn't
    // already recorded, to avoid churn on every storage round.
    if (typeof workerPort === 'number' && session.worker_port !== workerPort) {
      this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(workerPort, sessionDbId);
    }
  }

  getAllProjects(platformSource?: string): string[] {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `;
    const params: SQLQueryBindings[] = [OBSERVER_SESSIONS_PROJECT];

    if (normalizedPlatformSource) {
      query += ' AND COALESCE(platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }

    query += ' ORDER BY project ASC';

    const rows = this.db.prepare(query).all(...params) as Array<{ project: string }>;
    return rows.map(row => row.project);
  }

  getProjectCatalog(): {
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  } {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}'), project
      ORDER BY latest_epoch DESC
    `).all(OBSERVER_SESSIONS_PROJECT) as Array<{ platform_source: string; project: string; latest_epoch: number }>;

    const projects: string[] = [];
    const seenProjects = new Set<string>();
    const projectsBySource: Record<string, string[]> = {};

    for (const row of rows) {
      const source = normalizePlatformSource(row.platform_source);

      if (!projectsBySource[source]) {
        projectsBySource[source] = [];
      }

      if (!projectsBySource[source].includes(row.project)) {
        projectsBySource[source].push(row.project);
      }

      if (!seenProjects.has(row.project)) {
        seenProjects.add(row.project);
        projects.push(row.project);
      }
    }

    const sources = sortPlatformSources(Object.keys(projectsBySource));

    return {
      projects,
      sources,
      projectsBySource: Object.fromEntries(
        sources.map(source => [source, projectsBySource[source] || []])
      )
    };
  }

  getLatestUserPrompt(contentSessionId: string, sessionDbId?: number): LatestPromptResult | undefined {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    const whereClause = resolvedSessionDbId !== null ? 'up.session_db_id = ?' : 'up.content_session_id = ?';
    const param = resolvedSessionDbId !== null ? resolvedSessionDbId : contentSessionId;
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${whereClause}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(param) as LatestPromptResult | undefined;
  }

  findRecentDuplicateUserPrompt(
    contentSessionId: string,
    promptText: string,
    windowMs: number,
    sessionDbId?: number
  ): LatestPromptResult | undefined {
    return findRecentDuplicateUserPromptRecord(
      this.db,
      contentSessionId,
      normalizeStoredPromptText(promptText),
      windowMs,
      this.resolvePromptSessionDbId(contentSessionId, sessionDbId) ?? undefined
    );
  }

  getRecentSessionsWithStatus(project: string, limit: number = 3, platformSource?: string): RecentSessionStatusRow[] {
    const params: any[] = [project];
    let platformClause = '';
    if (platformSource) {
      platformClause = `AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`;
      params.push(normalizePlatformSource(platformSource));
    }
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        ${platformClause}
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);

    return stmt.all(...params) as RecentSessionStatusRow[];
  }

  getObservationsForSession(memorySessionId: string, platformSource?: string): SessionObservationRow[] {
    const params: any[] = [memorySessionId];
    let platformClause = '';
    if (platformSource) {
      platformClause = `
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
        )
      `;
      params.push(normalizePlatformSource(platformSource));
    }

    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${platformClause}
      ORDER BY created_at_epoch ASC
    `);

    return stmt.all(...params) as SessionObservationRow[];
  }

  getObservationById(id: number, platformSource?: string): ObservationRecord | null {
    if (!platformSource) {
      const stmt = this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `);

      return stmt.get(id) as ObservationRecord | undefined || null;
    }

    const stmt = this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
    `);

    return stmt.get(id, normalizePlatformSource(platformSource)) as ObservationRecord | undefined || null;
  }

  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; platformSource?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationSearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, platformSource, type, concepts, files } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY o.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit && !preserveIdOrder ? `LIMIT ${limit}` : '';

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (project) {
      additionalConditions.push('(o.project = ? OR o.merged_into_project = ?)');
      params.push(project, project);
    }

    if (platformSource) {
      additionalConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(platformSource));
    }

    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => '?').join(',');
        additionalConditions.push(`o.type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push('o.type = ?');
        params.push(type);
      }
    }

    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() =>
        'EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return '(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))';
      });
      filesList.forEach(file => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }

    const whereClause = additionalConditions.length > 0
      ? `WHERE o.id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
      : `WHERE o.id IN (${placeholders})`;

    const stmt = this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as ObservationSearchResult[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    const ordered = ids.map(id => rowMap.get(id)).filter((r): r is ObservationSearchResult => !!r);
    return limit ? ordered.slice(0, limit) : ordered;
  }

  getSummaryForSession(memorySessionId: string, platformSource?: string): SummaryDetailRow | null {
    const params: any[] = [memorySessionId];
    let platformClause = '';
    if (platformSource) {
      platformClause = `
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
        )
      `;
      params.push(normalizePlatformSource(platformSource));
    }

    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${platformClause}
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `);

    return (stmt.get(...params) as SummaryDetailRow | null) || null;
  }

  getSessionById(id: number): SdkSessionDetailRow | null {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as SdkSessionDetailRow | null) || null;
  }

  getSdkSessionsBySessionIds(memorySessionIds: string[]): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[] {
    if (memorySessionIds.length === 0) return [];

    const placeholders = memorySessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `);

    return stmt.all(...memorySessionIds) as any[];
  }

  getPromptNumberFromUserPrompts(contentSessionId: string, sessionDbId?: number): number {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    if (resolvedSessionDbId !== null) {
      const result = this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(resolvedSessionDbId) as { count: number };
      return result.count;
    }

    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId) as { count: number };
    return result.count;
  }

  createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string
  ): number {
    const now = new Date();
    const nowEpoch = now.getTime();
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : DEFAULT_PLATFORM_SOURCE;
    const storedUserPrompt = normalizeStoredPromptText(userPrompt);
    if (customTitle) {
      this.validateSetTitleMutation(contentSessionId, normalizedPlatformSource, customTitle);
    }

    const existing = this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource, contentSessionId) as { id: number; platform_source: string | null } | undefined;

    if (existing) {
      if (project) {
        this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(project, existing.id);
      }
      if (customTitle) {
        // SELECT-then-UPDATE, never a decision on `.run().changes`
        // (bun:sqlite reports unreliable `changes` after RETURNING statements
        // on this connection — see the note in SyncApply.applySetTitle). The
        // set_title op is emitted only when the NULL-guarded fill actually
        // landed, mirroring what replicas will apply.
        const current = this.db.prepare(
          'SELECT custom_title FROM sdk_sessions WHERE id = ?'
        ).get(existing.id) as { custom_title: string | null } | undefined;
        if (current && current.custom_title === null) {
          this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(customTitle, existing.id);
          this.enqueueSetTitleOp(contentSessionId, normalizedPlatformSource, customTitle);
        }
      }
      return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, normalizedPlatformSource, storedUserPrompt, customTitle || null, now.toISOString(), nowEpoch);

    if (customTitle) {
      this.enqueueSetTitleOp(contentSessionId, normalizedPlatformSource, customTitle);
    }

    return Number(result.lastInsertRowid);
  }

  /**
   * Custom-title mutation op (plan Phase 3 task 2). sdk_sessions rows do not
   * sync, so there is no sync_rev to bump and no synced_at to null — the
   * title travels ONLY as a set_title mutation op. Per the SyncApply REV
   * MINTING RULES, set_title always emits rev 1 (rev is not consulted on
   * apply; titles converge by hub-log order plus parking), and the target is
   * the (platform_source, content_session_id) identity because no
   * memory_session_id is registered at session-creation time.
   */
  private enqueueSetTitleOp(contentSessionId: string, platformSource: string, customTitle: string): void {
    const mutation = this.validateSetTitleMutation(contentSessionId, platformSource, customTitle);
    this.enqueueMutationOp('1', mutation);
  }

  private validateSetTitleMutation(
    contentSessionId: string,
    platformSource: string,
    customTitle: string,
  ): CanonicalMutation {
    const mutation: CanonicalMutation = {
      op: 'set_title',
      target: { content_session_id: contentSessionId, platform_source: platformSource },
      fields: { custom_title: customTitle },
    };
    validateCanonicalMutation(mutation);
    return mutation;
  }

  saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string, sessionDbId?: number): number {
    const now = new Date();
    const nowEpoch = now.getTime();
    const storedPromptText = normalizeStoredPromptText(promptText);
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(resolvedSessionDbId, contentSessionId, promptNumber, storedPromptText, now.toISOString(), nowEpoch);
    return result.lastInsertRowid as number;
  }

  getUserPrompt(contentSessionId: string, promptNumber: number, sessionDbId?: number): string | null {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    if (resolvedSessionDbId !== null) {
      const result = this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(resolvedSessionDbId, promptNumber) as { prompt_text: string } | undefined;
      return result?.prompt_text ?? null;
    }

    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);

    const result = stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
    return result?.prompt_text ?? null;
  }

  storeObservation(
    memorySessionId: string,
    project: string,
    observation: {
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      agent_type?: string | null;
      agent_id?: string | null;
      metadata?: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): { id: number; createdAtEpoch: number } {
    const result = this.storeObservations(
      memorySessionId,
      project,
      [observation],
      null,
      promptNumber,
      discoveryTokens,
      overrideTimestampEpoch,
      generatedByModel
    );

    return { id: result.observationIds[0], createdAtEpoch: result.createdAtEpoch };
  }

  storeSummary(
    memorySessionId: string,
    project: string,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): { id: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }

  storeObservations(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      agent_type?: string | null;
      agent_id?: string | null;
      metadata?: string | null;
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): { observationIds: number[]; summaryId: number | null; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const storeTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
      );

      for (const observation of observations) {
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const inserted = obsStmt.get(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          observation.agent_type ?? null,
          observation.agent_id ?? null,
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null,
          observation.metadata ?? null
        ) as { id: number } | null;

        if (inserted) {
          observationIds.push(inserted.id);
          continue;
        }

        const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
        if (!existing) {
          throw new Error(
            `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        observationIds.push(existing.id);
      }

      let summaryId: number | null = null;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    return storeTx();
  }

  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; platformSource?: string } = {}
  ): SessionSummarySearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, platformSource } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY ss.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit && !preserveIdOrder ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (project) {
      additionalConditions.push('(ss.project = ? OR ss.merged_into_project = ?)');
      params.push(project, project);
    }

    if (platformSource) {
      additionalConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(platformSource));
    }

    const additionalFilter = additionalConditions.length > 0
      ? `AND ${additionalConditions.join(' AND ')}`
      : '';

    const stmt = this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${placeholders}) ${additionalFilter}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as SessionSummarySearchResult[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    const ordered = ids.map(id => rowMap.get(id)).filter((r): r is SessionSummarySearchResult => !!r);
    return limit ? ordered.slice(0, limit) : ordered;
  }

  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; platformSource?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, platformSource } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY up.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit && !preserveIdOrder ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (project) {
      additionalConditions.push('s.project = ?');
      params.push(project);
    }

    if (platformSource) {
      additionalConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(platformSource));
    }

    const additionalFilter = additionalConditions.length > 0
      ? `AND ${additionalConditions.join(' AND ')}`
      : '';

    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${placeholders}) ${additionalFilter}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as UserPromptRecord[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    const ordered = ids.map(id => rowMap.get(id)).filter((r): r is UserPromptRecord => !!r);
    return limit ? ordered.slice(0, limit) : ordered;
  }

  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string,
    platformSource?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project, platformSource);
  }

  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string,
    platformSource?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    const buildScope = (rowAlias: string, sessionAlias: string, includeMergedProject: boolean = false): { clause: string; params: any[] } => {
      const conditions: string[] = [];
      const params: any[] = [];

      if (project) {
        if (includeMergedProject) {
          conditions.push(`(${rowAlias}.project = ? OR ${rowAlias}.merged_into_project = ?)`);
          params.push(project, project);
        } else {
          conditions.push(`${rowAlias}.project = ?`);
          params.push(project);
        }
      }

      if (normalizedPlatformSource) {
        conditions.push(`COALESCE(NULLIF(${sessionAlias}.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
        params.push(normalizedPlatformSource);
      }

      return {
        clause: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '',
        params
      };
    };
    const observationScope = buildScope('o', 'src', true);
    const summaryScope = buildScope('ss', 'src', true);
    const promptScope = buildScope('s', 's');

    let startEpoch: number;
    let endEpoch: number;

    if (anchorObservationId !== null) {
      const beforeQuery = `
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${observationScope.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${observationScope.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...observationScope.params, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...observationScope.params, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error('DB', 'Error getting boundary observations', { project }, err);
        } else {
          logger.error('DB', 'Error getting boundary observations with non-Error', {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      const beforeQuery = `
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${observationScope.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${observationScope.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...observationScope.params, depthBefore) as Array<{created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...observationScope.params, depthAfter + 1) as Array<{created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error('DB', 'Error getting boundary timestamps', { project }, err);
        } else {
          logger.error('DB', 'Error getting boundary timestamps with non-Error', {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    }

    const obsQuery = `
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${observationScope.clause}
      ORDER BY o.created_at_epoch ASC
    `;

    const sessQuery = `
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${summaryScope.clause}
      ORDER BY ss.created_at_epoch ASC
    `;

    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${promptScope.clause}
      ORDER BY up.created_at_epoch ASC
    `;

    const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...observationScope.params) as ObservationRecord[];
    const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...summaryScope.params) as SessionSummaryRecord[];
    const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...promptScope.params) as UserPromptRecord[];

    return {
      observations,
      sessions: sessions.map(s => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map(p => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        platform_source: p.platform_source,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }

  getOrCreateManualSession(project: string): string {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { memory_session_id: string } | undefined;

    if (existing) {
      return memorySessionId;
    }

    const now = new Date();
    this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(memorySessionId, contentSessionId, project, DEFAULT_PLATFORM_SOURCE, now.toISOString(), now.getTime());

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });

    return memorySessionId;
  }

  close(): void {
    this.db.close();
  }

  importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source?: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): { imported: boolean; id: number } {
    const normalizedPlatformSource = normalizePlatformSource(session.platform_source);
    const existing = this.db.prepare(
      `SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`
    ).get(normalizedPlatformSource, session.content_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
	      session.content_session_id,
	      session.memory_session_id,
	      session.project,
	      normalizedPlatformSource,
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  importSessionSummary(summary: {
    memory_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(
      'SELECT id FROM session_summaries WHERE memory_session_id = ?'
    ).get(summary.memory_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.memory_session_id,
      summary.project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.files_read,
      summary.files_edited,
      summary.notes,
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  importObservation(obs: {
    memory_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
    agent_type?: string | null;
    agent_id?: string | null;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, obs.title, obs.created_at_epoch) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.memory_session_id,
      obs.project,
      obs.text,
      obs.type,
      obs.title,
      obs.subtitle,
      obs.facts,
      obs.narrative,
      obs.concepts,
      obs.files_read,
      obs.files_modified,
      obs.prompt_number,
      obs.discovery_tokens || 0,
      obs.agent_type ?? null,
      obs.agent_id ?? null,
      obs.created_at,
      obs.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  rebuildObservationsFTSIndex(): void {
    const hasFTS = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as { name: string }[]).length > 0;

    if (!hasFTS) {
      return;
    }

    this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }

  importUserPrompt(prompt: {
    session_db_id?: number | null;
    content_session_id: string;
    platform_source?: string | null;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    let sessionDbId: number | null = null;
    const normalizedPlatformSource = prompt.platform_source
      ? normalizePlatformSource(prompt.platform_source)
      : undefined;

    if (typeof prompt.session_db_id === 'number') {
      const explicitSession = this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(prompt.session_db_id) as { id: number; content_session_id: string; platform_source: string } | undefined;

      if (
        explicitSession
        && explicitSession.content_session_id === prompt.content_session_id
        && (!normalizedPlatformSource || normalizePlatformSource(explicitSession.platform_source) === normalizedPlatformSource)
      ) {
        sessionDbId = explicitSession.id;
      }
    }

    if (sessionDbId === null) {
      sessionDbId = this.resolvePromptSessionDbId(
        prompt.content_session_id,
        undefined,
        normalizedPlatformSource
      );
    }

    const existing = this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${sessionDbId !== null ? 'session_db_id = ?' : 'content_session_id = ?'} AND prompt_number = ?
    `).get(sessionDbId ?? prompt.content_session_id, prompt.prompt_number) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      sessionDbId,
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }
}
