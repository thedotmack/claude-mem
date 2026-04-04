import type { DbAdapter } from '../adapter.js';
import { exec, queryOne, queryAll } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import {
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
  constructor(private db: DbAdapter) {}

  /**
   * Run all migrations in order
   * This is the only public method - all migrations are internal
   */
  async runAllMigrations(): Promise<void> {
    await this.initializeSchema();
    await this.ensureWorkerPortColumn();
    await this.ensurePromptTrackingColumns();
    await this.removeSessionSummariesUniqueConstraint();
    await this.addObservationHierarchicalFields();
    await this.makeObservationsTextNullable();
    await this.createUserPromptsTable();
    await this.ensureDiscoveryTokensColumn();
    await this.createPendingMessagesTable();
    await this.renameSessionIdColumns();
    await this.repairSessionIdColumnRename();
    await this.addFailedAtEpochColumn();
    await this.addOnUpdateCascadeToForeignKeys();
    await this.addObservationContentHashColumn();
    await this.addSessionCustomTitleColumn();
  }

  /**
   * Initialize database schema (migration004)
   */
  private async initializeSchema(): Promise<void> {
    // Create schema_versions table if it doesn't exist
    await this.db.executeScript(`
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

    // Record migration004 as applied
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [4, new Date().toISOString()]);
  }

  /**
   * Ensure worker_port column exists (migration 5)
   */
  private async ensureWorkerPortColumn(): Promise<void> {
    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(sdk_sessions)');
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      await this.db.execute('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [5, new Date().toISOString()]);
  }

  /**
   * Ensure prompt tracking columns exist (migration 6)
   */
  private async ensurePromptTrackingColumns(): Promise<void> {
    const sessionsInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(sdk_sessions)');
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      await this.db.execute('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    const observationsInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      await this.db.execute('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    const summariesInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(session_summaries)');
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      await this.db.execute('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [6, new Date().toISOString()]);
  }

  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   */
  private async removeSessionSummariesUniqueConstraint(): Promise<void> {
    const summariesIndexes = await queryAll<IndexInfo>(this.db, 'PRAGMA index_list(session_summaries)');
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1);

    if (!hasUniqueConstraint) {
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [7, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    await this.db.execute('DROP TABLE IF EXISTS session_summaries_new');

    await this.db.withTransaction(async (txDb) => {
      await txDb.execute(`
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

      await txDb.execute(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, created_at, created_at_epoch
        FROM session_summaries
      `);

      await txDb.execute('DROP TABLE session_summaries');
      await txDb.execute('ALTER TABLE session_summaries_new RENAME TO session_summaries');

      await txDb.execute('CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id)');
      await txDb.execute('CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
      await txDb.execute('CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');
    });

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [7, new Date().toISOString()]);
    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  private async addObservationHierarchicalFields(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [8]);
    if (applied) return;

    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [8, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    await this.db.executeScript(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT
    `);

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [8, new Date().toISOString()]);
    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  /**
   * Make observations.text nullable (migration 9)
   */
  private async makeObservationsTextNullable(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [9]);
    if (applied) return;

    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [9, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    await this.db.execute('DROP TABLE IF EXISTS observations_new');

    await this.db.withTransaction(async (txDb) => {
      await txDb.execute(`
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

      await txDb.execute(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               created_at, created_at_epoch
        FROM observations
      `);

      await txDb.execute('DROP TABLE observations');
      await txDb.execute('ALTER TABLE observations_new RENAME TO observations');

      await txDb.execute('CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id)');
      await txDb.execute('CREATE INDEX idx_observations_project ON observations(project)');
      await txDb.execute('CREATE INDEX idx_observations_type ON observations(type)');
      await txDb.execute('CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');
    });

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [9, new Date().toISOString()]);
    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  private async createUserPromptsTable(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [10]);
    if (applied) return;

    const tableInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(user_prompts)');
    if (tableInfo.length > 0) {
      await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [10, new Date().toISOString()]);
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    await this.db.withTransaction(async (txDb) => {
      await txDb.execute(`
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

      await txDb.execute('CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id)');
      await txDb.execute('CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC)');
      await txDb.execute('CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number)');
      await txDb.execute('CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number)');

      // Create FTS5 virtual table — skip if FTS5 is unavailable
      try {
        await txDb.execute(`
          CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
            prompt_text,
            content='user_prompts',
            content_rowid='id'
          )
        `);

        await txDb.execute(`
          CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
            INSERT INTO user_prompts_fts(rowid, prompt_text)
            VALUES (new.id, new.prompt_text);
          END
        `);

        await txDb.execute(`
          CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
            INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
            VALUES('delete', old.id, old.prompt_text);
          END
        `);

        await txDb.execute(`
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
    });

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [10, new Date().toISOString()]);
    logger.debug('DB', 'Successfully created user_prompts table');
  }

  /**
   * Ensure discovery_tokens column exists (migration 11)
   */
  private async ensureDiscoveryTokensColumn(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [11]);
    if (applied) return;

    const observationsInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(observations)');
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      await this.db.execute('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    const summariesInfo = await queryAll<TableColumnInfo>(this.db, 'PRAGMA table_info(session_summaries)');
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      await this.db.execute('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [11, new Date().toISOString()]);
  }

  /**
   * Create pending_messages table (migration 16)
   */
  private async createPendingMessagesTable(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [16]);
    if (applied) return;

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
   */
  private async renameSessionIdColumns(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [17]);
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    const safeRenameColumn = async (table: string, oldCol: string, newCol: string): Promise<boolean> => {
      const tableInfo = await queryAll<TableColumnInfo>(this.db, `PRAGMA table_info(${table})`);
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) return false;

      if (hasOldCol) {
        await this.db.execute(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    if (await safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (await safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;
    if (await safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (await safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;
    if (await safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;
    if (await safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [17, new Date().toISOString()]);

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  /**
   * Repair session ID column renames (migration 19) - DEPRECATED, kept for backwards compatibility
   */
  private async repairSessionIdColumnRename(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [19]);
    if (applied) return;
    await exec(this.db, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [19, new Date().toISOString()]);
  }

  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
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
   * Add ON UPDATE CASCADE to FK constraints (migration 21)
   */
  private async addOnUpdateCascadeToForeignKeys(): Promise<void> {
    const applied = await queryOne<SchemaVersion>(this.db, 'SELECT version FROM schema_versions WHERE version = ?', [21]);
    if (applied) return;

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    await this.db.execute('PRAGMA foreign_keys = OFF');

    try {
      await this.db.withTransaction(async (txDb) => {
        // 1. Recreate observations table
        await txDb.execute('DROP TRIGGER IF EXISTS observations_ai');
        await txDb.execute('DROP TRIGGER IF EXISTS observations_ad');
        await txDb.execute('DROP TRIGGER IF EXISTS observations_au');

        await txDb.execute('DROP TABLE IF EXISTS observations_new');

        await txDb.execute(`
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

        await txDb.execute(`
          INSERT INTO observations_new
          SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
                 narrative, concepts, files_read, files_modified, prompt_number,
                 discovery_tokens, created_at, created_at_epoch
          FROM observations
        `);

        await txDb.execute('DROP TABLE observations');
        await txDb.execute('ALTER TABLE observations_new RENAME TO observations');

        await txDb.execute('CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id)');
        await txDb.execute('CREATE INDEX idx_observations_project ON observations(project)');
        await txDb.execute('CREATE INDEX idx_observations_type ON observations(type)');
        await txDb.execute('CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');

        // Recreate FTS triggers only if observations_fts exists
        const hasFTS = (await queryAll<{ name: string }>(txDb, "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'")).length > 0;
        if (hasFTS) {
          await txDb.execute(`
            CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
              INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
              VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
            END
          `);

          await txDb.execute(`
            CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
              INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
              VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            END
          `);

          await txDb.execute(`
            CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
              INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
              VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
              INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
              VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
            END
          `);
        }

        // 2. Recreate session_summaries table
        await txDb.execute('DROP TABLE IF EXISTS session_summaries_new');

        await txDb.execute(`
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

        await txDb.execute(`
          INSERT INTO session_summaries_new
          SELECT id, memory_session_id, project, request, investigated, learned,
                 completed, next_steps, files_read, files_edited, notes,
                 prompt_number, discovery_tokens, created_at, created_at_epoch
          FROM session_summaries
        `);

        await txDb.execute('DROP TRIGGER IF EXISTS session_summaries_ai');
        await txDb.execute('DROP TRIGGER IF EXISTS session_summaries_ad');
        await txDb.execute('DROP TRIGGER IF EXISTS session_summaries_au');

        await txDb.execute('DROP TABLE session_summaries');
        await txDb.execute('ALTER TABLE session_summaries_new RENAME TO session_summaries');

        await txDb.execute('CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id)');
        await txDb.execute('CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
        await txDb.execute('CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');

        const hasSummariesFTS = (await queryAll<{ name: string }>(txDb, "SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'")).length > 0;
        if (hasSummariesFTS) {
          await txDb.execute(`
            CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
              INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
              VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
            END
          `);

          await txDb.execute(`
            CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
              INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
              VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
            END
          `);

          await txDb.execute(`
            CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
              INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
              VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
              INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
              VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
            END
          `);
        }

        await exec(txDb, 'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)', [21, new Date().toISOString()]);
      });

      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } finally {
      await this.db.execute('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * Add content_hash column to observations for deduplication (migration 22)
   */
  private async addObservationContentHashColumn(): Promise<void> {
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
   * Add custom_title column to sdk_sessions (migration 23)
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
}
