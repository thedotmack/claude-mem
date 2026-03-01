import type { Database } from '../sqlite-compat.js';
import { logger } from '../../../utils/logger.js';
import type {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion
} from '../../../types/database.js';

/**
 * MigrationRunner handles all database schema migrations
 * Extracted from SessionStore to separate concerns
 */
export class MigrationRunner {
  constructor(private db: Database) {}

  /**
   * Run all migrations in order
   * This is the only public method - all migrations are internal
   */
  runAllMigrations(): void {
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
    this.repairSessionIdColumnRename();
    this.addFailedAtEpochColumn();
    this.ensureReadTokensColumn();
    this.createContextInjectionsTable();
    this.recreateFTSTablesWithUnicode61();
    this.ensurePriorityColumn();
    this.ensureEnrichmentColumns();
  }

  /**
   * Initialize database schema using migrations (migration004)
   * This runs the core SDK tables migration if no tables exist
   */
  private initializeSchema(): void {
    // Create schema_versions table if it doesn't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Get applied migrations
    const appliedVersions = this.db.prepare('SELECT version FROM schema_versions ORDER BY version').all() as SchemaVersion[];
    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions.map(v => v.version)) : 0;

    // Only run migration004 if no migrations have been applied
    // This creates the sdk_sessions, observations, and session_summaries tables
    if (maxApplied === 0) {
      logger.info('DB', 'Initializing fresh database with migration004');

      // Migration004: SDK agent architecture tables
      this.db.run(`
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
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
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
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `);

      // Record migration004 as applied
      this.db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());

