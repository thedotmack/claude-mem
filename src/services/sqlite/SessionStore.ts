import { emitContextInvalidation } from '../../shared/context-invalidation.js';
import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { DATA_DIR, DB_PATH, ensureDir, OBSERVER_SESSIONS_PROJECT, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ProjectKeySource } from '../../utils/project-name.js';
import { projectReadKeys, projectScopeSql, scopedProjects } from './project-read-keys.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  AdvisorCallRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from './types.js';
import { computeObservationContentHash, hasStorableTitle } from './observations/store.js';
import { seedReinforcement, reinforceObservation } from '../reinforcement/persist.js';
import {
  createToolUsesSchema,
  upsertToolUse as upsertToolUseRow,
  linkToolUsesToObservation as linkToolUsesToObservationRows,
  getToolUsesByIds as getToolUsesByIdsRows,
  queryToolUses as queryToolUsesRows,
  countToolUses as countToolUsesRows,
  type ToolUseRow,
  type UpsertToolUseInput,
  type ToolUseQueryFilters,
} from './tool-uses.js';
import {
  createWorkStateSchema,
  appendWorkStateEntry as appendWorkStateEntryRow,
  getWorkStateEntries as getWorkStateEntriesRows,
  type WorkStateEntry,
  type WorkStateFields,
} from './work-state.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import {
  computeTitleNormKey, findTier0Canonical, bumpTokenDf, isFuzzyReady, recordTier1Candidates,
  runDedupScan as runDedupScanAll,
  type DedupRuntimeConfig,
} from './dedup-store.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
import { isSubagentEvent } from '../../shared/subagent-predicate.js';
import { findRecentDuplicateUserPrompt as findRecentDuplicateUserPromptRecord } from './prompts/get.js';
import { normalizeStoredPromptText, MEDIA_PROMPT_PLACEHOLDER } from './prompt-storage.js';
import { applySqliteConnectionPragmas } from './connection.js';
import { streamRows } from './stream-rows.js';
import { OBSERVATIONS_FTS_TRIGGERS_SQL, SESSION_SUMMARIES_FTS_TRIGGERS_SQL } from './SessionSearch.js';
import {
  assertCanonicalDecimal,
  incrementCanonicalDecimal,
  validateCanonicalMutation,
  type CanonicalMutation,
} from '../sync/CanonicalContent.js';

// A Telegram send normally completes in seconds. A five-minute lease absorbs
// a slow request while allowing a later SessionEnd delivery to recover work
// abandoned by a process crash between claiming and marking the row sent.
export const TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS = 5 * 60_000;

/**
 * Coerce a value to something bun:sqlite can bind. The cloud/export shape
 * (CloudSync `toCloud`) carries columns like facts/concepts/files_read as real
 * arrays, but locally they are stored as JSON strings. bun's driver rejects
 * arrays/objects with "Binding expected string, TypedArray, boolean, number,
 * bigint or null", so re-stringify any non-primitive right before binding.
 */
const coerceBindValue = <T>(value: T): T | string | null =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : value ?? null;

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

