import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides simple, synchronous CRUD operations for session-based memory
 */
export class SessionStore {
  private db: Database;

  constructor() {
    ensureDir(DATA_DIR);
    this.db = new Database(DB_PATH);

    // Ensure optimized settings
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // Run migrations
    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
  }

  /**
   * Ensure worker_port column exists (migration)
   */
  private ensureWorkerPortColumn(): void {
    try {
      // Check if column exists
      const tableInfo = this.db.pragma('table_info(sdk_sessions)');
      const hasWorkerPort = (tableInfo as any[]).some((col: any) => col.name === 'worker_port');

      if (!hasWorkerPort) {
        this.db.exec('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
        console.error('[SessionStore] Added worker_port column to sdk_sessions table');
      }
    } catch (error: any) {
      console.error('[SessionStore] Migration error:', error.message);
    }
  }

  /**
   * Ensure prompt tracking columns exist (migration 006)
   */
  private ensurePromptTrackingColumns(): void {
    try {
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

      // Remove UNIQUE constraint on session_summaries.sdk_session_id
      // SQLite doesn't support dropping constraints, so we need to check if it exists first
      const summariesIndexes = this.db.pragma('index_list(session_summaries)');
      const hasUniqueConstraint = (summariesIndexes as any[]).some((idx: any) => idx.unique === 1);

    } catch (error: any) {
      console.error('[SessionStore] Prompt tracking migration error:', error.message);
    }
  }

  /**
   * Remove UNIQUE constraint from session_summaries.sdk_session_id (migration 007)
   */
  private removeSessionSummariesUniqueConstraint(): void {
    try {
      // Check if UNIQUE constraint exists
      const summariesIndexes = this.db.pragma('index_list(session_summaries)');
      const hasUniqueConstraint = (summariesIndexes as any[]).some((idx: any) => idx.unique === 1);

      if (!hasUniqueConstraint) {
        // Already migrated
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
   * Add hierarchical fields to observations table (migration 008)
   */
  private addObservationHierarchicalFields(): void {
    try {
      // Check if new fields already exist
      const tableInfo = this.db.pragma('table_info(observations)');
      const hasTitle = (tableInfo as any[]).some((col: any) => col.name === 'title');

      if (hasTitle) {
        // Already migrated
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

      console.error('[SessionStore] Successfully added hierarchical fields to observations table');
    } catch (error: any) {
      console.error('[SessionStore] Migration error (add hierarchical fields):', error.message);
    }
  }

  /**
   * Make observations.text nullable (migration 009)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  private makeObservationsTextNullable(): void {
    try {
      // Check if text column is already nullable
      const tableInfo = this.db.pragma('table_info(observations)');
      const textColumn = (tableInfo as any[]).find((col: any) => col.name === 'text');

      if (!textColumn || textColumn.notnull === 0) {
        // Already migrated or text column doesn't exist
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
   * Get session by ID
   */
  getSessionById(id: number): {
    id: number;
    sdk_session_id: string | null;
    project: string;
    user_prompt: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, sdk_session_id, project, user_prompt
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
   * Create a new SDK session
   */
  createSDKSession(claudeSessionId: string, project: string, userPrompt: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `);

    const result = stmt.run(claudeSessionId, project, userPrompt, now.toISOString(), nowEpoch);
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
   * Store an observation (from SDK parsing)
   */
  storeObservation(
    sdkSessionId: string,
    project: string,
    observation: {
      type: string;
      title: string;
      subtitle: string;
      facts: string[];
      narrative: string;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
    },
    promptNumber?: number
  ): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
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
      now.toISOString(),
      nowEpoch
    );
  }

  /**
   * Store a session summary (from SDK parsing)
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
    promptNumber?: number
  ): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sdkSessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber || null,
      now.toISOString(),
      nowEpoch
    );
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

  /**
   * Clean up orphaned active sessions (called on worker startup)
   */
  cleanupOrphanedSessions(): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `);

    const result = stmt.run(now.toISOString(), nowEpoch);
    return result.changes;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