      logger.info('DB', 'Migration004 applied successfully');
    }
  }

  /**
   * Ensure worker_port column exists (migration 5)
   */
  private ensureWorkerPortColumn(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(5) as SchemaVersion | undefined;
    if (applied) return;

    // Check if column exists
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  /**
   * Ensure prompt tracking columns exist (migration 6)
   */
  private ensurePromptTrackingColumns(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(6) as SchemaVersion | undefined;
    if (applied) return;

    // Check sdk_sessions for prompt_counter
    const sessionsInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    // Check observations for prompt_number
    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    // Check session_summaries for prompt_number
    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   */
  private removeSessionSummariesUniqueConstraint(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(7) as SchemaVersion | undefined;
    if (applied) return;

    // Check if UNIQUE constraint exists
    const summariesIndexes = this.db.query('PRAGMA index_list(session_summaries)').all() as IndexInfo[];
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1);

    if (!hasUniqueConstraint) {
      // Already migrated (no constraint exists)
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    // Begin transaction
    this.db.run('BEGIN TRANSACTION');

    // Create new table without UNIQUE constraint
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

    // Copy data from old table
    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    // Drop old table
    this.db.run('DROP TABLE session_summaries');

    // Rename new table
    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    // Recreate indexes
    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    // Commit transaction
    this.db.run('COMMIT');

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  private addObservationHierarchicalFields(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(8) as SchemaVersion | undefined;
    if (applied) return;

    // Check if new fields already exist
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      // Already migrated
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    // Add new columns
    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());

    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  private makeObservationsTextNullable(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(9) as SchemaVersion | undefined;
    if (applied) return;

    // Check if text column is already nullable
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      // Already migrated or text column doesn't exist
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    // Begin transaction
    this.db.run('BEGIN TRANSACTION');

    // Create new table with text as nullable
    this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
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
    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    // Drop old table
    this.db.run('DROP TABLE observations');

    // Rename new table
    this.db.run('ALTER TABLE observations_new RENAME TO observations');

    // Recreate indexes
    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);

    // Commit transaction
    this.db.run('COMMIT');

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  private createUserPromptsTable(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(10) as SchemaVersion | undefined;
    if (applied) return;

    // Check if table already exists
    const tableInfo = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
    if (tableInfo.length > 0) {
      // Already migrated
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    // Begin transaction
    this.db.run('BEGIN TRANSACTION');

    // Create main table (using content_session_id since memory_session_id is set asynchronously by worker)
    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);

    // Create FTS5 virtual table
    this.db.run(`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `);

    // Create triggers to sync FTS5
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

    // Commit transaction
    this.db.run('COMMIT');

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

    logger.debug('DB', 'Successfully created user_prompts table with FTS5 support');
  }

  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  private ensureDiscoveryTokensColumn(): void {
    // Check if migration already applied to avoid unnecessary re-runs
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as SchemaVersion | undefined;
    if (applied) return;

    // Check if discovery_tokens column exists in observations table
    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    // Check if discovery_tokens column exists in session_summaries table
    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    // Record migration only after successful column verification/addition
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
  }

  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  private createPendingMessagesTable(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(16) as SchemaVersion | undefined;
    if (applied) return;

    // Check if table already exists
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());

    logger.debug('DB', 'pending_messages table created successfully');
  }

  /**
   * Rename session ID columns for semantic clarity (migration 17)
   * - claude_session_id -> content_session_id (user's observed session)
   * - sdk_session_id -> memory_session_id (memory agent's session for resume)
   *
   * IDEMPOTENT: Checks each table individually before renaming.
   * This handles databases in any intermediate state (partial migration, fresh install, etc.)
   */
  private renameSessionIdColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(17) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    // Helper to safely rename a column if it exists
    const safeRenameColumn = (table: string, oldCol: string, newCol: string): boolean => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) {
        // Already renamed, nothing to do
        return false;
      }

      if (hasOldCol) {
        // SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      // Neither column exists - table might not exist or has different schema
      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    // Rename in sdk_sessions table
    if (safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in pending_messages table
    if (safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Rename in observations table
    if (safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in session_summaries table
    if (safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in user_prompts table
    if (safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${String(renamesPerformed)} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  /**
   * Repair session ID column renames (migration 19)
   * DEPRECATED: Migration 17 is now fully idempotent and handles all cases.
   * This migration is kept for backwards compatibility but does nothing.
   */
  private repairSessionIdColumnRename(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(19) as SchemaVersion | undefined;
    if (applied) return;

    // Migration 17 now handles all column rename cases idempotently.
    // Just record this migration as applied.
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(19, new Date().toISOString());
  }

  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
   * Used by markSessionMessagesFailed() for error recovery tracking
   */
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

  /**
   * Ensure read_tokens column exists on observations and backfill existing rows (migration 21)
   * read_tokens estimates how many tokens are consumed when this observation is read back.
   * Computed as ceiling of total content length / 4 across narrative, title, facts, concepts, text.
   *
   * NOTE: Version 21 is historically claimed by SessionStore.addCompositeIndexes() for
   * databases created through the worker path. MigrationRunner reassigns it here for the
   * read_tokens column. Both paths use PRAGMA column-existence checks for idempotency,
   * so version 21 is safe regardless of which migration path recorded it first.
   */
  private ensureReadTokensColumn(): void {
    // Check column existence first (not version), since version 21 may have been
    // recorded by a prior build without actually adding the column.
    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasReadTokens = observationsInfo.some(col => col.name === 'read_tokens');

    if (!hasReadTokens) {
      this.db.run('ALTER TABLE observations ADD COLUMN read_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added read_tokens column to observations table');

      // Backfill existing rows using integer ceiling division: (total_len + 3) / 4
      this.db.run(`
        UPDATE observations SET read_tokens = (
          COALESCE(LENGTH(narrative), 0) +
          COALESCE(LENGTH(title), 0) +
          COALESCE(LENGTH(facts), 0) +
          COALESCE(LENGTH(concepts), 0) +
          COALESCE(LENGTH(text), 0) + 3
        ) / 4
      `);
      logger.debug('DB', 'Backfilled read_tokens for existing observations');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());
  }

  /**
   * Create context_injections table for token analytics (migration 22)
   * Tracks which observations were injected into each session context,
   * enabling analytics on context injection patterns and token usage.
   */
  private createContextInjectionsTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(22) as SchemaVersion | undefined;
    if (applied) return;

    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='context_injections'").all() as TableNameRow[];
    if (tables.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating context_injections table');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS context_injections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        project TEXT NOT NULL,
        observation_ids TEXT NOT NULL,
        total_read_tokens INTEGER NOT NULL,
        injection_source TEXT NOT NULL CHECK(injection_source IN ('session_start', 'prompt_submit', 'mcp_search')),
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_injections_project ON context_injections(project);
      CREATE INDEX IF NOT EXISTS idx_context_injections_created ON context_injections(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_context_injections_source ON context_injections(injection_source);
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());

    logger.debug('DB', 'context_injections table created successfully');
  }

  /**
   * Recreate FTS5 tables with unicode61 tokenizer and BM25-optimised column order (migration 24)
   *
   * The original FTS5 tables were created without an explicit tokenizer.
   * This migration drops and recreates them with `tokenize='unicode61'` so that
   * accented characters and Unicode text are handled correctly.
   *
   * observations_fts column order (matches bm25 weight vector 10/5/3/2/1/1):
   *   title, narrative, facts, concepts, subtitle, text
   */
  private recreateFTSTablesWithUnicode61(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;
    if (applied) return;

    // --- observations_fts ---
    this.db.run('DROP TRIGGER IF EXISTS observations_ai');
    this.db.run('DROP TRIGGER IF EXISTS observations_ad');
    this.db.run('DROP TRIGGER IF EXISTS observations_au');
    this.db.run('DROP TABLE IF EXISTS observations_fts');

    this.db.run(`
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title,
        narrative,
        facts,
        concepts,
        subtitle,
        text,
        content='observations',
        content_rowid='id',
        tokenize='unicode61'
      )
    `);

    this.db.run(`
      INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
      SELECT id, COALESCE(title,''), COALESCE(narrative,''), COALESCE(facts,''), COALESCE(concepts,''), COALESCE(subtitle,''), COALESCE(text,'')
      FROM observations
    `);

    this.db.run(`
      CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''), COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''));
      END
    `);

    this.db.run(`
      CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES('delete', old.id, COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''), COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''));
      END
    `);

    this.db.run(`
      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES('delete', old.id, COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''), COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''));
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''), COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''));
      END
    `);

    // --- session_summaries_fts ---
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');
    this.db.run('DROP TABLE IF EXISTS session_summaries_fts');

    this.db.run(`
      CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
        request,
        investigated,
        learned,
        completed,
        next_steps,
        notes,
        content='session_summaries',
        content_rowid='id',
        tokenize='unicode61'
      )
    `);

    this.db.run(`
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      SELECT id, COALESCE(request,''), COALESCE(investigated,''), COALESCE(learned,''), COALESCE(completed,''), COALESCE(next_steps,''), COALESCE(notes,'')
      FROM session_summaries
    `);

    this.db.run(`
      CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
      END
    `);

    this.db.run(`
      CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
      END
    `);

    this.db.run(`
      CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
      END
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
    logger.debug('DB', 'FTS5 tables recreated with unicode61 tokenizer (migration 24)');
  }

  /**
   * Ensure priority column exists on observations (migration 25)
   * Priority indicates observation importance: 'critical', 'important', or 'informational' (default).
   * No backfill needed — existing rows get the column default.
   */
  private ensurePriorityColumn(): void {
    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasPriority = observationsInfo.some(col => col.name === 'priority');

    if (!hasPriority) {
      this.db.run("ALTER TABLE observations ADD COLUMN priority TEXT DEFAULT 'informational'");
      logger.debug('DB', 'Added priority column to observations table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(25, new Date().toISOString());
  }

  /**
   * Ensure enrichment columns exist on observations (migration 26)
   * Adds topics, entities, event_date, pinned, access_count, supersedes_id
   * for observation enrichment metadata.
   * Also recreates FTS5 observations table/triggers with 8 columns (topics + entities).
   */
  private ensureEnrichmentColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(26) as SchemaVersion | undefined;
    if (applied) return;

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const existingColumns = new Set(observationsInfo.map(col => col.name));

    if (!existingColumns.has('topics')) {
      this.db.run('ALTER TABLE observations ADD COLUMN topics TEXT DEFAULT NULL');
    }
    if (!existingColumns.has('entities')) {
      this.db.run('ALTER TABLE observations ADD COLUMN entities TEXT DEFAULT NULL');
    }
    if (!existingColumns.has('event_date')) {
      this.db.run('ALTER TABLE observations ADD COLUMN event_date TEXT DEFAULT NULL');
    }
    if (!existingColumns.has('pinned')) {
      this.db.run('ALTER TABLE observations ADD COLUMN pinned INTEGER DEFAULT 0');
    }
    if (!existingColumns.has('access_count')) {
      this.db.run('ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0');
    }
    if (!existingColumns.has('supersedes_id')) {
      this.db.run('ALTER TABLE observations ADD COLUMN supersedes_id TEXT DEFAULT NULL');
    }

    // Partial indexes for efficient filtering
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_event_date ON observations(event_date) WHERE event_date IS NOT NULL');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_pinned ON observations(pinned) WHERE pinned = 1');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_supersedes ON observations(supersedes_id) WHERE supersedes_id IS NOT NULL');

    // Recreate FTS5 with 8 columns: add topics and entities
    // For entities, index only extracted names (comma-separated) to avoid BM25 noise from JSON
    this.db.run('DROP TRIGGER IF EXISTS observations_ai');
    this.db.run('DROP TRIGGER IF EXISTS observations_ad');
    this.db.run('DROP TRIGGER IF EXISTS observations_au');
    this.db.run('DROP TABLE IF EXISTS observations_fts');

    this.db.run(`
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title,
        narrative,
        facts,
        concepts,
        subtitle,
        text,
        topics,
        entities,
        content='observations',
        content_rowid='id',
        tokenize='unicode61'
      )
    `);

    // Backfill FTS from existing observations
    // For entities, extract names from JSON array: [{"name":"Alice","type":"person"}] → "Alice"
    this.db.run(`
      INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
      SELECT id,
        COALESCE(title,''), COALESCE(narrative,''), COALESCE(facts,''),
        COALESCE(concepts,''), COALESCE(subtitle,''), COALESCE(text,''),
        COALESCE(topics,''),
        COALESCE((
          SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
          FROM json_each(entities)
        ), '')
      FROM observations
    `);

    // INSERT trigger
    this.db.run(`
      CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES (new.id,
          COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''),
          COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''),
          COALESCE(new.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(new.entities)
          ), ''));
      END
    `);

    // DELETE trigger
    this.db.run(`
      CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES('delete', old.id,
          COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''),
          COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''),
          COALESCE(old.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(old.entities)
          ), ''));
      END
    `);

    // UPDATE trigger — conditional WHEN clause prevents firing on access_count/pinned changes
    this.db.run(`
      CREATE TRIGGER observations_au AFTER UPDATE ON observations
      WHEN OLD.title IS NOT NEW.title OR OLD.narrative IS NOT NEW.narrative OR OLD.facts IS NOT NEW.facts
        OR OLD.concepts IS NOT NEW.concepts OR OLD.subtitle IS NOT NEW.subtitle OR OLD.text IS NOT NEW.text
        OR OLD.topics IS NOT NEW.topics OR OLD.entities IS NOT NEW.entities
      BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES('delete', old.id,
          COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''),
          COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''),
          COALESCE(old.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(old.entities)
          ), ''));
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES (new.id,
          COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''),
          COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''),
          COALESCE(new.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(new.entities)
          ), ''));
      END
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(26, new Date().toISOString());
    logger.debug('DB', 'Added enrichment columns and updated FTS5 triggers (migration 26)');
  }
}