/** Roll observation file lists into session_summaries.files_read / files_edited. */
export function rollupObservationFileLists(
  observations: Array<{ files_read?: string[] | null; files_modified?: string[] | null }>
): { files_read: string[]; files_edited: string[] } {
  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const seenRead = new Set<string>();
  const seenEdited = new Set<string>();

  for (const observation of observations) {
    for (const filePath of observation.files_read ?? []) {
      if (!filePath || seenRead.has(filePath)) continue;
      seenRead.add(filePath);
      filesRead.push(filePath);
    }
    for (const filePath of observation.files_modified ?? []) {
      if (!filePath || seenEdited.has(filePath)) continue;
      seenEdited.add(filePath);
      filesEdited.push(filePath);
    }
  }

  return { files_read: filesRead, files_edited: filesEdited };
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

export interface SessionStoreOptions {
  /**
   * Whether this store may enqueue mutation ops into sync_outbox. The only
   * consumer of that queue is CloudSync's drain, and DatabaseManager
   * constructs CloudSync iff cloud sync is fully credentialed — so the
   * worker bootstrap passes the same configuration state here, and an
   * unconfigured install produces no ops it can never drain. Defaults to
   * true (the pre-flag behavior) for direct constructions that never wire
   * the flag.
   */
  syncOpsEnabled?: boolean;
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
  observed_model: string | null;
  observed_billing: string | null;
}

export interface SessionCatalogRow {
  content_session_id: string;
  project: string;
  platform_source: string;
  custom_title: string | null;
  started_at_epoch: number;
  item_count: number;
}

const SESSION_CATALOG_DEFAULT_LIMIT = 200;
const SESSION_CATALOG_MAX_LIMIT = 1000;

/** #3038 near-duplicate dedup tables/columns. v50–55 are taken on main (v53: sdk_sessions.cwd, #3525; v54: FTS trigger scoping, #3284; v55: NOCASE project indexes, #3536). */
const DEDUP_SCHEMA_VERSION = 56;

/** ACT-R reinforcement columns (v56 is the dedup tables above, v58 advisor_calls). */
const REINFORCEMENT_SCHEMA_VERSION = 57;

export class SessionStore {
  public db: Database;
  private readonly syncOpsEnabled: boolean;
  /** See cachedStatement. Keyed by SQL text; only fixed SQL ever goes in. */
  private readonly statementCache = new Map<string, Statement>();

  constructor(dbPathOrDb: string | Database = DB_PATH, options: SessionStoreOptions = {}) {
    this.syncOpsEnabled = options.syncOpsEnabled ?? true;
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
    this.ensureSDKSessionsObservedColumns();
    this.ensureToolUsesTable();
    this.ensureTelegramWrapupsTable();
    this.addDedupTables();
    this.ensureReinforcementColumns();
    this.ensureSessionCwdColumn();
    this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers();
    this.ensureProjectNocaseIndexes();
    this.ensureAdvisorCallsTable();
    this.ensureSessionProjectKeySourceColumn();
    this.requeuePromptsDeadLetteredForSize();
    this.ensureWorkStateTable();
    this.ensureHookSpoolConsumedTable();
    this.ensureProjectRecencyIndexes();
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

  // #3038 near-duplicate dedup: occurrence_count (Tier-0 merge bump), per-project
  // token document-frequency (IDF model), dedup bookkeeping, and the Tier-1
  // review-only candidates table. Pure DDL; the IDF model is filled forward on
  // insert and (re)built by the opt-in dedup-scan, never a JS backfill here.
  private addDedupTables(): void {

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    if (!obsCols.some(c => c.name === 'occurrence_count')) {
      this.db.run('ALTER TABLE observations ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1');
    }
    // Precomputed exact-normalized-title key for O(1) Tier-0 lookup (SQLite can't
    // express the normalization itself). NON-unique index — dedup stays app-gated
    // on CLAUDE_MEM_DEDUP_ENABLED so disabled = byte-identical legacy behavior.
    if (!obsCols.some(c => c.name === 'title_norm_key')) {
      this.db.run('ALTER TABLE observations ADD COLUMN title_norm_key TEXT');
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_title_norm ON observations(project, title_norm_key)');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS token_df (
        project TEXT    NOT NULL,
        token   TEXT    NOT NULL,
        df      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project, token)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS dedup_meta (
        project                TEXT    PRIMARY KEY,
        doc_count              INTEGER NOT NULL DEFAULT 0,
        last_rebuild_doc_count INTEGER NOT NULL DEFAULT 0,
        deleted_since_rebuild  INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_dedup_candidates (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id   INTEGER NOT NULL,
        duplicate_of_id  INTEGER NOT NULL,
        project          TEXT    NOT NULL,
        method           TEXT    NOT NULL CHECK(method IN ('exact', 'idf_cosine')),
        score            REAL    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending'
                                 CHECK(status IN ('pending', 'merged', 'distinct', 'dismissed')),
        created_at       TEXT    NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        metadata         TEXT,
        FOREIGN KEY (observation_id)  REFERENCES observations(id) ON DELETE CASCADE,
        FOREIGN KEY (duplicate_of_id) REFERENCES observations(id) ON DELETE CASCADE,
        UNIQUE(observation_id, duplicate_of_id)
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)');

    // Every statement above is PRAGMA/IF NOT EXISTS guarded, so the version row
    // is bookkeeping only (v36 was consumed by the community-edge line).
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(DEDUP_SCHEMA_VERSION, new Date().toISOString());
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
      this.rebuildUserPromptsWithSessionDbId(applied, sessionDbIdSelect);
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

  private rebuildUserPromptsWithSessionDbId(applied: SchemaVersion | undefined, sessionDbIdSelect: string): void {
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

    // The prompt FTS triggers dropped above are not recreated: user_prompts_fts is write-only
    // and v54 drops it (dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers).

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

        for (const raw of streamRows(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${target.column}) AS storage_type,
                 CAST(${target.column} AS TEXT) AS revision
          FROM ${target.table}
        `))) {
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
    // Pull-side counterpart: hub ops this device can never apply (malformed,
    // equal-revision hash conflict, violated constraint), set aside by
    // SyncApply so the cursor moves past them instead of wedging. retryable
    // = 1 marks constraint violations SyncApply re-tries after each batch.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_pull_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch TEXT NOT NULL,
        seq TEXT NOT NULL,
        kind TEXT,
        entity_id TEXT,
        origin_device_id TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        operation_sha256 TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(epoch, seq)
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

  /**
   * Live FK clause, not the schema_versions row: a later table rebuild can
   * strip ON UPDATE CASCADE after v21 was already stamped (#3849).
   */
  private hasMemorySessionIdOnUpdateCascade(table: 'observations' | 'session_summaries'): boolean {
    const fks = this.db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      from: string;
      on_update: string;
    }>;
    return fks.some(fk =>
      fk.table === 'sdk_sessions' &&
      fk.from === 'memory_session_id' &&
      fk.on_update === 'CASCADE'
    );
  }

  /**
   * After CREATE TABLE <newTable> from a fixed historical column list, add
   * every live source column that list omitted (type and DEFAULT included)
   * and return the full copy order. Same discipline as the v7 rebuild (#3890)
   * so a repair of an already-migrated database cannot drop later columns.
   */
  private carryLiveColumnsOntoNewTable(
    sourceTable: string,
    newTable: string,
    knownColumns: string[]
  ): string[] {
    const liveColumns = this.db.query(`PRAGMA table_info(${sourceTable})`).all() as TableColumnInfo[];
    const extraColumns = liveColumns.filter(col => !knownColumns.includes(col.name));
    for (const col of extraColumns) {
      const type = col.type ? ` ${col.type}` : '';
      const dflt = col.dflt_value === null || col.dflt_value === undefined ? '' : ` DEFAULT ${col.dflt_value}`;
      this.db.run(`ALTER TABLE ${newTable} ADD COLUMN "${col.name}"${type}${dflt}`);
      logger.debug('DB', `Carried ${col.name} over the ${sourceTable} rebuild (#3849)`);
    }
    // Copy only columns the source actually has. Known CREATE columns that
    // the live table never grew (e.g. v8 hierarchical fields) stay at their
    // new-table defaults instead of failing the SELECT.
    return liveColumns.map(col => col.name);
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

    // The DDL below is the v7 column set. Fresh installs stamp every
    // migration at once, so a database whose base schema already carried a
    // later column (v11's discovery_tokens) next to the v7 UNIQUE constraint
    // lost that column here, and its ADD COLUMN migration never re-ran:
    // every summary write failed with "no column named discovery_tokens"
    // from then on (#3890). Carry the live table's extra columns over,
    // type and default included, so no later column is dropped again.
    const v7Columns = [
      'id', 'memory_session_id', 'project', 'request', 'investigated', 'learned',
      'completed', 'next_steps', 'files_read', 'files_edited', 'notes',
      'prompt_number', 'created_at', 'created_at_epoch',
    ];
    const liveColumns = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const extraColumns = liveColumns.filter(col => !v7Columns.includes(col.name));

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
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    for (const col of extraColumns) {
      const type = col.type ? ` ${col.type}` : '';
      const dflt = col.dflt_value === null || col.dflt_value === undefined ? '' : ` DEFAULT ${col.dflt_value}`;
      this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${col.name}"${type}${dflt}`);
      logger.debug('DB', `Carried ${col.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`);
    }

    const copyColumns = [...v7Columns, ...extraColumns.map(col => col.name)]
      .map(name => `"${name}"`)
      .join(', ');
    this.db.run(`
      INSERT INTO session_summaries_new (${copyColumns})
      SELECT ${copyColumns}
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
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
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

    logger.debug('DB', 'Creating user_prompts table');

    // No FTS index: prompts are searched by substring (searchUserPrompts), so an index would
    // only be written, never read (see dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers).
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
    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

    logger.debug('DB', 'Successfully created user_prompts table');
  }

  private ensureDiscoveryTokensColumn(): void {
    // Not gated on the schema_versions row: a table rebuild that ran after
    // version 11 was stamped could have dropped the column again (#3890),
    // and the PRAGMA presence checks below are idempotent anyway.
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
    // Introspection, not the version row: v7 (and v9) can rebuild these
    // tables after v21 is already stamped and silently drop ON UPDATE
    // CASCADE. The live FK clause is the only reliable guard (#3849).
    const observationsNeedsCascade = !this.hasMemorySessionIdOnUpdateCascade('observations');
    const summariesNeedsCascade = !this.hasMemorySessionIdOnUpdateCascade('session_summaries');

    if (!observationsNeedsCascade && !summariesNeedsCascade) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.run('BEGIN TRANSACTION');

    const observationsKnownColumns = [
      'id', 'memory_session_id', 'project', 'text', 'type', 'title', 'subtitle',
      'facts', 'narrative', 'concepts', 'files_read', 'files_modified',
      'prompt_number', 'discovery_tokens', 'created_at', 'created_at_epoch',
    ];
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
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const observationsIndexesSQL = `
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `;
    const summariesKnownColumns = [
      'id', 'memory_session_id', 'project', 'request', 'investigated', 'learned',
      'completed', 'next_steps', 'files_read', 'files_edited', 'notes',
      'prompt_number', 'discovery_tokens', 'created_at', 'created_at_epoch',
    ];
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
    const summariesIndexesSQL = `
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `;

    try {
      if (observationsNeedsCascade) {
        this.db.run('DROP TRIGGER IF EXISTS observations_ai');
        this.db.run('DROP TRIGGER IF EXISTS observations_ad');
        this.db.run('DROP TRIGGER IF EXISTS observations_au');
        this.db.run('DROP TABLE IF EXISTS observations_new');
        this.recreateObservationsWithCascade(
          observationsNewSQL,
          observationsKnownColumns,
          observationsIndexesSQL,
          OBSERVATIONS_FTS_TRIGGERS_SQL
        );
      }
      if (summariesNeedsCascade) {
        this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
        this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
        this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');
        this.db.run('DROP TABLE IF EXISTS session_summaries_new');
        this.recreateSessionSummariesWithCascade(
          summariesNewSQL,
          summariesKnownColumns,
          summariesIndexesSQL,
          SESSION_SUMMARIES_FTS_TRIGGERS_SQL
        );
      }

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

  private recreateObservationsWithCascade(
    createSQL: string,
    knownColumns: string[],
    indexesSQL: string,
    ftsTriggersSQL: string
  ): void {
    this.db.run(createSQL);
    const copyColumns = this.carryLiveColumnsOntoNewTable('observations', 'observations_new', knownColumns);
    const quoted = copyColumns.map(name => `"${name}"`).join(', ');
    this.db.run(`INSERT INTO observations_new (${quoted}) SELECT ${quoted} FROM observations`);
    this.db.run('DROP TABLE observations');
    this.db.run('ALTER TABLE observations_new RENAME TO observations');
    this.db.run(indexesSQL);

    const hasFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all() as { name: string }[]).length > 0;
    if (hasFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private recreateSessionSummariesWithCascade(
    createSQL: string,
    knownColumns: string[],
    indexesSQL: string,
    ftsTriggersSQL: string
  ): void {
    this.db.run(createSQL);
    const copyColumns = this.carryLiveColumnsOntoNewTable('session_summaries', 'session_summaries_new', knownColumns);
    const quoted = copyColumns.map(name => `"${name}"`).join(', ');
    this.db.run(`INSERT INTO session_summaries_new (${quoted}) SELECT ${quoted} FROM session_summaries`);
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

  // Identity of the OBSERVED IDE session (the model the user ran and its
  // billing posture), reported by the Stop hook. Distinct from
  // observations.generated_by_model, which is the observer model.
  private ensureSDKSessionsObservedColumns(): void {
    const columns = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasObservedModel = columns.some(col => col.name === 'observed_model');
    const hasObservedBilling = columns.some(col => col.name === 'observed_billing');

    if (hasObservedModel && hasObservedBilling) return;

    if (!hasObservedModel) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT');
    }
    if (!hasObservedBilling) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(50, new Date().toISOString());
  }

  // v51 — durable `tool_uses` backup index for raw tool I/O.
  //
  // `pending_messages` stays exactly what it is (the generation queue, drained
  // and deleted); this table is the side index that survives it, so mem-search
  // can disclose a tool body by reference and Receipt can COUNT usages without
  // re-parsing transcripts. Not gated on the version row alone: the DDL is
  // idempotent, so a DB that was created fresh (table already present) and one
  // migrating up both converge, and a fixture that deliberately drops the row
  // re-runs harmlessly.
  private ensureToolUsesTable(): void {
    createToolUsesSchema(this.db);
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(51, new Date().toISOString());
  }

  // v61 — the agent's to-do lists and working state (./work-state.ts). Idempotent
  // DDL like v51, so fresh and migrating databases converge.
  private ensureWorkStateTable(): void {
    createWorkStateSchema(this.db);
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(61, new Date().toISOString());
  }

  // v63 — SessionStart reads the newest N rows per project key. Ordered
  // (key COLLATE NOCASE, created_at_epoch DESC) indexes let each key's scan stop
  // after N rows; the single-column v55 indexes made SQLite fetch every row of
  // the project and sort them (~21k rows / 63 MB per SessionStart on a large db).
  private ensureProjectRecencyIndexes(): void {
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)');
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(63, new Date().toISOString());
  }

  // v62 — exactly-once hand-off marker for hook spool entries (HookSpool.drain):
  // written the moment ingest irrevocably accepts an entry, cleared once its file is gone.
  private ensureHookSpoolConsumedTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS hook_spool_consumed (
        entry_key TEXT PRIMARY KEY,
        consumed_at_epoch_ms INTEGER NOT NULL
      )
    `);
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(62, new Date().toISOString());
  }

  isHookSpoolEntryConsumed(entryKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM hook_spool_consumed WHERE entry_key = ?').get(entryKey) != null;
  }

  markHookSpoolEntryConsumed(entryKey: string, consumedAtEpochMs: number): void {
    this.db.prepare(
      'INSERT INTO hook_spool_consumed (entry_key, consumed_at_epoch_ms) VALUES (?, ?) ON CONFLICT(entry_key) DO UPDATE SET consumed_at_epoch_ms = excluded.consumed_at_epoch_ms'
    ).run(entryKey, consumedAtEpochMs);
  }

  clearHookSpoolEntryConsumed(entryKey: string): void {
    this.db.prepare('DELETE FROM hook_spool_consumed WHERE entry_key = ?').run(entryKey);
  }

  pruneHookSpoolConsumedMarkersBefore(epochMs: number): void {
    this.db.prepare('DELETE FROM hook_spool_consumed WHERE consumed_at_epoch_ms < ?').run(epochMs);
  }

  // v52 — durable claim ledger for one Telegram session wrap-up per route.
  // The DDL is intentionally idempotent so fresh installs and existing DBs
  // converge even if a fixture has an incomplete schema_versions ledger.
  private ensureTelegramWrapupsTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_wrapups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        route_key TEXT NOT NULL,
        summary_created_at_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed', 'sent')),
        claimed_at_epoch INTEGER NOT NULL,
        sent_at_epoch INTEGER,
        UNIQUE(platform_source, content_session_id, project, route_key)
      )
    `);
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)'
    );
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(52, new Date().toISOString());
  }

  /**
   * ACT-R reinforcement history for observations (opt-in ranking, see
   * src/services/reinforcement):
   *   - reinforcement_dates: JSON array of ISO `YYYY-MM-DD` days the
   *     observation was (re-)confirmed, seeded with its creation day
   *   - last_reinforced: the most recent of those days
   * Device-local, like relevance_count. No backfill: a NULL history ranks on
   * its creation time alone. The PRAGMA checks are the guard; the version row
   * is bookkeeping, so a DB that already recorded it still gets the columns.
   */
  private ensureReinforcementColumns(): void {
    const columns = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    if (!columns.some(col => col.name === 'reinforcement_dates')) {
      this.db.run('ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT');
    }
    if (!columns.some(col => col.name === 'last_reinforced')) {
      this.db.run('ALTER TABLE observations ADD COLUMN last_reinforced TEXT');
    }
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(REINFORCEMENT_SCHEMA_VERSION, new Date().toISOString());
  }

  // v54 — stop FTS5 shadow-index bloat at the source (plan-21, #2793).
  //
  // 1. observations_au / session_summaries_au become column-scoped (AFTER UPDATE OF the
  //    indexed columns). Unscoped, every bookkeeping update (sync_rev, merged_into_project,
  //    content_hash, session_db_id, ...) appended a delete marker plus a full re-insert of the
  //    row's text to the index.
  // 2. user_prompts_fts and its three triggers are dropped: prompt search uses LIKE and nothing
  //    reads the index, yet every prompt write grew it (the 12 GB table in #2793).
  //
  // Introspection-driven and idempotent, like v51/v52, so a later table rebuild that recreated
  // an old-style trigger converges again on the next start.
  private dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(): void {
    const unscopedUpdateTriggers = (this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all() as { name: string }[]).map(row => row.name);
    const userPromptsFtsObjects = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all() as { name: string }[];

    if (unscopedUpdateTriggers.length > 0 || userPromptsFtsObjects.length > 0) {
      this.db.run('BEGIN TRANSACTION');
      try {
        if (unscopedUpdateTriggers.includes('observations_au')) {
          this.db.run('DROP TRIGGER observations_au');
          this.db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
        }
        if (unscopedUpdateTriggers.includes('session_summaries_au')) {
          this.db.run('DROP TRIGGER session_summaries_au');
          this.db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
        }
        this.db.run('DROP TRIGGER IF EXISTS user_prompts_ai');
        this.db.run('DROP TRIGGER IF EXISTS user_prompts_ad');
        this.db.run('DROP TRIGGER IF EXISTS user_prompts_au');
        this.db.run('DROP TABLE IF EXISTS user_prompts_fts');
        this.db.run('COMMIT');
      } catch (error) {
        this.db.run('ROLLBACK');
        logger.error('DB', 'Failed to scope FTS update triggers / drop user_prompts_fts, rolled back', {}, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      logger.info('DB', 'Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts', {
        rescopedTriggers: unscopedUpdateTriggers,
        droppedUserPromptsFts: userPromptsFtsObjects.length > 0,
      });
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(54, new Date().toISOString());
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

  // v60 — re-queue prompts dead-lettered for size before #3537's clamp. A
  // prompt whose canonical body passed CONTENT_BODY_MAX_BYTES was quarantined
  // (synced_at = -1 plus a sync_dead_letter row), and the drain reads
  // synced_at IS NULL only, so it never synced again. The drain now bounds
  // prompt_text (prompt-text-clamp.ts), so those prompts fit: re-null them
  // and drop their size dead-letter rows, once. Native rows only; a prompt
  // quarantined for any other reason keeps its quarantine.
  private requeuePromptsDeadLetteredForSize(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(60);
    if (applied) return;
    const sizeReason = "canonical content: body exceeds % UTF-8 bytes";
    this.db.transaction(() => {
      const requeued = this.db.prepare(`
        UPDATE user_prompts SET synced_at = NULL
        WHERE synced_at = -1 AND origin_device_id IS NULL
          AND CAST(id AS TEXT) IN (
            SELECT origin_local_id FROM sync_dead_letter
            WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
          )
      `).run(sizeReason);
      this.db.prepare(`
        DELETE FROM sync_dead_letter WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
      `).run(sizeReason);
      if (requeued.changes > 0) {
        logger.info('DB', 'Re-queued prompts quarantined for size before the cloud-sync prompt clamp', {
          prompts: requeued.changes,
        });
      }
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(60, new Date().toISOString());
    })();
  }

  // v59 — sdk_sessions.project_key_source: how the session's project key was
  // derived ('path' | 'git-remote' | 'environment'), recorded with its checkout
  // (cwd). Worktree adoption treats a checkout that no longer exists as a
  // deleted worktree only for a folder-derived key: a slug or an environment
  // name is not tied to one folder (gate P1-2). Local-only, like cwd. Runs last,
  // after v33's sdk_sessions rebuild, for the reason given at v53 below.
  private ensureSessionProjectKeySourceColumn(): void {
    const cols = this.db
      .query('PRAGMA table_info(sdk_sessions)')
      .all() as TableColumnInfo[];
    if (!cols.some(c => c.name === 'project_key_source')) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN project_key_source TEXT');
      logger.debug('DB', 'Added project_key_source column to sdk_sessions table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(59, new Date().toISOString());
  }

  // v53 — sdk_sessions.cwd. Worktree adoption discovers repos from this;
  // sdk_sessions is local-only, so no sync-lane plumbing (#2864).
  //
  // Runs LAST in the constructor, after every migration that rebuilds
  // sdk_sessions from a fixed column list (v33's composite-identity rebuild):
  // added any earlier, a pre-v33 database would lose the column in that
  // rebuild and every ingest would then fail on setSessionCwd.
  private ensureSessionCwdColumn(): void {
    const cols = this.db
      .query('PRAGMA table_info(sdk_sessions)')
      .all() as TableColumnInfo[];
    if (!cols.some(c => c.name === 'cwd')) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN cwd TEXT');
      logger.debug('DB', 'Added cwd column to sdk_sessions table (#2864)');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_sdk_sessions_cwd ON sdk_sessions(cwd)'
    );

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(53, new Date().toISOString());
  }

  // v55 — #3531: retrieval compares `project`/`merged_into_project` with COLLATE
  // NOCASE, so checkouts whose directory names differ only in case read one
  // bucket. Stored keys are NOT rewritten (no re-key, nothing to remap for
  // cloud sync). The BINARY indexes cannot serve a NOCASE predicate, so these
  // keep the hot read paths on an index seek. Runs last: v33 rebuilds
  // sdk_sessions and would drop an index created on the old table.
  private ensureProjectNocaseIndexes(): void {
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_project_nocase ON observations(project COLLATE NOCASE)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase ON observations(merged_into_project COLLATE NOCASE)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase ON session_summaries(project COLLATE NOCASE)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase ON session_summaries(merged_into_project COLLATE NOCASE)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase ON sdk_sessions(project COLLATE NOCASE)');
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(55, new Date().toISOString());
  }

  // v58 — advisor_calls: a durable, verbatim record of every `advisor` tool
  // call. The advisor is a server-side tool (server_tool_use in the
  // transcript): it never fires PostToolUse and never enters the observation
  // pipeline, so rows come from the Stop hook's transcript scan (see
  // shared/advisor-transcript.ts) via POST /api/advisor-calls, and only when
  // CLAUDE_MEM_CAPTURE_ADVISOR_CALLS is on. The advice is stored in full; the
  // forwarded context is not (it already lives in the transcript), only a
  // pointer to it (transcript path + byte offset) and the turn's user message.
  // tool_use_id is UNIQUE so replayed scans are no-ops. Local only: not synced.
  //
  // Guarded by introspection (CREATE ... IF NOT EXISTS) like the other late
  // migrations, and runs last so no older sdk_sessions rebuild can drop it.
  private ensureAdvisorCallsTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS advisor_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        advisor_model TEXT,
        cwd TEXT,
        last_user_message TEXT,
        transcript_path TEXT,
        transcript_byte_offset INTEGER,
        advice TEXT NOT NULL,
        occurred_at_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_calls_tool_use ON advisor_calls(tool_use_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_advisor_calls_session ON advisor_calls(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_advisor_calls_project ON advisor_calls(project)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_advisor_calls_occurred ON advisor_calls(occurred_at_epoch DESC)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(58, new Date().toISOString());
  }

  /**
   * Insert an advisor call; a duplicate tool_use_id (replayed transcript
   * scan, re-fired Stop hook) is ignored. Returns the row id and whether
   * this call actually inserted it.
   */
  recordAdvisorCall(input: {
    sessionDbId: number;
    contentSessionId: string;
    project: string;
    platformSource: string;
    toolUseId: string;
    advisorModel?: string | null;
    cwd?: string | null;
    lastUserMessage?: string | null;
    transcriptPath?: string | null;
    transcriptByteOffset?: number | null;
    advice: string;
    occurredAtEpoch: number;
  }): { id: number; inserted: boolean } {
    const now = new Date();

    const result = this.db.prepare(`
      INSERT OR IGNORE INTO advisor_calls
      (session_db_id, content_session_id, project, platform_source, tool_use_id, advisor_model, cwd, last_user_message, transcript_path, transcript_byte_offset, advice, occurred_at_epoch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionDbId,
      input.contentSessionId,
      input.project,
      input.platformSource,
      input.toolUseId,
      input.advisorModel ?? null,
      input.cwd ?? null,
      input.lastUserMessage ?? null,
      input.transcriptPath ?? null,
      input.transcriptByteOffset ?? null,
      input.advice,
      input.occurredAtEpoch,
      now.toISOString(),
      now.getTime()
    );

    if (result.changes > 0) {
      return { id: Number(result.lastInsertRowid), inserted: true };
    }

    const existing = this.db.prepare('SELECT id FROM advisor_calls WHERE tool_use_id = ?').get(input.toolUseId) as { id: number } | undefined;
    return { id: existing?.id ?? 0, inserted: false };
  }

  getAdvisorCalls(offset: number, limit: number, project?: string, platformSource?: string): { items: AdvisorCallRecord[]; hasMore: boolean; offset: number; limit: number } {
    let query = 'SELECT * FROM advisor_calls';
    const params: SQLQueryBindings[] = [];
    const conditions: string[] = [];

    if (project) {
      conditions.push('project = ?');
      params.push(project);
    } else {
      conditions.push('project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }
    if (platformSource) {
      conditions.push('platform_source = ?');
      params.push(platformSource);
    }
    query += ` WHERE ${conditions.join(' AND ')}`;

    query += ' ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const results = this.db.prepare(query).all(...params) as AdvisorCallRecord[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  getAdvisorCallById(id: number): AdvisorCallRecord | null {
    const row = this.db.prepare('SELECT * FROM advisor_calls WHERE id = ?').get(id) as AdvisorCallRecord | undefined;
    return row ?? null;
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
    const current = this.db.prepare(`
      SELECT memory_session_id
      FROM sdk_sessions
      WHERE id = ?
    `).get(sessionDbId) as { memory_session_id: string | null } | undefined;

    if (!current || current.memory_session_id === memorySessionId) return;

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
   *
   * Producer gate: acked ops are DELETEd by CloudSync's drain — the queue's
   * ONLY retention path — and CloudSync exists iff cloud sync is fully
   * credentialed. With syncOpsEnabled false (unconfigured install) this
   * no-ops instead of growing sync_outbox forever.
   *
   * Supersede, don't append (set_prompt_session): every session
   * re-registration re-emits the repair for EVERY prompt in the session
   * (requeuePromptSync), and the mutation site bumps the prompt's sync_rev
   * before each enqueue — so per target the newest op always carries the
   * complete field set at the highest rev, and a still-queued older op is
   * dead weight. Replicas apply by the op.rev >= row sync_rev guard, so
   * dropping an unsent superseded op cannot regress them; one already pushed
   * (ack lost mid-flight) is ordered before the newer op in the hub log and
   * converges the same way. This bounds the outbox at one
   * set_prompt_session row per prompt regardless of re-registration count.
   *
   * Its statements are cached (cachedStatement): requeuePromptSync calls this
   * once per prompt.
   */
  private enqueueMutationOp(rev: string | number, body: CanonicalMutation): void {
    if (!this.syncOpsEnabled) return;
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
    if (body.op === 'set_prompt_session') {
      // json_valid guards tampered rows from aborting the enqueue (the v49
      // precedent); every writer stores JSON.stringify output. No rev guard:
      // the sync_rev bump above each enqueue makes revs monotonic per
      // target, so the incoming op always supersedes what is queued.
      this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(
        (body.target?.origin_device_id ?? null) as string | null,
        String(body.target?.origin_local_id ?? ''),
      );
    }
    this.cachedStatement(`
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
   *
   * With sync ops disabled the whole repair is skipped: the bump + re-null
   * exist only so already-pushed rows re-push corrected, nothing pushes
   * without CloudSync, and a prompt that first syncs after a later
   * enablement resolves its session join fields at snapshot time anyway
   * (the drain SELECT joins sdk_sessions). Skipping also keeps v47
   * launch-baseline rows excluded instead of promoting them into sync
   * eligibility via the rev bump.
   */
  private requeuePromptSync(sessionDbId: number): void {
    if (!this.syncOpsEnabled) return;
    // Cached statements throughout (cachedStatement): this runs on every
    // session registration, once per prompt inside the loop below.
    const session = this.cachedStatement(`
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
      const prompts = this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(sessionDbId) as Array<{ id: string; sync_rev: string }>;
      if (prompts.length === 0) return;

      const bumpPromptRev = this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);
      for (const prompt of prompts) {
        const nextRev = incrementCanonicalDecimal(prompt.sync_rev);
        bumpPromptRev.run(nextRev, prompt.id);
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

  /**
   * Put a completed row back to 'active' because the session it labels carried
   * on (#4080).
   *
   * `markSessionCompleted` above is the only writer of `status`, and it only
   * ever writes 'completed'; `finalizeSession` returns early on every later
   * end once it reads that. So a session that continues after a finalize — a
   * `claude --resume`, or one finalized while it was still live — keeps the
   * FIRST end's `completed_at` for the rest of its life while new prompts land
   * under the same row. Every reader of `status` is then wrong about it:
   * SearchManager prints **In Progress** only for 'active', and anything
   * counting sessions by status counts this one at an end it has already
   * passed.
   *
   * Guarded on `status = 'completed'`, so it is a no-op for a row that is
   * already active, and it clears BOTH completion stamps — leaving the row
   * active with a stale `completed_at` would trade one wrong label for
   * another. sdk_sessions rows do not sync, so there is no op to enqueue.
   */
  reopenCompletedSession(sessionDbId: number): void {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', completed_at = NULL, completed_at_epoch = NULL
      WHERE id = ? AND status = 'completed'
    `).run(sessionDbId);
  }

  ensureMemorySessionIdRegistered(
    sessionDbId: number,
    memorySessionId: string,
    workerPort?: number
  ): string {
    const session = this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as { id: number; memory_session_id: string | null; worker_port: number | null } | undefined;

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    // REGISTER, DO NOT RE-REGISTER. `memory_session_id` is the FK parent key of
    // `observations` and `session_summaries` (ON UPDATE CASCADE) and the join
    // field `requeuePromptSync` pushes to replicas, so overwriting it is not a
    // field update — it rewrites every memory the session owns and re-enqueues
    // every prompt it has.
    //
    // The caller that made this matter is ClaudeProvider: a fresh SDK process
    // mints a new session_id every turn, `resetCarriedMemorySessionId` clears the
    // in-memory copy before each one, and nothing consumes a later turn's id
    // (`shouldResume` is a hardcoded false, so `resume` never receives it). The
    // condition below used to be `!==`, so every turn looked like a new identity.
    //
    // MEASURED on one store: sync_outbox held 1,100,783 rows for 6,930 distinct
    // prompts — 158.8x, 393 MB of an 854 MB database — with its worst single
    // prompt carrying 3,464 rows and 3,464 DISTINCT memory_session_ids. That is
    // `requeuePromptSync`, whose own docstring describes a one-time repair
    // ("Once the mapping lands"), running once per turn per prompt instead.
    //
    // A deliberate change of identity is still available through
    // `updateMemorySessionId`. "Ensure registered" means make sure one exists.
    if (session.memory_session_id === null) {
      this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(memorySessionId, sessionDbId);
      this.requeuePromptSync(sessionDbId);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        newId: memorySessionId
      });
    } else if (session.memory_session_id !== memorySessionId) {
      logger.debug('DB', 'Keeping the registered memory_session_id', {
        sessionDbId,
        registered: session.memory_session_id,
        offered: memorySessionId
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

    return session.memory_session_id ?? memorySessionId;
  }

  /**
   * Every stored key a read of `projects` has to match: their stored spellings
   * (#3531) and the projects merged into them, one hop (gate P2-4). Search
   * hands these to Chroma, which compares metadata exactly, and to SQLite.
   */
  getProjectReadKeys(projects: string[]): string[] {
    return projectReadKeys(this.db, projects);
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

  /**
   * Session catalog for the viewer's Sessions view: newest first, one row per
   * (platform_source, content_session_id), with the session's combined
   * observation + summary + prompt count. Paged by `limit`/`offset` and
   * filterable by project and platform so the payload stays small on large
   * databases; `hasMore` says whether older sessions follow this page.
   */
  getSessionCatalog(
    options: { project?: string; platformSource?: string; limit?: number; offset?: number } = {}
  ): { sessions: SessionCatalogRow[]; hasMore: boolean } {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? SESSION_CATALOG_DEFAULT_LIMIT), 1), SESSION_CATALOG_MAX_LIMIT);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    let query = `
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        s.custom_title,
        s.started_at_epoch,
        (
          (SELECT COUNT(*) FROM observations o WHERE o.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM session_summaries ss WHERE ss.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM user_prompts up WHERE up.session_db_id = s.id)
        ) as item_count
      FROM sdk_sessions s
      WHERE s.project IS NOT NULL AND s.project != ''
        AND s.project != ?
    `;
    const params: SQLQueryBindings[] = [OBSERVER_SESSIONS_PROJECT];

    if (options.project) {
      query += ' AND s.project = ?';
      params.push(options.project);
    }
    if (options.platformSource) {
      query += ` AND COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') = ?`;
      params.push(normalizePlatformSource(options.platformSource));
    }

    // One row past the page tells whether older sessions follow it.
    query += ' ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const rows = this.db.prepare(query).all(...params) as SessionCatalogRow[];
    return { sessions: rows.slice(0, limit), hasMore: rows.length > limit };
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
        WHERE s.project COLLATE NOCASE = ? AND s.memory_session_id IS NOT NULL
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

  // ---------------------------------------------------------------------
  // tool_uses (v51) — durable raw tool I/O side index. See ./tool-uses.ts for
  // why this is separate from pending_messages and why no cost column exists.
  // ---------------------------------------------------------------------

  upsertToolUse(input: UpsertToolUseInput): number | null {
    return upsertToolUseRow(this.db, input);
  }

  linkToolUsesToObservation(params: {
    contentSessionId: string;
    toolUseIds: string[];
    observationId: number;
    memorySessionId?: string | null;
  }): number {
    return linkToolUsesToObservationRows(this.db, params);
  }

  getToolUsesByIds(
    ids: Array<number | string>,
    options: { limit?: number; project?: string; platformSource?: string; contentSessionId?: string } = {}
  ): ToolUseRow[] {
    return getToolUsesByIdsRows(this.db, ids, options);
  }

  queryToolUses(filters: ToolUseQueryFilters = {}): ToolUseRow[] {
    return queryToolUsesRows(this.db, filters);
  }

  appendWorkStateEntry(entry: { project: string; listName: string; fields: WorkStateFields; createdAtEpoch?: number }): number {
    const entryId = appendWorkStateEntryRow(this.db, entry);
    emitContextInvalidation({ projects: [entry.project] }, 'appendWorkStateEntry');
    return entryId;
  }

  getWorkStateEntries(projects: string[], listName?: string): WorkStateEntry[] {
    return getWorkStateEntriesRows(this.db, projects, listName);
  }

  countToolUses(filters: ToolUseQueryFilters = {}): Array<{ tool_name: string; uses: number }> {
    return countToolUsesRows(this.db, filters);
  }

  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; projects?: string[]; platformSource?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationSearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, platformSource, type, concepts, files } = options;
    const projects = scopedProjects(options);
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY o.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit && !preserveIdOrder ? `LIMIT ${limit}` : '';

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (projects.length > 0) {
      const scope = projectScopeSql('o', projects, { includeMerged: true });
      additionalConditions.push(scope.sql);
      params.push(...scope.params);
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
        return "(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ? ESCAPE '\\'))";
      });
      filesList.forEach(file => {
        // The hydration filter receives literal file paths, like SQLite search.
        const literal = file.replace(/[\\%_]/g, '\\$&');
        params.push(`%${literal}%`, `%${literal}%`);
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
             user_prompt, custom_title, status,
             observed_model, observed_billing
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as SdkSessionDetailRow | null) || null;
  }

  findSessionDbIdByContentSessionId(contentSessionId: string, platformSource: string): number | null {
    const row = this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
      LIMIT 1
    `).get(
      DEFAULT_PLATFORM_SOURCE,
      normalizePlatformSource(platformSource),
      contentSessionId,
    ) as { id: number } | null;

    return row?.id ?? null;
  }

  claimTelegramWrapup({
    platformSource,
    contentSessionId,
    project,
    routeKey,
    summaryCreatedAtEpoch,
  }: {
    platformSource: string;
    contentSessionId: string;
    project: string;
    routeKey: string;
    summaryCreatedAtEpoch: number;
  }): boolean {
    const claimedAtEpoch = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey,
      summaryCreatedAtEpoch,
      claimedAtEpoch,
    );

    if (result.changes === 1) return true;

    // A process can die after recording its claim but before it attempts the
    // Telegram POST (or before it marks the result sent). Treat a long-held
    // claim as an abandoned lease, while sent rows remain permanent dedupe
    // records. The compare-and-set predicate lets only one racing recovery
    // caller reclaim the row.
    const reclaim = this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(
      summaryCreatedAtEpoch,
      claimedAtEpoch,
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey,
      claimedAtEpoch - TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,
    );

    return reclaim.changes === 1;
  }

  markTelegramWrapupSent({
    platformSource,
    contentSessionId,
    project,
    routeKey,
  }: {
    platformSource: string;
    contentSessionId: string;
    project: string;
    routeKey: string;
  }): void {
    this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(
      Date.now(),
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey,
    );
  }

  releaseTelegramWrapupClaim({
    platformSource,
    contentSessionId,
    project,
    routeKey,
  }: {
    platformSource: string;
    contentSessionId: string;
    project: string;
    routeKey: string;
  }): void {
    this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey,
    );
  }

  /**
   * Record the observed IDE session's model id and billing posture (from the
   * Stop hook). Each field only overwrites when supplied, so a turn that could
   * not determine one of them keeps the previously stored value.
   */
  setSessionObservedMetadata(sessionDbId: number, observedModel?: string, observedBilling?: string): void {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(observedModel || null, observedBilling || null, sessionDbId);
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

  /**
   * The session's current prompt number (count of its user_prompts rows).
   * `createdAtOrBeforeEpochMs` answers "which prompt was current at that
   * moment" instead — for an event that happened earlier than it is being
   * ingested (a hook spool entry drained after an outage).
   */
  getPromptNumberFromUserPrompts(
    contentSessionId: string,
    sessionDbId?: number,
    createdAtOrBeforeEpochMs?: number,
  ): number {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    const sessionClause = resolvedSessionDbId !== null ? 'session_db_id = ?' : 'content_session_id = ?';
    const sessionParam = resolvedSessionDbId !== null ? resolvedSessionDbId : contentSessionId;
    if (createdAtOrBeforeEpochMs !== undefined) {
      const result = this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE ${sessionClause} AND created_at_epoch <= ?
      `).get(sessionParam, createdAtOrBeforeEpochMs) as { count: number };
      return result.count;
    }

    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE ${sessionClause}
    `).get(sessionParam) as { count: number };
    return result.count;
  }

  getLatestPromptTextFromUserPrompts(contentSessionId: string, sessionDbId?: number): string | null {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    const whereClause = resolvedSessionDbId !== null ? 'session_db_id = ?' : 'content_session_id = ?';
    const param = resolvedSessionDbId !== null ? resolvedSessionDbId : contentSessionId;
    const result = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${whereClause}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(param) as { prompt_text: string } | undefined;
    return result?.prompt_text ?? null;
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
      // A tool-first init persists the placeholder; the first real prompt repairs it.
      // Real prompts are never overwritten by later real prompts.
      if (storedUserPrompt && storedUserPrompt !== MEDIA_PROMPT_PLACEHOLDER) {
        this.db.prepare(`
          UPDATE sdk_sessions SET user_prompt = ?
          WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
        `).run(storedUserPrompt, existing.id, MEDIA_PROMPT_PLACEHOLDER);
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

  // First write wins: cwd drifts when the agent `cd`s into a subdirectory, and
  // the launch directory is the one that identifies the repo. The key source
  // (how the session's project key was derived from that checkout) is recorded
  // in the same write, so the two always describe the same resolution.
  setSessionCwd(sessionDbId: number, cwd: string, projectKeySource?: ProjectKeySource | null): void {
    if (!cwd.trim()) return;
    this.db.prepare(
      'UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL'
    ).run(cwd, projectKeySource ?? null, sessionDbId);
  }

  /** The checkout the session was launched in, or null when none was recorded. */
  getSessionCwd(sessionDbId: number): string | null {
    const row = this.db.prepare('SELECT cwd FROM sdk_sessions WHERE id = ?').get(sessionDbId) as
      | { cwd: string | null }
      | null;
    return row?.cwd ?? null;
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

  // #3038 — resolve the dedup knobs from settings.json (env overrides apply);
  // off by default. SettingsDefaultsManager.get() would read env/defaults only.
  // Garbage/NaN values fall back to the safe defaults rather than disabling guards.
  private dedupConfig(): DedupRuntimeConfig & { enabled: boolean; minProjectDocs: number } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const num = (key: keyof SettingsDefaults, fallback: number): number => {
      const v = Number(settings[key]);
      return Number.isFinite(v) ? v : fallback;
    };
    // Integer knobs are truncated — maxScan is bound as a SQL `LIMIT ?`, so a
    // fractional misconfig must not reach the binding as a float (review N1).
    const int = (key: keyof SettingsDefaults, fallback: number): number => Math.trunc(num(key, fallback));
    return {
      enabled: settings.CLAUDE_MEM_DEDUP_ENABLED === 'true',
      cosineThreshold: num('CLAUDE_MEM_DEDUP_COSINE_THRESHOLD', 0.8),
      idfVetoDf: int('CLAUDE_MEM_DEDUP_IDF_VETO_DF', 10),
      minSharedTokens: int('CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS', 2),
      maxScan: int('CLAUDE_MEM_DEDUP_MAX_SCAN', 2000),
      maxBackfillRows: int('CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS', 50000),
      minProjectDocs: int('CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS', 10),
    };
  }

  // #3038 — read-only listing of Tier-1 near-duplicate candidates (joined to both titles).
  listDedupCandidates(
    project?: string,
    limit = 100
  ): Array<{
    id: number; project: string; method: string; score: number; status: string; created_at_epoch: number;
    observation_id: number; observation_title: string | null;
    duplicate_of_id: number; duplicate_of_title: string | null;
  }> {
    type Row = {
      id: number; project: string; method: string; score: number; status: string; created_at_epoch: number;
      observation_id: number; observation_title: string | null;
      duplicate_of_id: number; duplicate_of_title: string | null;
    };
    // Two explicit prepared statements — no conditional SQL-fragment interpolation.
    const select =
      'SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, ' +
      'c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title ' +
      'FROM observation_dedup_candidates c ' +
      'JOIN observations o1 ON o1.id = c.observation_id ' +
      'JOIN observations o2 ON o2.id = c.duplicate_of_id ';
    const order = 'ORDER BY c.score DESC, c.id DESC LIMIT ?';
    return project
      ? this.db.prepare(`${select}WHERE c.project = ? ${order}`).all(project, limit) as Row[]
      : this.db.prepare(`${select}${order}`).all(limit) as Row[];
  }

  /** #3038 — whether CLAUDE_MEM_DEDUP_ENABLED is on (settings.json or env). */
  isDedupEnabled(): boolean {
    return this.dedupConfig().enabled;
  }

  // #3038 — opt-in dedup-scan: backfill the IDF model + sweep all projects for candidates.
  runDedupScan(): { project: string; docs: number; candidates: number }[] {
    return runDedupScanAll(this.db, this.dedupConfig());
  }

  // Forward IDF maintenance + Tier-1 candidate scan for a freshly-inserted observation.
  private maintainDedupOnInsert(
    project: string,
    obsId: number,
    title: string | null | undefined,
    dedup: DedupRuntimeConfig & { minProjectDocs: number }
  ): void {
    bumpTokenDf(this.db, project, title);
    if (isFuzzyReady(this.db, project, dedup.minProjectDocs)) {
      recordTier1Candidates(this.db, project, obsId, title, dedup);
    }
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
  ): { id: number; createdAtEpoch: number; mergedIntoExisting: boolean } {
    // storeObservations skips empty-title rows, which would leave no id to return here.
    // This wrapper stores exactly one observation, so require a title up front rather than
    // returning an undefined id.
    if (!hasStorableTitle(observation.title)) {
      throw new Error('storeObservation requires a non-empty title');
    }

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

    return {
      id: result.observationIds[0],
      createdAtEpoch: result.createdAtEpoch,
      mergedIntoExisting: result.mergedIntoExisting[0] ?? false,
    };
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
      files_read?: string[];
      files_edited?: string[];
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
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      JSON.stringify(summary.files_read ?? []),
      JSON.stringify(summary.files_edited ?? []),
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );
    emitContextInvalidation({ projects: [project] }, 'storeSummary');

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
      files_read?: string[];
      files_edited?: string[];
    } | null,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): {
    observationIds: number[];
    /** Parallel to observationIds: true where a Tier-0 merge reused an existing row (nothing new was stored). */
    mergedIntoExisting: boolean[];
    /**
     * The rows this call actually inserted: not exact duplicates or Tier-0
     * merges, which are earlier turns' rows. Only these may take a later
     * correction to this turn's discovery_tokens.
     */
    insertedObservationIds: number[];
    summaryId: number | null;
    createdAtEpoch: number;
  } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const reinforcementSeed = seedReinforcement(timestampEpoch);
    // Every re-confirmation of a stored row (an exact duplicate, or a Tier-0
    // merge while dedup is on) records this day in its ACT-R history; same-day
    // repeats and retries are no-ops.
    const reconfirmedOn = new Date(timestampEpoch);
    const dedup = this.dedupConfig();
    // Context is platform-scoped, so Tier-0 must be too: a Codex observation
    // merged into a Claude row would vanish from Codex context.
    const sessionPlatform = normalizePlatformSource(
      (this.db.prepare('SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1')
        .get(memorySessionId) as { platform_source: string | null } | undefined)?.platform_source
    );

    const storeTx = this.db.transaction(() => {
      const observationIds: number[] = [];
      const mergedIntoExisting: boolean[] = [];
      const insertedObservationIds: number[] = [];

      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
      );

      for (const observation of observations) {
        // Skip observations with an empty title (see hasStorableTitle). The worker
        // drops them before calling, so its stored ids stay paired by position.
        if (!hasStorableTitle(observation.title)) {
          logger.debug('DB', 'Skipping observation with empty title');
          continue;
        }

        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const titleNormKey = computeTitleNormKey(
          project,
          sessionPlatform,
          observation.title,
          isSubagentEvent(observation.agent_id, observation.agent_type)
        );

        // Tier-0 (#3038): cross-session normalized-title duplicate (incl. earlier items
        // in THIS batch — already inserted and visible in-transaction) → bump + reuse.
        if (dedup.enabled) {
          // Retry idempotency: identical (session, content_hash) redelivery returns
          // the existing row without bumping occurrence_count (same as ON CONFLICT).
          const retry = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
          if (retry) {
            reinforceObservation(this.db, retry.id, reconfirmedOn);
            observationIds.push(retry.id);
            mergedIntoExisting.push(false);
            continue;
          }

          const canonical = findTier0Canonical(this.db, project, titleNormKey);
          if (canonical) {
            this.db.prepare('UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?').run(canonical.id);
            reinforceObservation(this.db, canonical.id, reconfirmedOn);
            observationIds.push(canonical.id);
            mergedIntoExisting.push(true);
            continue;
          }
        }

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
          observation.metadata ?? null,
          titleNormKey,
          reinforcementSeed.dates,
          reinforcementSeed.lastReinforced
        ) as { id: number } | null;

        if (inserted) {
          if (dedup.enabled) this.maintainDedupOnInsert(project, inserted.id, observation.title, dedup);
          observationIds.push(inserted.id);
          mergedIntoExisting.push(false);
          insertedObservationIds.push(inserted.id);
          continue;
        }

        const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
        if (!existing) {
          throw new Error(
            `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        // An exact duplicate re-confirms the stored observation instead of being
        // dropped silently.
        reinforceObservation(this.db, existing.id, reconfirmedOn);
        observationIds.push(existing.id);
        mergedIntoExisting.push(false);
      }

      let summaryId: number | null = null;
      if (summary) {
        const rolledUp = rollupObservationFileLists(observations);
        const filesRead = summary.files_read ?? rolledUp.files_read;
        const filesEdited = summary.files_edited ?? rolledUp.files_edited;
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          JSON.stringify(filesRead),
          JSON.stringify(filesEdited),
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }

      return { observationIds, mergedIntoExisting, insertedObservationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    const stored = storeTx();
    emitContextInvalidation({ projects: [project] }, 'storeObservations');
    return stored;
  }

  /**
   * Set discovery_tokens on rows a turn stored, after the fact. The Claude path
   * derives it from the turn's streamed assistant frames, which a gateway that
   * synthesizes streaming reports with zero input tokens (#3664); the turn's
   * result message carries the real usage. Callers pass only rows the turn
   * inserted, never ones it merged into from earlier turns.
   */
  updateDiscoveryTokens(observationIds: number[], summaryId: number | null, discoveryTokens: number): void {
    if (observationIds.length === 0 && summaryId === null) return;
    this.db.transaction(() => {
      const observationStmt = this.db.prepare('UPDATE observations SET discovery_tokens = ? WHERE id = ?');
      for (const id of observationIds) observationStmt.run(discoveryTokens, id);
      if (summaryId !== null) {
        this.db.prepare('UPDATE session_summaries SET discovery_tokens = ? WHERE id = ?').run(discoveryTokens, summaryId);
      }
    })();
  }

  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; projects?: string[]; platformSource?: string } = {}
  ): SessionSummarySearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, platformSource } = options;
    const projects = scopedProjects(options);
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY ss.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit && !preserveIdOrder ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (projects.length > 0) {
      const scope = projectScopeSql('ss', projects, { includeMerged: true });
      additionalConditions.push(scope.sql);
      params.push(...scope.params);
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
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; projects?: string[]; platformSource?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, platformSource } = options;
    const projects = scopedProjects(options);
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY up.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit && !preserveIdOrder ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (projects.length > 0) {
      const scope = projectScopeSql('s', projects, { includeMerged: false });
      additionalConditions.push(scope.sql);
      params.push(...scope.params);
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
          conditions.push(`(${rowAlias}.project COLLATE NOCASE = ? OR ${rowAlias}.merged_into_project COLLATE NOCASE = ?)`);
          params.push(project, project);
        } else {
          conditions.push(`${rowAlias}.project COLLATE NOCASE = ?`);
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
      // Strict comparisons: rows tied exactly at anchorEpoch (routine, since
      // storeObservations() stamps a turn's observations and its session
      // summary with one shared timestamp) must not compete with real
      // before/after rows for depth budget. They're picked up regardless by
      // the final inclusive [startEpoch, endEpoch] range query below, so
      // excluding them here at the boundary step is enough to guarantee
      // exactly depthBefore/depthAfter real neighbors on each side, whether
      // zero, one, or many rows tie the anchor.
      const beforeQuery = `
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${observationScope.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${observationScope.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...observationScope.params, depthBefore) as Array<{created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...observationScope.params, depthAfter) as Array<{created_at_epoch: number}>;

        // No early return on "both empty" here: unlike the id-anchored branch,
        // an empty before/after pair does not mean nothing matches, rows
        // tied exactly at anchorEpoch are excluded from both by design (see
        // above) and still need the final range query below to surface them.
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

    // `id` breaks created_at_epoch ties so a turn's rows (which share one epoch) render in the
    // order they were written instead of whatever order the index scan returns them in.
    const obsQuery = `
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${observationScope.clause}
      ORDER BY o.created_at_epoch ASC, o.id ASC
    `;

    const sessQuery = `
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${summaryScope.clause}
      ORDER BY ss.created_at_epoch ASC, ss.id ASC
    `;

    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${promptScope.clause}
      ORDER BY up.created_at_epoch ASC, up.id ASC
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

  getOrCreateManualSession(project: string, platformSource = DEFAULT_PLATFORM_SOURCE): string {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { memory_session_id: string } | undefined;

    if (existing) {
      if (platformSource && platformSource !== DEFAULT_PLATFORM_SOURCE) {
        this.db.prepare(
          'UPDATE sdk_sessions SET platform_source = ? WHERE memory_session_id = ?'
        ).run(platformSource, memorySessionId);
      }
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

  /**
   * One prepared statement per SQL text, for this store's hot write paths.
   *
   * requeuePromptSync bumps and enqueues once per prompt of a session on every
   * registration. A fresh `prepare()` per call made a native statement that
   * lived until GC finalized it, and on long sessions they piled up until
   * prepare() itself ran out of memory (#3537). bun's own `db.query()` cache is
   * shared by every caller on the connection and bounded
   * (Database.MAX_QUERY_CACHE_SIZE, 20 by default), so whether a statement
   * stays cached there depends on what else ran.
   */
  private cachedStatement(sql: string): Statement {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
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
    // Same exposure as importObservation below: an import row can arrive
    // without a usable session id, and session_summaries.memory_session_id is
    // NOT NULL. /api/import validates rows first; this guard covers any other
    // caller. Skip the row instead of letting the constraint abort the batch.
    if (typeof summary?.memory_session_id !== 'string' || summary.memory_session_id.trim() === '') {
      logger.warn('DB', 'Skipping imported session summary without memory_session_id', {
        project: typeof summary?.project === 'string' ? summary.project : null,
      });
      return { imported: false, id: 0 };
    }

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
      coerceBindValue(summary.request),
      coerceBindValue(summary.investigated),
      coerceBindValue(summary.learned),
      coerceBindValue(summary.completed),
      coerceBindValue(summary.next_steps),
      coerceBindValue(summary.files_read),
      coerceBindValue(summary.files_edited),
      coerceBindValue(summary.notes),
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch
    );
    emitContextInvalidation({ projects: [summary.project] }, 'importSessionSummary');

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
    // A row from a legacy or hand-edited export can arrive without a session
    // id, and observations.memory_session_id is NOT NULL. /api/import validates
    // rows first; this guard covers any other caller. Skip the malformed row
    // with a warning instead of letting the SQLite constraint ("NOT NULL
    // constraint failed: observations.memory_session_id") abort the batch.
    // Only a non-empty string is a session id: {}, true or 123 are not.
    if (typeof obs?.memory_session_id !== 'string' || obs.memory_session_id.trim() === '') {
      logger.warn('DB', 'Skipping imported observation without memory_session_id', {
        title: typeof obs?.title === 'string' ? obs.title : null,
        type: typeof obs?.type === 'string' ? obs.type : null,
      });
      return { imported: false, id: 0 };
    }

    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, coerceBindValue(obs.title), obs.created_at_epoch) as { id: number } | undefined;

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
      coerceBindValue(obs.text),
      obs.type,
      coerceBindValue(obs.title),
      coerceBindValue(obs.subtitle),
      coerceBindValue(obs.facts),
      coerceBindValue(obs.narrative),
      coerceBindValue(obs.concepts),
      coerceBindValue(obs.files_read),
      coerceBindValue(obs.files_modified),
      obs.prompt_number,
      obs.discovery_tokens || 0,
      obs.agent_type ?? null,
      obs.agent_id ?? null,
      obs.created_at,
      obs.created_at_epoch
    );
    emitContextInvalidation({ projects: [obs.project] }, 'importObservation');

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
      coerceBindValue(prompt.prompt_text),
      prompt.created_at,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }
}
