import type { DbAdapter } from './adapter.js';
import { queryOne, queryAll, exec } from './adapter.js';
import { createDbAdapter } from './adapters/libsql-adapter.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  SdkSessionRecord,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { PendingMessageStore } from './PendingMessageStore.js';
import { computeObservationContentHash, findDuplicateObservation } from './observations/store.js';

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides async CRUD operations for session-based memory
 */
export class SessionStore {
  public db: DbAdapter;

  private constructor(db: DbAdapter) {
    this.db = db;
  }

  static async create(dbPath: string = DB_PATH): Promise<SessionStore> {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }
    const db = await createDbAdapter(dbPath);

    const store = new SessionStore(db);

    // Ensure optimized settings
    await store.db.execute('PRAGMA journal_mode = WAL');
    await store.db.execute('PRAGMA synchronous = NORMAL');
    await store.db.execute('PRAGMA foreign_keys = ON');

    // Initialize schema if needed (fresh database)
    await store.initializeSchema();

    // Run migrations
    await store.ensureWorkerPortColumn();
    await store.ensurePromptTrackingColumns();
    await store.removeSessionSummariesUniqueConstraint();
    await store.addObservationHierarchicalFields();
    await store.makeObservationsTextNullable();
    await store.createUserPromptsTable();
    await store.ensureDiscoveryTokensColumn();
    await store.createPendingMessagesTable();
    await store.renameSessionIdColumns();
    await store.repairSessionIdColumnRename();
    await store.addFailedAtEpochColumn();
    await store.addOnUpdateCascadeToForeignKeys();
    await store.addObservationContentHashColumn();
    await store.addSessionCustomTitleColumn();

