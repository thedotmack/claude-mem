import { Database } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  SdkSessionRecord,
  LatestPromptResult
} from '../../types/database.js';
import {
  ObservationRow as ObservationRecord,
  SessionSummaryRow as SessionSummaryRecord,
  UserPromptRow as UserPromptRecord
} from './types.js';

// Extended type for joined queries
export interface UserPromptWithContext extends UserPromptRecord {
  project: string;
  sdk_session_id: string;
}

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides simple, synchronous CRUD operations for session-based memory
 */
export class SessionStore {
  public db: Database;

  constructor() {
    ensureDir(DATA_DIR);
    this.db = new Database(DB_PATH);

    // Ensure optimized settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed (fresh database)
    this.initializeSchema();

    // Run migrations
    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.ensureMetadataJsonColumn();
    this.removeObservationsTypeCheckConstraint();
  }

  /**
   * Initialize database schema using migrations (migration004)
   * This runs the core SDK tables migration if no tables exist
   *
   * Note: Using console.log for migration messages since they run during constructor
   * before structured logger is available. Actual errors use console.error.
   */
  private initializeSchema(): void {
    try {
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
        console.log('[SessionStore] Initializing fresh database with migration004...');

        // Migration004: SDK agent architecture tables
        this.db.run(`
          CREATE TABLE IF NOT EXISTS sdk_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            claude_session_id TEXT UNIQUE NOT NULL,
            sdk_session_id TEXT UNIQUE,
            project TEXT NOT NULL,
            user_prompt TEXT,
            started_at TEXT NOT NULL,
            started_at_epoch INTEGER NOT NULL,
            completed_at TEXT,
            completed_at_epoch INTEGER,
            status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
          );

          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(claude_session_id);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(sdk_session_id);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

          CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT NOT NULL,
            project TEXT NOT NULL,
            text TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(sdk_session_id);
          CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
          CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
          CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

          CREATE TABLE IF NOT EXISTS session_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT UNIQUE NOT NULL,
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
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
          CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
          CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        `);

        // Record migration004 as applied
        this.db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());

        console.log('[SessionStore] Migration004 applied successfully');
      }
    } catch (error: any) {
      console.error('[SessionStore] Schema initialization error:', error.message);
      throw error;
    }
  }

  /**
   * Ensure worker_port column exists (migration 5)
   */
  private ensureWorkerPortColumn(): void {
    try {
      // Check if migration already applied
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(5) as SchemaVersion | undefined;
      if (applied) return;

      // Check if column exists
      const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
      const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

      if (!hasWorkerPort) {
        this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
        console.log('[SessionStore] Added worker_port column to sdk_sessions table');
      }

      // Record migration
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
    } catch (error: any) {
      console.error('[SessionStore] Migration error:', error.message);
    }
  }

  /**
   * Ensure prompt tracking columns exist (migration 6)
   */
  private ensurePromptTrackingColumns(): void {
    try {
      // Check if migration already applied
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(6) as SchemaVersion | undefined;
      if (applied) return;

      // Check sdk_sessions for prompt_counter
      const sessionsInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
      const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

      if (!hasPromptCounter) {
        this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
        console.log('[SessionStore] Added prompt_counter column to sdk_sessions table');
      }

      // Check observations for prompt_number
      const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
      const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

      if (!obsHasPromptNumber) {
        this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
        console.log('[SessionStore] Added prompt_number column to observations table');
      }

      // Check session_summaries for prompt_number
      const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
      const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

      if (!sumHasPromptNumber) {
        this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
        console.log('[SessionStore] Added prompt_number column to session_summaries table');
      }

      // Record migration
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
    } catch (error: any) {
      console.error('[SessionStore] Prompt tracking migration error:', error.message);
    }
  }

  /**
   * Remove UNIQUE constraint from session_summaries.sdk_session_id (migration 7)
   */
  private removeSessionSummariesUniqueConstraint(): void {
    try {
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

      console.log('[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id...');

      // Begin transaction
      this.db.run('BEGIN TRANSACTION');

      try {
        // Create new table without UNIQUE constraint
        this.db.run(`
          CREATE TABLE session_summaries_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT NOT NULL,
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
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          )
        `);

        // Copy data from old table
        this.db.run(`
          INSERT INTO session_summaries_new
          SELECT id, sdk_session_id, project, request, investigated, learned,
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
          CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
          CREATE INDEX idx_session_summaries_project ON session_summaries(project);
          CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        `);

        // Commit transaction
        this.db.run('COMMIT');

        // Record migration
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

        console.log('[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id');
      } catch (error: any) {
        // Rollback on error
        this.db.run('ROLLBACK');
        throw error;
      }
    } catch (error: any) {
      console.error('[SessionStore] Migration error (remove UNIQUE constraint):', error.message);
    }
  }

  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  private addObservationHierarchicalFields(): void {
    try {
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

      console.log('[SessionStore] Adding hierarchical fields to observations table...');

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

      console.log('[SessionStore] Successfully added hierarchical fields to observations table');
    } catch (error: any) {
      console.error('[SessionStore] Migration error (add hierarchical fields):', error.message);
    }
  }

  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  private makeObservationsTextNullable(): void {
    try {
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

      console.log('[SessionStore] Making observations.text nullable...');

      // Begin transaction
      this.db.run('BEGIN TRANSACTION');

      try {
        // Create new table with text as nullable
        this.db.run(`
          CREATE TABLE observations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT NOT NULL,
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
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          )
        `);

        // Copy data from old table (all existing columns)
        this.db.run(`
          INSERT INTO observations_new
          SELECT id, sdk_session_id, project, text, type, title, subtitle, facts,
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
          CREATE INDEX idx_observations_sdk_session ON observations(sdk_session_id);
          CREATE INDEX idx_observations_project ON observations(project);
          CREATE INDEX idx_observations_type ON observations(type);
          CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
        `);

        // Commit transaction
        this.db.run('COMMIT');

        // Record migration
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

        console.log('[SessionStore] Successfully made observations.text nullable');
      } catch (error: any) {
        // Rollback on error
        this.db.run('ROLLBACK');
        throw error;
      }
    } catch (error: any) {
      console.error('[SessionStore] Migration error (make text nullable):', error.message);
    }
  }

  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  private createUserPromptsTable(): void {
    try {
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

      console.log('[SessionStore] Creating user_prompts table with FTS5 support...');

      // Begin transaction
      this.db.run('BEGIN TRANSACTION');

      try {
        // Create main table (using claude_session_id since sdk_session_id is set asynchronously by worker)
        this.db.run(`
          CREATE TABLE user_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            claude_session_id TEXT NOT NULL,
            prompt_number INTEGER NOT NULL,
            prompt_text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            FOREIGN KEY(claude_session_id) REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE
          );

          CREATE INDEX idx_user_prompts_claude_session ON user_prompts(claude_session_id);
          CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
          CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
          CREATE INDEX idx_user_prompts_lookup ON user_prompts(claude_session_id, prompt_number);
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

        console.log('[SessionStore] Successfully created user_prompts table with FTS5 support');
      } catch (error: any) {
        // Rollback on error
        this.db.run('ROLLBACK');
        throw error;
      }
    } catch (error: any) {
      console.error('[SessionStore] Migration error (create user_prompts table):', error.message);
    }
  }

  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  private ensureDiscoveryTokensColumn(): void {
    try {
      // Check if migration already applied to avoid unnecessary re-runs
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as SchemaVersion | undefined;
      if (applied) return;

      // Check if discovery_tokens column exists in observations table
      const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
      const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

      if (!obsHasDiscoveryTokens) {
        this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
        console.log('[SessionStore] Added discovery_tokens column to observations table');
      }

      // Check if discovery_tokens column exists in session_summaries table
      const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
      const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

      if (!sumHasDiscoveryTokens) {
        this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
        console.log('[SessionStore] Added discovery_tokens column to session_summaries table');
      }

      // Record migration only after successful column verification/addition
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
    } catch (error: any) {
      console.error('[SessionStore] Discovery tokens migration error:', error.message);
      throw error; // Re-throw to prevent silent failures
    }
  }

  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  private createPendingMessagesTable(): void {
    try {
      // Check if migration already applied
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(16) as SchemaVersion | undefined;
      if (applied) return;

      // Check if table already exists
      const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all() as TableNameRow[];
      if (tables.length > 0) {
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());
        return;
      }

      console.log('[SessionStore] Creating pending_messages table...');

      this.db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          claude_session_id TEXT NOT NULL,
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
      this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(claude_session_id)');

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());

      console.log('[SessionStore] pending_messages table created successfully');
    } catch (error: any) {
      console.error('[SessionStore] Pending messages table migration error:', error.message);
      throw error;
    }
  }

  /**
   * Ensure metadata_json column exists (migration 17)
   * Stores per-session metadata like mode configuration
   */
  private ensureMetadataJsonColumn(): void {
    try {
      // Check if migration already applied
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(17) as SchemaVersion | undefined;
      if (applied) return;

      // Check if column exists
      const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
      const hasMetadataJson = tableInfo.some(col => col.name === 'metadata_json');

      if (!hasMetadataJson) {
        this.db.run('ALTER TABLE sdk_sessions ADD COLUMN metadata_json TEXT');
        console.log('[SessionStore] Added metadata_json column to sdk_sessions table');
      }

      // Record migration
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());
    } catch (error: any) {
      console.error('[SessionStore] Metadata JSON migration error:', error.message);
    }
  }

  /**
   * Remove the CHECK constraint from observations.type (migration 18)
   *
   * The worker originally constrained observation "type" to code-mode values.
   * Email-investigation mode uses different types (e.g., entity/evidence/etc),
   * so we must allow arbitrary strings.
   */
  private removeObservationsTypeCheckConstraint(): void {
    try {
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(18) as SchemaVersion | undefined;
      if (applied) return;

      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'")
        .get() as { sql?: string } | undefined;

      const createSql = row?.sql;
      if (!createSql) {
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(18, new Date().toISOString());
        return;
      }

      // If the table no longer has the CHECK constraint, record migration and exit.
      if (!/CHECK\s*\(\s*type\s+IN\s*\(/i.test(createSql)) {
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(18, new Date().toISOString());
        return;
      }

      console.log('[SessionStore] Removing CHECK constraint from observations.type...');

      const indexRows = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='observations' AND sql IS NOT NULL")
        .all() as Array<{ sql: string }>;
      const indexSqlStatements = indexRows.map(r => r.sql).filter(Boolean);

      // Build a new CREATE TABLE statement with the CHECK constraint removed.
      let newCreateSql = createSql
        .replace(
          /type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type\s+IN\s*\([^)]+\)\s*\)/i,
          'type TEXT NOT NULL'
        )
        .replace(/CHECK\s*\(\s*type\s+IN\s*\([^)]+\)\s*\)/i, '');

      // Safety check: if we failed to remove it, do nothing.
      if (/CHECK\s*\(\s*type\s+IN\s*\(/i.test(newCreateSql)) {
        console.error('[SessionStore] Failed to rewrite observations schema; CHECK constraint still present.');
        return;
      }

      this.db.run('BEGIN TRANSACTION');

      try {
        this.db.run('ALTER TABLE observations RENAME TO observations_old');
        this.db.run(newCreateSql);

        const columns = (this.db.prepare('PRAGMA table_info(observations_old)').all() as TableColumnInfo[]).map(c => c.name);
        const columnList = columns.map(name => `"${name}"`).join(', ');

        // Some legacy DBs can contain observations whose sdk_session_id no longer exists.
        // Copy only rows with a valid parent session to avoid FOREIGN KEY failures.
        this.db.run(`
          INSERT INTO observations (${columnList})
          SELECT ${columnList}
          FROM observations_old
          WHERE sdk_session_id IN (SELECT sdk_session_id FROM sdk_sessions)
        `);
        this.db.run('DROP TABLE observations_old');

        for (const stmt of indexSqlStatements) {
          this.db.run(stmt);
        }

        this.db.run('COMMIT');

        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(18, new Date().toISOString());
        console.log('[SessionStore] observations.type CHECK constraint removed');
      } catch (error: any) {
        this.db.run('ROLLBACK');
        throw error;
      }
    } catch (error: any) {
      console.error('[SessionStore] Migration error (remove type CHECK constraint):', error.message);
    }
  }

  /**
   * Get recent session summaries for a project
   */
  getRecentSummaries(project: string, limit: number = 10): Array<{
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
  }> {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get recent summaries with session info for context display
   */
  getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Array<{
    sdk_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        sdk_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get recent observations for a project
   */
  getRecentObservations(project: string, limit: number = 20): Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get recent observations across all projects (for web UI)
   */
  getAllRecentObservations(limit: number = 100): Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
      FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Get recent summaries across all projects (for web UI)
   */
  getAllRecentSummaries(limit: number = 50): Array<{
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
  }> {
    const stmt = this.db.prepare(`
      SELECT id, request, investigated, learned, completed, next_steps,
             files_read, files_edited, notes, project, prompt_number,
             created_at, created_at_epoch
      FROM session_summaries
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Get recent user prompts across all sessions (for web UI)
   */
  getAllRecentUserPrompts(limit: number = 100): Array<{
    id: number;
    claude_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        up.id,
        up.claude_session_id,
        s.project,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Get all unique projects from the database (for web UI project filter)
   */
  getAllProjects(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `);

    const rows = stmt.all() as Array<{ project: string }>;
    return rows.map(row => row.project);
  }

  /**
   * Get latest user prompt with session info for a Claude session
   * Used for syncing prompts to Chroma during session initialization
   */
  getLatestUserPrompt(claudeSessionId: string): {
    id: number;
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined {
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.sdk_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.claude_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(claudeSessionId) as LatestPromptResult | undefined;
  }

  /**
   * Get recent sessions with their status and summary info
   */
  getRecentSessionsWithStatus(project: string, limit: number = 3): Array<{
    sdk_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.sdk_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.sdk_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.sdk_session_id = sum.sdk_session_id
        WHERE s.project = ? AND s.sdk_session_id IS NOT NULL
        GROUP BY s.sdk_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get observations for a specific session
   */
  getObservationsForSession(sdkSessionId: string): Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch ASC
    `);

    return stmt.all(sdkSessionId);
  }

  /**
   * Get a single observation by ID
   */
  getObservationById(id: number): ObservationRecord | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `);

    return stmt.get(id) as ObservationRecord | undefined || null;
  }

  /**
   * Get observations by array of IDs with ordering and limit
   */
  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationRecord[] {
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

    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...params) as ObservationRecord[];
  }

  /**
   * Get summary for a specific session
   */
  getSummaryForSession(sdkSessionId: string): {
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
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(sdkSessionId) || null;
  }

  /**
   * Get aggregated files from all observations for a session
   */
  getFilesForSession(sdkSessionId: string): {
    filesRead: string[];
    filesModified: string[];
  } {
    const stmt = this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `);

    const rows = stmt.all(sdkSessionId) as Array<{
      files_read: string | null;
      files_modified: string | null;
    }>;

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const row of rows) {
      // Parse files_read
      if (row.files_read) {
        try {
          const files = JSON.parse(row.files_read);
          if (Array.isArray(files)) {
            files.forEach(f => filesReadSet.add(f));
          }
        } catch {
          // Skip invalid JSON
        }
      }

      // Parse files_modified
      if (row.files_modified) {
        try {
          const files = JSON.parse(row.files_modified);
          if (Array.isArray(files)) {
            files.forEach(f => filesModifiedSet.add(f));
          }
        } catch {
          // Skip invalid JSON
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
  getSessionById(id: number): {
    id: number;
    claude_session_id: string;
    sdk_session_id: string | null;
    project: string;
    user_prompt: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return stmt.get(id) || null;
  }

  /**
   * Get SDK sessions by SDK session IDs
   * Used for exporting session metadata
   */
  getSdkSessionsBySessionIds(sdkSessionIds: string[]): {
    id: number;
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[] {
    if (sdkSessionIds.length === 0) return [];

    const placeholders = sdkSessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE sdk_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `);

    return stmt.all(...sdkSessionIds) as any[];
  }

  /**
   * Find active SDK session for a Claude session
   */
  findActiveSDKSession(claudeSessionId: string): {
    id: number;
    sdk_session_id: string | null;
    project: string;
    worker_port: number | null;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, sdk_session_id, project, worker_port
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `);

    return stmt.get(claudeSessionId) || null;
  }

  /**
   * Find any SDK session for a Claude session (active, failed, or completed)
   */
  findAnySDKSession(claudeSessionId: string): { id: number } | null {
    const stmt = this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE claude_session_id = ?
      LIMIT 1
    `);

    return stmt.get(claudeSessionId) || null;
  }

  /**
   * Reactivate an existing session
   */
  reactivateSession(id: number, userPrompt: string): void {
    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `);

    stmt.run(userPrompt, id);
  }

  /**
   * Increment prompt counter and return new value
   */
  incrementPromptCounter(id: number): number {
    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `);

    stmt.run(id);

    const result = this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(id) as { prompt_counter: number } | undefined;

    return result?.prompt_counter || 1;
  }

  /**
   * Get current prompt counter for a session
   */
  getPromptCounter(id: number): number {
    const result = this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(id) as { prompt_counter: number | null } | undefined;

    return result?.prompt_counter || 0;
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
   * WHY THIS MATTERS:
   * - NO "does session exist?" checks needed anywhere
   * - NO risk of creating duplicate sessions
   * - ALL hooks automatically connected via session_id
   * - SAVE hook observations go to correct session (same session_id)
   * - SDKAgent continuation prompt has correct context (same session_id)
   *
   * This is KISS in action: Trust the database UNIQUE constraint and
   * INSERT OR IGNORE to handle both creation and lookup elegantly.
   */
  createSDKSession(claudeSessionId: string, project: string, userPrompt: string, mode?: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    // Build metadata_json if mode is provided
    const metadataJson = mode ? JSON.stringify({ mode }) : null;

    // CRITICAL: INSERT OR IGNORE makes this idempotent
    // First call (prompt #1): Creates new row
    // Subsequent calls (prompt #2+): Ignored, returns existing ID
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `);

    const result = stmt.run(claudeSessionId, claudeSessionId, project, userPrompt, now.toISOString(), nowEpoch, metadataJson);

    // If lastInsertRowid is 0, insert was ignored (session exists), so fetch existing ID
    if (result.lastInsertRowid === 0 || result.changes === 0) {
      // Session exists - UPDATE project and user_prompt if we have non-empty values
      // This fixes the bug where SAVE hook creates session with empty project,
      // then NEW hook can't update it because INSERT OR IGNORE skips the insert
      if (project && project.trim() !== '') {
        this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(project, userPrompt, claudeSessionId);
      }

      // Update mode in metadata if provided (even for existing sessions)
      if (mode) {
        const selectStmt = this.db.prepare(`SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1`);
        const existing = selectStmt.get(claudeSessionId) as { id: number } | undefined;
        if (existing) {
          this.setSessionMode(existing.id, mode);
        }
      }

      const selectStmt = this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `);
      const existing = selectStmt.get(claudeSessionId) as { id: number } | undefined;
      return existing!.id;
    }

    return result.lastInsertRowid as number;
  }

  /**
   * Update SDK session ID (captured from init message)
   * Only updates if current sdk_session_id is NULL to avoid breaking foreign keys
   * Returns true if update succeeded, false if skipped
   */
  updateSDKSessionId(id: number, sdkSessionId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `);

    const result = stmt.run(sdkSessionId, id);

    if (result.changes === 0) {
      // This is expected behavior - sdk_session_id is already set
      // Only log at debug level to avoid noise
      logger.debug('DB', 'sdk_session_id already set, skipping update', {
        sessionId: id,
        sdkSessionId
      });
      return false;
    }

    return true;
  }

  /**
   * Set worker port for a session
   */
  setWorkerPort(id: number, port: number): void {
    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `);

    stmt.run(port, id);
  }

  /**
   * Get worker port for a session
   */
  getWorkerPort(id: number): number | null {
    const stmt = this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    const result = stmt.get(id) as { worker_port: number | null } | undefined;
    return result?.worker_port || null;
  }

  /**
   * Set mode in session's metadata_json
   * Creates or updates the metadata_json field with the mode value
   */
  setSessionMode(sessionId: number, mode: string): void {
    // Get current metadata
    const stmt = this.db.prepare('SELECT metadata_json FROM sdk_sessions WHERE id = ?');
    const result = stmt.get(sessionId) as { metadata_json: string | null } | undefined;

    let metadata: Record<string, unknown> = {};
    if (result?.metadata_json) {
      try {
        metadata = JSON.parse(result.metadata_json);
      } catch {
        // Invalid JSON, start fresh
      }
    }

    metadata.mode = mode;

    const updateStmt = this.db.prepare('UPDATE sdk_sessions SET metadata_json = ? WHERE id = ?');
    updateStmt.run(JSON.stringify(metadata), sessionId);
  }

  /**
   * Get mode from session's metadata_json
   * Returns undefined if no mode is set
   */
  getSessionMode(sessionId: number): string | undefined {
    const stmt = this.db.prepare('SELECT metadata_json FROM sdk_sessions WHERE id = ?');
    const result = stmt.get(sessionId) as { metadata_json: string | null } | undefined;

    if (!result?.metadata_json) return undefined;

    try {
      const metadata = JSON.parse(result.metadata_json);
      return metadata.mode;
    } catch {
      return undefined;
    }
  }

  /**
   * Get mode from session by claude_session_id
   * Returns undefined if no mode is set
   */
  getSessionModeByClaudeSessionId(claudeSessionId: string): string | undefined {
    const stmt = this.db.prepare('SELECT metadata_json FROM sdk_sessions WHERE claude_session_id = ?');
    const result = stmt.get(claudeSessionId) as { metadata_json: string | null } | undefined;

    if (!result?.metadata_json) return undefined;

    try {
      const metadata = JSON.parse(result.metadata_json);
      return metadata.mode;
    } catch {
      return undefined;
    }
  }

  /**
   * Save a user prompt
   */
  saveUserPrompt(claudeSessionId: string, promptNumber: number, promptText: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(claudeSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
    return result.lastInsertRowid as number;
  }

  /**
   * Get user prompt by session ID and prompt number
   * Returns the prompt text, or null if not found
   */
  getUserPrompt(claudeSessionId: string, promptNumber: number): string | null {
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);

    const result = stmt.get(claudeSessionId, promptNumber) as { prompt_text: string } | undefined;
    return result?.prompt_text ?? null;
  }

  /**
   * Store an observation (from SDK parsing)
   * Auto-creates session record if it doesn't exist in the index
   */
  storeObservation(
    sdkSessionId: string,
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
    discoveryTokens: number = 0
  ): { id: number; createdAtEpoch: number } {
    const now = new Date();
    const nowEpoch = now.getTime();

    // Ensure session record exists in the index (auto-create if missing)
    const checkStmt = this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `);
    const existingSession = checkStmt.get(sdkSessionId) as { id: number } | undefined;

    if (!existingSession) {
      // Auto-create session record if it doesn't exist
      const insertSession = this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `);
      insertSession.run(
        sdkSessionId, // claude_session_id and sdk_session_id are the same
        sdkSessionId,
        project,
        now.toISOString(),
        nowEpoch
      );
      console.log(`[SessionStore] Auto-created session record for session_id: ${sdkSessionId}`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      sdkSessionId,
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
      now.toISOString(),
      nowEpoch
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: nowEpoch
    };
  }

  /**
   * Store a session summary (from SDK parsing)
   * Auto-creates session record if it doesn't exist in the index
   */
  storeSummary(
    sdkSessionId: string,
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
    discoveryTokens: number = 0
  ): { id: number; createdAtEpoch: number } {
    const now = new Date();
    const nowEpoch = now.getTime();

    // Ensure session record exists in the index (auto-create if missing)
    const checkStmt = this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `);
    const existingSession = checkStmt.get(sdkSessionId) as { id: number } | undefined;

    if (!existingSession) {
      // Auto-create session record if it doesn't exist
      const insertSession = this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `);
      insertSession.run(
        sdkSessionId, // claude_session_id and sdk_session_id are the same
        sdkSessionId,
        project,
        now.toISOString(),
        nowEpoch
      );
      console.log(`[SessionStore] Auto-created session record for session_id: ${sdkSessionId}`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      sdkSessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      now.toISOString(),
      nowEpoch
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: nowEpoch
    };
  }

  /**
   * Mark SDK session as completed
   */
  markSessionCompleted(id: number): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `);

    stmt.run(now.toISOString(), nowEpoch, id);
  }

  /**
   * Mark SDK session as failed
   */
  markSessionFailed(id: number): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `);

    stmt.run(now.toISOString(), nowEpoch, id);
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // There's no such thing as an "orphaned" session. Sessions are created by hooks
  // and managed by Claude Code's lifecycle. Worker restarts don't invalidate them.
  // Marking all active sessions as 'failed' on startup destroys the user's current work.

  /**
   * Get session summaries by IDs (for hybrid Chroma search)
   * Returns summaries in specified temporal order
   */
  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): SessionSummaryRecord[] {
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

    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...params) as SessionSummaryRecord[];
  }

  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...params) as UserPromptRecord[];
  }

  /**
   * Get a unified timeline of all records (observations, sessions, prompts) around an anchor point
   * @param anchorEpoch The anchor timestamp (epoch milliseconds)
   * @param depthBefore Number of records to retrieve before anchor (any type)
   * @param depthAfter Number of records to retrieve after anchor (any type)
   * @param project Optional project filter
   * @returns Object containing observations, sessions, and prompts for the specified window
   */
  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  /**
   * Get timeline around a specific observation ID
   * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
   */
  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
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
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;

        // Get the earliest and latest timestamps from boundary observations
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        console.error('[SessionStore] Error getting boundary observations:', err.message, project ? `(project: ${project})` : '(all projects)');
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
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore) as Array<{created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1) as Array<{created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        console.error('[SessionStore] Error getting boundary timestamps:', err.message, project ? `(project: ${project})` : '(all projects)');
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
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
      ORDER BY up.created_at_epoch ASC
    `;

    try {
      const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams) as ObservationRecord[];
      const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams) as SessionSummaryRecord[];
      const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams) as UserPromptWithContext[];

      return {
        observations,
        sessions: sessions.map(s => ({
          id: s.id,
          sdk_session_id: s.sdk_session_id,
          project: s.project,
          request: s.request,
          completed: s.completed,
          next_steps: s.next_steps,
          created_at: s.created_at,
          created_at_epoch: s.created_at_epoch
        })),
        prompts: prompts.map(p => ({
          id: p.id,
          claude_session_id: p.claude_session_id,
          prompt_number: p.prompt_number,
          prompt_text: p.prompt_text,
          project: p.project,
          created_at: p.created_at,
          created_at_epoch: p.created_at_epoch
        }))
      };
    } catch (err: any) {
      console.error('[SessionStore] Error querying timeline records:', err.message, project ? `(project: ${project})` : '(all projects)');
      return { observations: [], sessions: [], prompts: [] };
    }
  }

  /**
   * Get a single user prompt by ID
   */
  getPromptById(id: number): {
    id: number;
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.claude_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.claude_session_id = s.claude_session_id
      WHERE p.id = ?
      LIMIT 1
    `);

    return stmt.get(id) || null;
  }

  /**
   * Get multiple user prompts by IDs
   */
  getPromptsByIds(ids: number[]): Array<{
    id: number;
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.claude_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.claude_session_id = s.claude_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `);

    return stmt.all(...ids) as Array<{
      id: number;
      claude_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  /**
   * Get full session summary by ID (includes request_summary and learned_summary)
   */
  getSessionSummaryById(id: number): {
    id: number;
    sdk_session_id: string | null;
    claude_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        sdk_session_id,
        claude_session_id,
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
    `);

    return stmt.get(id) || null;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  // ===========================================
  // Import Methods (for import-memories script)
  // ===========================================

  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  importSdkSession(session: {
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): { imported: boolean; id: number } {
    // Check if session already exists
    const existing = this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE claude_session_id = ?'
    ).get(session.claude_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        claude_session_id, sdk_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      session.claude_session_id,
      session.sdk_session_id,
      session.project,
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  importSessionSummary(summary: {
    sdk_session_id: string;
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
    // Check if summary already exists for this session
    const existing = this.db.prepare(
      'SELECT id FROM session_summaries WHERE sdk_session_id = ?'
    ).get(summary.sdk_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        sdk_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.sdk_session_id,
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

  /**
   * Import observation with duplicate checking
   * Duplicates are identified by sdk_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
  importObservation(obs: {
    sdk_session_id: string;
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
  }): { imported: boolean; id: number } {
    // Check if observation already exists
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE sdk_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.sdk_session_id, obs.title, obs.created_at_epoch) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        sdk_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.sdk_session_id,
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
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by claude_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  importUserPrompt(prompt: {
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    // Check if prompt already exists
    const existing = this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
    `).get(prompt.claude_session_id, prompt.prompt_number) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        claude_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      prompt.claude_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }
}
