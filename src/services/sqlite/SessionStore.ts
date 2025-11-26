import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides simple, synchronous CRUD operations for session-based memory
 */
export class SessionStore {
  public db: Database.Database;

  constructor() {
    ensureDir(DATA_DIR);
    this.db = new Database(DB_PATH);

    // Ensure optimized settings
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

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
  }

  /**
   * Initialize database schema using migrations (migration004)
   * This runs the core SDK tables migration if no tables exist
   */
  private initializeSchema(): void {
    try {
      // Create schema_versions table if it doesn't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      // Get applied migrations
      const appliedVersions = this.db.prepare('SELECT version FROM schema_versions ORDER BY version').all() as Array<{version: number}>;
      const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions.map(v => v.version)) : 0;

      // Only run migration004 if no migrations have been applied
      // This creates the sdk_sessions, observations, and session_summaries tables
      if (maxApplied === 0) {
        console.error('[SessionStore] Initializing fresh database with migration004...');

        // Migration004: SDK agent architecture tables
        this.db.exec(`
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
            type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
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

        console.error('[SessionStore] Migration004 applied successfully');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(5) as {version: number} | undefined;
      if (applied) return;

      // Check if column exists
      const tableInfo = this.db.pragma('table_info(sdk_sessions)');
      const hasWorkerPort = (tableInfo as any[]).some((col: any) => col.name === 'worker_port');

      if (!hasWorkerPort) {
        this.db.exec('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
        console.error('[SessionStore] Added worker_port column to sdk_sessions table');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(6) as {version: number} | undefined;
      if (applied) return;

      // Check sdk_sessions for prompt_counter
      const sessionsInfo = this.db.pragma('table_info(sdk_sessions)');
      const hasPromptCounter = (sessionsInfo as any[]).some((col: any) => col.name === 'prompt_counter');

      if (!hasPromptCounter) {
        this.db.exec('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
        console.error('[SessionStore] Added prompt_counter column to sdk_sessions table');
      }

      // Check observations for prompt_number
      const observationsInfo = this.db.pragma('table_info(observations)');
      const obsHasPromptNumber = (observationsInfo as any[]).some((col: any) => col.name === 'prompt_number');

      if (!obsHasPromptNumber) {
        this.db.exec('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
        console.error('[SessionStore] Added prompt_number column to observations table');
      }

      // Check session_summaries for prompt_number
      const summariesInfo = this.db.pragma('table_info(session_summaries)');
      const sumHasPromptNumber = (summariesInfo as any[]).some((col: any) => col.name === 'prompt_number');

      if (!sumHasPromptNumber) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
        console.error('[SessionStore] Added prompt_number column to session_summaries table');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(7) as {version: number} | undefined;
      if (applied) return;

      // Check if UNIQUE constraint exists
      const summariesIndexes = this.db.pragma('index_list(session_summaries)');
      const hasUniqueConstraint = (summariesIndexes as any[]).some((idx: any) => idx.unique === 1);

      if (!hasUniqueConstraint) {
        // Already migrated (no constraint exists)
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
        return;
      }

      console.error('[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id...');

      // Begin transaction
      this.db.exec('BEGIN TRANSACTION');

      try {
        // Create new table without UNIQUE constraint
        this.db.exec(`
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
        this.db.exec(`
          INSERT INTO session_summaries_new
          SELECT id, sdk_session_id, project, request, investigated, learned,
                 completed, next_steps, files_read, files_edited, notes,
                 prompt_number, created_at, created_at_epoch
          FROM session_summaries
        `);

        // Drop old table
        this.db.exec('DROP TABLE session_summaries');

        // Rename new table
        this.db.exec('ALTER TABLE session_summaries_new RENAME TO session_summaries');

        // Recreate indexes
        this.db.exec(`
          CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
          CREATE INDEX idx_session_summaries_project ON session_summaries(project);
          CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        `);

        // Commit transaction
        this.db.exec('COMMIT');

        // Record migration
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

        console.error('[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id');
      } catch (error: any) {
        // Rollback on error
        this.db.exec('ROLLBACK');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(8) as {version: number} | undefined;
      if (applied) return;

      // Check if new fields already exist
      const tableInfo = this.db.pragma('table_info(observations)');
      const hasTitle = (tableInfo as any[]).some((col: any) => col.name === 'title');

      if (hasTitle) {
        // Already migrated
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
        return;
      }

      console.error('[SessionStore] Adding hierarchical fields to observations table...');

      // Add new columns
      this.db.exec(`
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

      console.error('[SessionStore] Successfully added hierarchical fields to observations table');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(9) as {version: number} | undefined;
      if (applied) return;

      // Check if text column is already nullable
      const tableInfo = this.db.pragma('table_info(observations)');
      const textColumn = (tableInfo as any[]).find((col: any) => col.name === 'text');

      if (!textColumn || textColumn.notnull === 0) {
        // Already migrated or text column doesn't exist
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
        return;
      }

      console.error('[SessionStore] Making observations.text nullable...');

      // Begin transaction
      this.db.exec('BEGIN TRANSACTION');

      try {
        // Create new table with text as nullable
        this.db.exec(`
          CREATE TABLE observations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT NOT NULL,
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
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          )
        `);

        // Copy data from old table (all existing columns)
        this.db.exec(`
          INSERT INTO observations_new
          SELECT id, sdk_session_id, project, text, type, title, subtitle, facts,
                 narrative, concepts, files_read, files_modified, prompt_number,
                 created_at, created_at_epoch
          FROM observations
        `);

        // Drop old table
        this.db.exec('DROP TABLE observations');

        // Rename new table
        this.db.exec('ALTER TABLE observations_new RENAME TO observations');

        // Recreate indexes
        this.db.exec(`
          CREATE INDEX idx_observations_sdk_session ON observations(sdk_session_id);
          CREATE INDEX idx_observations_project ON observations(project);
          CREATE INDEX idx_observations_type ON observations(type);
          CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
        `);

        // Commit transaction
        this.db.exec('COMMIT');

        // Record migration
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

        console.error('[SessionStore] Successfully made observations.text nullable');
      } catch (error: any) {
        // Rollback on error
        this.db.exec('ROLLBACK');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(10) as {version: number} | undefined;
      if (applied) return;

      // Check if table already exists
      const tableInfo = this.db.pragma('table_info(user_prompts)');
      if ((tableInfo as any[]).length > 0) {
        // Already migrated
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
        return;
      }

      console.error('[SessionStore] Creating user_prompts table with FTS5 support...');

      // Begin transaction
      this.db.exec('BEGIN TRANSACTION');

      try {
        // Create main table (using claude_session_id since sdk_session_id is set asynchronously by worker)
        this.db.exec(`
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
        `);

        // Create FTS5 virtual table
        this.db.exec(`
          CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
            prompt_text,
            content='user_prompts',
            content_rowid='id'
          );
        `);

        // Create triggers to sync FTS5
        this.db.exec(`
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
        this.db.exec('COMMIT');

        // Record migration
        this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

        console.error('[SessionStore] Successfully created user_prompts table with FTS5 support');
      } catch (error: any) {
        // Rollback on error
        this.db.exec('ROLLBACK');
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
      const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as {version: number} | undefined;
      if (applied) return;

      // Check if discovery_tokens column exists in observations table
      const observationsInfo = this.db.pragma('table_info(observations)');
      const obsHasDiscoveryTokens = (observationsInfo as any[]).some((col: any) => col.name === 'discovery_tokens');

      if (!obsHasDiscoveryTokens) {
        this.db.exec('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
        console.error('[SessionStore] Added discovery_tokens column to observations table');
      }

      // Check if discovery_tokens column exists in session_summaries table
      const summariesInfo = this.db.pragma('table_info(session_summaries)');
      const sumHasDiscoveryTokens = (summariesInfo as any[]).some((col: any) => col.name === 'discovery_tokens');

      if (!sumHasDiscoveryTokens) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
        console.error('[SessionStore] Added discovery_tokens column to session_summaries table');
      }

      // Record migration only after successful column verification/addition
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
    } catch (error: any) {
      console.error('[SessionStore] Discovery tokens migration error:', error.message);
      throw error; // Re-throw to prevent silent failures
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

    return stmt.all(project, limit) as any[];
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

    return stmt.all(project, limit) as any[];
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

    return stmt.all(project, limit) as any[];
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

    return stmt.all(limit) as any[];
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

    return stmt.all(limit) as any[];
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

    return stmt.all(limit) as any[];
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

    return stmt.all(project, limit) as any[];
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

    return stmt.all(sdkSessionId) as any[];
  }

  /**
   * Get a single observation by ID
   */
  getObservationById(id: number): any | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `);

    return stmt.get(id) as any || null;
  }

  /**
   * Get observations by array of IDs with ordering and limit
   */
  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number } = {}
  ): any[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';

    // Build placeholders for IN clause
    const placeholders = ids.map(() => '?').join(',');

    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${placeholders})
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...ids) as any[];
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

    return stmt.get(sdkSessionId) as any || null;
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

    return stmt.get(id) as any || null;
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

    return stmt.get(claudeSessionId) as any || null;
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

    return stmt.get(claudeSessionId) as any || null;
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
  createSDKSession(claudeSessionId: string, project: string, userPrompt: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    // CRITICAL: INSERT OR IGNORE makes this idempotent
    // First call (prompt #1): Creates new row
    // Subsequent calls (prompt #2+): Ignored, returns existing ID
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);

    const result = stmt.run(claudeSessionId, claudeSessionId, project, userPrompt, now.toISOString(), nowEpoch);

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
      console.error(`[SessionStore] Auto-created session record for session_id: ${sdkSessionId}`);
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
      console.error(`[SessionStore] Auto-created session record for session_id: ${sdkSessionId}`);
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
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number } = {}
  ): any[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');

    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${placeholders})
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...ids) as any[];
  }

  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number } = {}
  ): any[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');

    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${placeholders})
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...ids) as any[];
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
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1) as any[];
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1) as any[];

        // Get the earliest and latest timestamps from boundary observations
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        console.error('[SessionStore] Error getting boundary observations:', err.message);
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
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore) as any[];
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1) as any[];

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        console.error('[SessionStore] Error getting boundary timestamps:', err.message);
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
      const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams) as any[];
      const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams) as any[];
      const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams) as any[];

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
          project: p.project,
          prompt: p.prompt_text,
          created_at: p.created_at,
          created_at_epoch: p.created_at_epoch
        }))
      };
    } catch (err: any) {
      console.error('[SessionStore] Error querying timeline records:', err.message);
      return { observations: [], sessions: [], prompts: [] };
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