    return store;
  }

  /**
   * Initialize database schema (migration004)
   *
   * ALWAYS creates core tables using CREATE TABLE IF NOT EXISTS — safe to run
   * regardless of schema_versions state.  This fixes issue #979 where the old
   * DatabaseManager migration system (versions 1-7) shared the schema_versions
   * table, causing maxApplied > 0 and skipping core table creation entirely.
   */
  private async initializeSchema(): Promise<void> {
    // Create schema_versions table if it doesn't exist
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Always create core tables — IF NOT EXISTS makes this idempotent
    await this.db.executeScript(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC)
    `);

    // Record migration004 as applied (OR IGNORE handles re-runs safely)
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [4, new Date().toISOString()]);
  }

  /**
   * Ensure worker_port column exists (migration 5)
   *
   * NOTE: Version 5 conflicts with old DatabaseManager migration005 (which drops orphaned tables).
   * We check actual column state rather than relying solely on version tracking.
   */
  private async ensureWorkerPortColumn(): Promise<void> {
    // Check actual column existence — don't rely on version tracking alone (issue #979)
    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(sdk_sessions)');
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      await this.db.execute('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [5, new Date().toISOString()]);
  }

  /**
   * Ensure prompt tracking columns exist (migration 6)
   *
   * NOTE: Version 6 conflicts with old DatabaseManager migration006 (which creates FTS5 tables).
   * We check actual column state rather than relying solely on version tracking.
   */
  private async ensurePromptTrackingColumns(): Promise<void> {
    // Check actual column existence — don't rely on version tracking alone (issue #979)
    // Check sdk_sessions for prompt_counter
    const sessionsInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(sdk_sessions)');
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      await this.db.execute('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    // Check observations for prompt_number
    const observationsInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      await this.db.execute('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    // Check session_summaries for prompt_number
    const summariesInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(session_summaries)');
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      await this.db.execute('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [6, new Date().toISOString()]);
  }

  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   *
   * NOTE: Version 7 conflicts with old DatabaseManager migration007 (which adds discovery_tokens).
   * We check actual constraint state rather than relying solely on version tracking.
   */
  private async removeSessionSummariesUniqueConstraint(): Promise<void> {
    // Check actual constraint state — don't rely on version tracking alone (issue #979)
    const summariesIndexes = await queryAll<IndexInfo>(this.db, 'PRAGMA index_list(session_summaries)');
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1);

    if (!hasUniqueConstraint) {
      // Already migrated (no constraint exists)
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [7, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    // Begin transaction
    await this.db.execute('BEGIN TRANSACTION');

    // Clean up leftover temp table from a previously-crashed run
    await this.db.execute('DROP TABLE IF EXISTS session_summaries_new');

    // Create new table without UNIQUE constraint
    await this.db.execute(`
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

    // Copy data from old table
    await this.db.execute(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    // Drop old table
    await this.db.execute('DROP TABLE session_summaries');

    // Rename new table
    await this.db.execute('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    // Recreate indexes
    await this.db.execute('CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id)');
    await this.db.execute('CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
    await this.db.execute('CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');

    // Commit transaction
    await this.db.execute('COMMIT');

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [7, new Date().toISOString()]);

    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  private async addObservationHierarchicalFields(): Promise<void> {
    // Check if migration already applied
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [8]);
    if (applied) return;

    // Check if new fields already exist
    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      // Already migrated
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [8, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    // Add new columns
    await this.db.executeScript(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT
    `);

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [8, new Date().toISOString()]);

    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  private async makeObservationsTextNullable(): Promise<void> {
    // Check if migration already applied
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [9]);
    if (applied) return;

    // Check if text column is already nullable
    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      // Already migrated or text column doesn't exist
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [9, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    // Begin transaction
    await this.db.execute('BEGIN TRANSACTION');

    // Clean up leftover temp table from a previously-crashed run
    await this.db.execute('DROP TABLE IF EXISTS observations_new');

    // Create new table with text as nullable
    await this.db.execute(`
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

    // Copy data from old table (all existing columns)
    await this.db.execute(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    // Drop old table
    await this.db.execute('DROP TABLE observations');

    // Rename new table
    await this.db.execute('ALTER TABLE observations_new RENAME TO observations');

    // Recreate indexes
    await this.db.execute('CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id)');
    await this.db.execute('CREATE INDEX idx_observations_project ON observations(project)');
    await this.db.execute('CREATE INDEX idx_observations_type ON observations(type)');
    await this.db.execute('CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');

    // Commit transaction
    await this.db.execute('COMMIT');

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [9, new Date().toISOString()]);

    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  private async createUserPromptsTable(): Promise<void> {
    // Check if migration already applied
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [10]);
    if (applied) return;

    // Check if table already exists
    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(user_prompts)');
    if (tableInfo.length > 0) {
      // Already migrated
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [10, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    // Begin transaction
    await this.db.execute('BEGIN TRANSACTION');

    // Create main table (using content_session_id since memory_session_id is set asynchronously by worker)
    await this.db.execute(`
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

    await this.db.execute('CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id)');
    await this.db.execute('CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC)');
    await this.db.execute('CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number)');
    await this.db.execute('CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number)');

    // Create FTS5 virtual table — skip if FTS5 is unavailable (e.g., Bun on Windows #791).
    // The user_prompts table itself is still created; only FTS indexing is skipped.
    try {
      await this.db.execute(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        )
      `);

      // Create triggers to sync FTS5
      await this.db.execute(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END
      `);

      await this.db.execute(`
        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END
      `);

      await this.db.execute(`
        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END
      `);
    } catch (ftsError) {
      logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, ftsError as Error);
    }

    // Commit transaction
    await this.db.execute('COMMIT');

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [10, new Date().toISOString()]);

    logger.debug('DB', 'Successfully created user_prompts table');
  }

  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  private async ensureDiscoveryTokensColumn(): Promise<void> {
    // Check if migration already applied to avoid unnecessary re-runs
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [11]);
    if (applied) return;

    // Check if discovery_tokens column exists in observations table
    const observationsInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      await this.db.execute('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    // Check if discovery_tokens column exists in session_summaries table
    const summariesInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(session_summaries)');
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      await this.db.execute('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    // Record migration only after successful column verification/addition
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [11, new Date().toISOString()]);
  }

  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  private async createPendingMessagesTable(): Promise<void> {
    // Check if migration already applied
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [16]);
    if (applied) return;

    // Check if table already exists
    const tables = await queryAll<TableNameRow>(this.db, "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'");
    if (tables.length > 0) {
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [16, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Creating pending_messages table');

    await this.db.execute(`
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [16, new Date().toISOString()]);

    logger.debug('DB', 'pending_messages table created successfully');
  }

  /**
   * Rename session ID columns for semantic clarity (migration 17)
   * - claude_session_id → content_session_id (user's observed session)
   * - sdk_session_id → memory_session_id (memory agent's session for resume)
   *
   * IDEMPOTENT: Checks each table individually before renaming.
   * This handles databases in any intermediate state (partial migration, fresh install, etc.)
   */
  private async renameSessionIdColumns(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [17]);
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    // Helper to safely rename a column if it exists
    const safeRenameColumn = async (table: string, oldCol: string, newCol: string): Promise<boolean> => {
      const tableInfo = await queryAll<TableColumnInfo>(this.db, `PRAGMA table_info(${table})`);
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) {
        // Already renamed, nothing to do
        return false;
      }

      if (hasOldCol) {
        // SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
        await this.db.execute(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      // Neither column exists - table might not exist or has different schema
      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    // Rename in sdk_sessions table
    if (await safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (await safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in pending_messages table
    if (await safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Rename in observations table
    if (await safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in session_summaries table
    if (await safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in user_prompts table
    if (await safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Record migration
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [17, new Date().toISOString()]);

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  /**
   * Repair session ID column renames (migration 19)
   * DEPRECATED: Migration 17 is now fully idempotent and handles all cases.
   * This migration is kept for backwards compatibility but does nothing.
   */
  private async repairSessionIdColumnRename(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [19]);
    if (applied) return;

    // Migration 17 now handles all column rename cases idempotently.
    // Just record this migration as applied.
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [19, new Date().toISOString()]);
  }

  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
   * Used by markSessionMessagesFailed() for error recovery tracking
   */
  private async addFailedAtEpochColumn(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [20]);
    if (applied) return;

    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(pending_messages)');
    const hasColumn = tableInfo.some(col => col.name === 'failed_at_epoch');

    if (!hasColumn) {
      await this.db.execute('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER');
      logger.debug('DB', 'Added failed_at_epoch column to pending_messages table');
    }

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [20, new Date().toISOString()]);
  }

  /**
   * Add ON UPDATE CASCADE to FK constraints on observations and session_summaries (migration 21)
   *
   * Both tables have FK(memory_session_id) -> sdk_sessions(memory_session_id) with ON DELETE CASCADE
   * but missing ON UPDATE CASCADE. This causes FK constraint violations when code updates
   * sdk_sessions.memory_session_id while child rows still reference the old value.
   *
   * SQLite doesn't support ALTER TABLE for FK changes, so we recreate both tables.
   */
  private async addOnUpdateCascadeToForeignKeys(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [21]);
    if (applied) return;

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    // PRAGMA foreign_keys must be set outside a transaction
    await this.db.execute('PRAGMA foreign_keys = OFF');
    await this.db.execute('BEGIN TRANSACTION');

    try {
      // ==========================================
      // 1. Recreate observations table
      // ==========================================

      // Drop FTS triggers first (they reference the observations table)
      await this.db.execute('DROP TRIGGER IF EXISTS observations_ai');
      await this.db.execute('DROP TRIGGER IF EXISTS observations_ad');
      await this.db.execute('DROP TRIGGER IF EXISTS observations_au');

      // Clean up leftover temp table from a previously-crashed run
      await this.db.execute('DROP TABLE IF EXISTS observations_new');

      await this.db.execute(`
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
      `);

      await this.db.execute(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `);

      await this.db.execute('DROP TABLE observations');
      await this.db.execute('ALTER TABLE observations_new RENAME TO observations');

      // Recreate indexes
      await this.db.execute('CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id)');
      await this.db.execute('CREATE INDEX idx_observations_project ON observations(project)');
      await this.db.execute('CREATE INDEX idx_observations_type ON observations(type)');
      await this.db.execute('CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');

      // Recreate FTS triggers only if observations_fts exists
      // (SessionSearch.ensureFTSTables creates it on first use with IF NOT EXISTS)
      const ftsRows = await queryAll<{ name: string }>(this.db, "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'");
      const hasFTS = ftsRows.length > 0;
      if (hasFTS) {
        await this.db.execute(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `);

        await this.db.execute(`
          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END
        `);

        await this.db.execute(`
          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `);
      }

      // ==========================================
      // 2. Recreate session_summaries table
      // ==========================================

      // Clean up leftover temp table from a previously-crashed run
      await this.db.execute('DROP TABLE IF EXISTS session_summaries_new');

      await this.db.execute(`
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
      `);

      await this.db.execute(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `);

      // Drop session_summaries FTS triggers before dropping the table
      await this.db.execute('DROP TRIGGER IF EXISTS session_summaries_ai');
      await this.db.execute('DROP TRIGGER IF EXISTS session_summaries_ad');
      await this.db.execute('DROP TRIGGER IF EXISTS session_summaries_au');

      await this.db.execute('DROP TABLE session_summaries');
      await this.db.execute('ALTER TABLE session_summaries_new RENAME TO session_summaries');

      // Recreate indexes
      await this.db.execute('CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id)');
      await this.db.execute('CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
      await this.db.execute('CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');

      // Recreate session_summaries FTS triggers if FTS table exists
      const summariesFtsRows = await queryAll<{ name: string }>(this.db, "SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'");
      const hasSummariesFTS = summariesFtsRows.length > 0;
      if (hasSummariesFTS) {
        await this.db.execute(`
          CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END
        `);

        await this.db.execute(`
          CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          END
        `);

        await this.db.execute(`
          CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END
        `);
      }

      // Record migration
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [21, new Date().toISOString()]);

      await this.db.execute('COMMIT');
      await this.db.execute('PRAGMA foreign_keys = ON');

      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } catch (error) {
      await this.db.execute('ROLLBACK');
      await this.db.execute('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  /**
   * Add content_hash column to observations for deduplication (migration 22)
   */
  private async addObservationContentHashColumn(): Promise<void> {
    // Check actual schema first — cross-machine DB sync can leave schema_versions
    // claiming this migration ran while the column is actually missing.
    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const hasColumn = tableInfo.some(col => col.name === 'content_hash');

    if (hasColumn) {
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [22, new Date().toISOString()]);
      return;
    }

    await this.db.execute('ALTER TABLE observations ADD COLUMN content_hash TEXT');
    await this.db.execute("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    logger.debug('DB', 'Added content_hash column to observations table with backfill and index');

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [22, new Date().toISOString()]);
  }

  /**
   * Add custom_title column to sdk_sessions for agent attribution (migration 23)
   */
  private async addSessionCustomTitleColumn(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [23]);
    if (applied) return;

    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(sdk_sessions)');
    const hasColumn = tableInfo.some(col => col.name === 'custom_title');

    if (!hasColumn) {
      await this.db.execute('ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT');
      logger.debug('DB', 'Added custom_title column to sdk_sessions table');
    }

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [23, new Date().toISOString()]);
  }

  /**
   * Update the memory session ID for a session
   * Called by SDKAgent when it captures the session ID from the first SDK message
   * Also used to RESET to null on stale resume failures (worker-service.ts)
   */
  async updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): Promise<void> {
    await exec(this.db, `
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `, [memorySessionId, sessionDbId]);
  }

  /**
   * Ensures memory_session_id is registered in sdk_sessions before FK-constrained INSERT.
   * This fixes Issue #846 where observations fail after worker restart because the
   * SDK generates a new memory_session_id but it's not registered in the parent table
   * before child records try to reference it.
   *
   * @param sessionDbId - The database ID of the session
   * @param memorySessionId - The memory session ID to ensure is registered
   */
  async ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): Promise<void> {
    const session = await queryOne<{ id: number; memory_session_id: string | null }>(this.db, `
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `, [sessionDbId]);

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    if (session.memory_session_id !== memorySessionId) {
      await exec(this.db, `
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `, [memorySessionId, sessionDbId]);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }
  }

  /**
   * Get recent session summaries for a project
   */
  async getRecentSummaries(project: string, limit: number = 10): Promise<Array<{
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
  }>> {
    return queryAll(this.db, `
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [project, limit]);
  }

  /**
   * Get recent summaries with session info for context display
   */
  async getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Promise<Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return queryAll(this.db, `
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [project, limit]);
  }

  /**
   * Get recent observations for a project
   */
  async getRecentObservations(project: string, limit: number = 20): Promise<Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return queryAll(this.db, `
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [project, limit]);
  }

  /**
   * Get recent observations across all projects (for web UI)
   */
  async getAllRecentObservations(limit: number = 100): Promise<Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return queryAll(this.db, `
      SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
      FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get recent summaries across all projects (for web UI)
   */
  async getAllRecentSummaries(limit: number = 50): Promise<Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return queryAll(this.db, `
      SELECT id, request, investigated, learned, completed, next_steps,
             files_read, files_edited, notes, project, prompt_number,
             created_at, created_at_epoch
      FROM session_summaries
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get recent user prompts across all sessions (for web UI)
   */
  async getAllRecentUserPrompts(limit: number = 100): Promise<Array<{
    id: number;
    content_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return queryAll(this.db, `
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get all unique projects from the database (for web UI project filter)
   */
  async getAllProjects(): Promise<string[]> {
    const rows = await queryAll<{ project: string }>(this.db, `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `);
    return rows.map(row => row.project);
  }

  /**
   * Get latest user prompt with session info for a Claude session
   * Used for syncing prompts to Chroma during session initialization
   */
  async getLatestUserPrompt(contentSessionId: string): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined> {
    const result = await queryOne<LatestPromptResult>(this.db, `
      SELECT
        up.*,
        s.memory_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `, [contentSessionId]);
    return result ?? undefined;
  }

  /**
   * Get recent sessions with their status and summary info
   */
  async getRecentSessionsWithStatus(project: string, limit: number = 3): Promise<Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }>> {
    return queryAll(this.db, `
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
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `, [project, limit]);
  }

  /**
   * Get observations for a specific session
   */
  async getObservationsForSession(memorySessionId: string): Promise<Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }>> {
    return queryAll(this.db, `
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `, [memorySessionId]);
  }

  /**
   * Get a single observation by ID
   */
  async getObservationById(id: number): Promise<ObservationRecord | null> {
    return queryOne<ObservationRecord>(this.db, `
      SELECT *
      FROM observations
      WHERE id = ?
    `, [id]);
  }

  /**
   * Get observations by array of IDs with ordering and limit
   */
  async getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): Promise<ObservationRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';

    // Build placeholders for IN clause
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    // Apply project filter
    if (project) {
      additionalConditions.push('project = ?');
      params.push(project);
    }

    // Apply type filter
    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => '?').join(',');
        additionalConditions.push(`type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push('type = ?');
        params.push(type);
      }
    }

    // Apply concepts filter
    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() =>
        'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    // Apply files filter
    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
      });
      filesList.forEach(file => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }

    const whereClause = additionalConditions.length > 0
      ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
      : `WHERE id IN (${placeholders})`;

    return queryAll<ObservationRecord>(this.db, `
      SELECT *
      FROM observations
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `, params);
  }

  /**
   * Get summary for a specific session
   */
  async getSummaryForSession(memorySessionId: string): Promise<{
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
  } | null> {
    return queryOne(this.db, `
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `, [memorySessionId]);
  }

  /**
   * Get aggregated files from all observations for a session
   */
  async getFilesForSession(memorySessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }> {
    const rows = await queryAll<{
      files_read: string | null;
      files_modified: string | null;
    }>(this.db, `
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `, [memorySessionId]);

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const row of rows) {
      // Parse files_read
      if (row.files_read) {
        const files = JSON.parse(row.files_read);
        if (Array.isArray(files)) {
          files.forEach(f => filesReadSet.add(f));
        }
      }

      // Parse files_modified
      if (row.files_modified) {
        const files = JSON.parse(row.files_modified);
        if (Array.isArray(files)) {
          files.forEach(f => filesModifiedSet.add(f));
        }
      }
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  /**
   * Get session by ID
   */
  async getSessionById(id: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
    custom_title: string | null;
  } | null> {
    return queryOne(this.db, `
      SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `, [id]);
  }

  /**
   * Get SDK sessions by SDK session IDs
   * Used for exporting session metadata
   */
  async getSdkSessionsBySessionIds(memorySessionIds: string[]): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[]> {
    if (memorySessionIds.length === 0) return [];

    const placeholders = memorySessionIds.map(() => '?').join(',');
    return queryAll(this.db, `
      SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `, memorySessionIds);
  }






  /**
   * Get current prompt number by counting user_prompts for this session
   * Replaces the prompt_counter column which is no longer maintained
   */
  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    const result = await queryOne<{ count: number }>(this.db, `
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `, [contentSessionId]);
    return result?.count ?? 0;
  }

  /**
   * Create a new SDK session (idempotent - returns existing session ID if already exists)
   *
   * CRITICAL ARCHITECTURE: Session ID Threading
   * ============================================
   * This function is the KEY to how claude-mem stays unified across hooks:
   *
   * - NEW hook calls: createSDKSession(session_id, project, prompt)
   * - SAVE hook calls: createSDKSession(session_id, '', '')
   * - Both use the SAME session_id from Claude Code's hook context
   *
   * IDEMPOTENT BEHAVIOR (INSERT OR IGNORE):
   * - Prompt #1: session_id not in database → INSERT creates new row
   * - Prompt #2+: session_id exists → INSERT ignored, fetch existing ID
   * - Result: Same database ID returned for all prompts in conversation
   *
   * Pure get-or-create: never modifies memory_session_id.
   * Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level.
   */
  async createSDKSession(contentSessionId: string, project: string, userPrompt: string, customTitle?: string): Promise<number> {
    const now = new Date();
    const nowEpoch = now.getTime();

    // Session reuse: Return existing session ID if already created for this contentSessionId.
    const existing = await queryOne<{ id: number }>(this.db, `
      SELECT id FROM sdk_sessions WHERE content_session_id = ?
    `, [contentSessionId]);

    if (existing) {
      // Backfill project if session was created by another hook with empty project
      if (project) {
        await exec(this.db, `
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `, [project, contentSessionId]);
      }
      // Backfill custom_title if provided and not yet set
      if (customTitle) {
        await exec(this.db, `
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `, [customTitle, contentSessionId]);
      }
      return existing.id;
    }

    // New session - insert fresh row
    // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
    // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
    // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
    await exec(this.db, `
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'active')
    `, [contentSessionId, project, userPrompt, customTitle || null, now.toISOString(), nowEpoch]);

    // Return new ID
    const row = await queryOne<{ id: number }>(this.db, 'SELECT id FROM sdk_sessions WHERE content_session_id = ?', [contentSessionId]);
    return row!.id;
  }




  /**
   * Save a user prompt
   */
  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const now = new Date();
    const nowEpoch = now.getTime();

    const result = await exec(this.db, `
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `, [contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch]);

    return result.lastInsertRowid;
  }

  /**
   * Get user prompt by session ID and prompt number
   * Returns the prompt text, or null if not found
   */
  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    const result = await queryOne<{ prompt_text: string }>(this.db, `
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `, [contentSessionId, promptNumber]);
    return result?.prompt_text ?? null;
  }

  /**
   * Store an observation (from SDK parsing)
   * Assumes session already exists (created by hook)
   * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
   */
  async storeObservation(
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
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): Promise<{ id: number; createdAtEpoch: number }> {
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Content-hash deduplication
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
    const existing = await findDuplicateObservation(this.db, contentHash, timestampEpoch);
    if (existing) {
      return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
    }

    const result = await exec(this.db, `
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
      contentHash,
      timestampIso,
      timestampEpoch
    ]);

    return {
      id: result.lastInsertRowid,
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * Store a session summary (from SDK parsing)
   * Assumes session already exists - will fail with FK error if not
   */
  async storeSummary(
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
  ): Promise<{ id: number; createdAtEpoch: number }> {
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const result = await exec(this.db, `
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ]);

    return {
      id: result.lastInsertRowid,
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * ATOMIC: Store observations + summary (no message tracking)
   *
   * Simplified version for use with claim-and-delete queue pattern.
   * Messages are deleted from queue immediately on claim, so there's no
   * message completion to track. This just stores observations and summary.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  async storeObservations(
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
    overrideTimestampEpoch?: number
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }> {
    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    await this.db.execute('BEGIN TRANSACTION');
    try {
      const observationIds: number[] = [];

      // 1. Store all observations (with content-hash deduplication)
      for (const observation of observations) {
        // Content-hash deduplication (same logic as storeObservation singular)
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = await findDuplicateObservation(this.db, contentHash, timestampEpoch);
        if (existing) {
          observationIds.push(existing.id);
          continue;
        }

        const result = await exec(this.db, `
          INSERT INTO observations
          (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
           files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
          contentHash,
          timestampIso,
          timestampEpoch
        ]);
        observationIds.push(result.lastInsertRowid);
      }

      // 2. Store summary if provided
      let summaryId: number | null = null;
      if (summary) {
        const result = await exec(this.db, `
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
        ]);
        summaryId = result.lastInsertRowid;
      }

      await this.db.execute('COMMIT');
      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    } catch (error) {
      await this.db.execute('ROLLBACK');
      throw error;
    }
  }

  /**
   * @deprecated Use storeObservations instead. This method is kept for backwards compatibility.
   *
   * ATOMIC: Store observations + summary + mark pending message as processed
   *
   * This method wraps observation storage, summary storage, and message completion
   * in a single database transaction to prevent race conditions. If the worker crashes
   * during processing, either all operations succeed together or all fail together.
   *
   * This fixes the observation duplication bug where observations were stored but
   * the message wasn't marked complete, causing reprocessing on crash recovery.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param messageId - Pending message ID to mark as processed
   * @param pendingStore - PendingMessageStore instance for marking complete
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  async storeObservationsAndMarkComplete(
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
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    messageId: number,
    _pendingStore: PendingMessageStore,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): Promise<{ observationIds: number[]; summaryId?: number; createdAtEpoch: number }> {
    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    await this.db.execute('BEGIN TRANSACTION');
    try {
      const observationIds: number[] = [];

      // 1. Store all observations (with content-hash deduplication)
      for (const observation of observations) {
        // Content-hash deduplication (same logic as storeObservation singular)
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = await findDuplicateObservation(this.db, contentHash, timestampEpoch);
        if (existing) {
          observationIds.push(existing.id);
          continue;
        }

        const result = await exec(this.db, `
          INSERT INTO observations
          (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
           files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
          contentHash,
          timestampIso,
          timestampEpoch
        ]);
        observationIds.push(result.lastInsertRowid);
      }

      // 2. Store summary if provided
      let summaryId: number | undefined;
      if (summary) {
        const result = await exec(this.db, `
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
        ]);
        summaryId = result.lastInsertRowid;
      }

      // 3. Mark pending message as processed
      // This UPDATE is part of the same transaction, so if it fails,
      // observations and summary will be rolled back
      await exec(this.db, `
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `, [timestampEpoch, messageId]);

      await this.db.execute('COMMIT');
      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    } catch (error) {
      await this.db.execute('ROLLBACK');
      throw error;
    }
  }



  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // There's no such thing as an "orphaned" session. Sessions are created by hooks
  // and managed by Claude Code's lifecycle. Worker restarts don't invalidate them.
  // Marking all active sessions as 'failed' on startup destroys the user's current work.

  /**
   * Get session summaries by IDs (for hybrid Chroma search)
   * Returns summaries in specified temporal order
   */
  async getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): Promise<SessionSummaryRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const whereClause = project
      ? `WHERE id IN (${placeholders}) AND project = ?`
      : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);

    return queryAll<SessionSummaryRecord>(this.db, `
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `, params);
  }

  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  async getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): Promise<UserPromptRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);

    return queryAll<UserPromptRecord>(this.db, `
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `, params);
  }

  /**
   * Get a unified timeline of all records (observations, sessions, prompts) around an anchor point
   * @param anchorEpoch The anchor timestamp (epoch milliseconds)
   * @param depthBefore Number of records to retrieve before anchor (any type)
   * @param depthAfter Number of records to retrieve after anchor (any type)
   * @param project Optional project filter
   * @returns Object containing observations, sessions, and prompts for the specified window
   */
  async getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }> {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  /**
   * Get timeline around a specific observation ID
   * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
   */
  async getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }> {
    const projectFilter = project ? 'AND project = ?' : '';
    const projectParams = project ? [project] : [];

    let startEpoch: number;
    let endEpoch: number;

    if (anchorObservationId !== null) {
      // Get boundary observations by ID offset
      const beforeQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = await queryAll<{id: number; created_at_epoch: number}>(this.db, beforeQuery, [anchorObservationId, ...projectParams, depthBefore + 1]);
        const afterRecords = await queryAll<{id: number; created_at_epoch: number}>(this.db, afterQuery, [anchorObservationId, ...projectParams, depthAfter + 1]);

        // Get the earliest and latest timestamps from boundary observations
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary observations', undefined, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      // For timestamp-based anchors, use time-based boundaries
      // Get observations to find the time window
      const beforeQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = await queryAll<{created_at_epoch: number}>(this.db, beforeQuery, [anchorEpoch, ...projectParams, depthBefore]);
        const afterRecords = await queryAll<{created_at_epoch: number}>(this.db, afterQuery, [anchorEpoch, ...projectParams, depthAfter + 1]);

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary timestamps', undefined, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    }

    // Now query ALL record types within the time window
    const obsQuery = `
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const sessQuery = `
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
      ORDER BY up.created_at_epoch ASC
    `;

    const observations = await queryAll<ObservationRecord>(this.db, obsQuery, [startEpoch, endEpoch, ...projectParams]);
    const sessions = await queryAll<SessionSummaryRecord>(this.db, sessQuery, [startEpoch, endEpoch, ...projectParams]);
    const prompts = await queryAll<UserPromptRecord>(this.db, promptQuery, [startEpoch, endEpoch, ...projectParams]);

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
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }

  /**
   * Get a single user prompt by ID
   */
  async getPromptById(id: number): Promise<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    return queryOne(this.db, `
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `, [id]);
  }

  /**
   * Get multiple user prompts by IDs
   */
  async getPromptsByIds(ids: number[]): Promise<Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    return queryAll(this.db, `
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `, ids);
  }

  /**
   * Get full session summary by ID (includes request_summary and learned_summary)
   */
  async getSessionSummaryById(id: number): Promise<{
    id: number;
    memory_session_id: string | null;
    content_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    return queryOne(this.db, `
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `, [id]);
  }

  /**
   * Get or create a manual session for storing user-created observations
   * Manual sessions use a predictable ID format: "manual-{project}"
   */
  async getOrCreateManualSession(project: string): Promise<string> {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = await queryOne<{ memory_session_id: string }>(this.db,
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?',
      [memorySessionId]
    );

    if (existing) {
      return memorySessionId;
    }

    // Create new manual session
    const now = new Date();
    await exec(this.db, `
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `, [memorySessionId, contentSessionId, project, now.toISOString(), now.getTime()]);

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });

    return memorySessionId;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  // ===========================================
  // Import Methods (for import-memories script)
  // ===========================================

  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  async importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): Promise<{ imported: boolean; id: number }> {
    // Check if session already exists
    const existing = await queryOne<{ id: number }>(this.db,
      'SELECT id FROM sdk_sessions WHERE content_session_id = ?',
      [session.content_session_id]
    );

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await exec(this.db, `
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      session.content_session_id,
      session.memory_session_id,
      session.project,
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    ]);

    return { imported: true, id: result.lastInsertRowid };
  }

  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  async importSessionSummary(summary: {
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
  }): Promise<{ imported: boolean; id: number }> {
    // Check if summary already exists for this session
    const existing = await queryOne<{ id: number }>(this.db,
      'SELECT id FROM session_summaries WHERE memory_session_id = ?',
      [summary.memory_session_id]
    );

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await exec(this.db, `
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ]);

    return { imported: true, id: result.lastInsertRowid };
  }

  /**
   * Import observation with duplicate checking
   * Duplicates are identified by memory_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
  async importObservation(obs: {
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
  }): Promise<{ imported: boolean; id: number }> {
    // Check if observation already exists
    const existing = await queryOne<{ id: number }>(this.db, `
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `, [obs.memory_session_id, obs.title, obs.created_at_epoch]);

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await exec(this.db, `
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
      obs.created_at,
      obs.created_at_epoch
    ]);

    return { imported: true, id: result.lastInsertRowid };
  }

  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by content_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  async importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }> {
    // Check if prompt already exists
    const existing = await queryOne<{ id: number }>(this.db, `
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `, [prompt.content_session_id, prompt.prompt_number]);

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await exec(this.db, `
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    ]);

    return { imported: true, id: result.lastInsertRowid };
  }
}
