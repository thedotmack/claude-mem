import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';

/**
 * Lightweight database interface for hooks
 * Provides simple, synchronous operations for hook commands
 * No complex logic - just basic CRUD operations
 */
export class HooksDatabase {
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
        console.error('[HooksDatabase] Added worker_port column to sdk_sessions table');
      }
    } catch (error: any) {
      console.error('[HooksDatabase] Migration error:', error.message);
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
        console.error('[HooksDatabase] Added prompt_counter column to sdk_sessions table');
      }

      // Check observations for prompt_number
      const observationsInfo = this.db.pragma('table_info(observations)');
      const obsHasPromptNumber = (observationsInfo as any[]).some((col: any) => col.name === 'prompt_number');

      if (!obsHasPromptNumber) {
        this.db.exec('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
        console.error('[HooksDatabase] Added prompt_number column to observations table');
      }

      // Check session_summaries for prompt_number
      const summariesInfo = this.db.pragma('table_info(session_summaries)');
      const sumHasPromptNumber = (summariesInfo as any[]).some((col: any) => col.name === 'prompt_number');

      if (!sumHasPromptNumber) {
        this.db.exec('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
        console.error('[HooksDatabase] Added prompt_number column to session_summaries table');
      }

      // Remove UNIQUE constraint on session_summaries.sdk_session_id
      // SQLite doesn't support dropping constraints, so we need to check if it exists first
      const summariesIndexes = this.db.pragma('index_list(session_summaries)');
      const hasUniqueConstraint = (summariesIndexes as any[]).some((idx: any) => idx.unique === 1);

    } catch (error: any) {
      console.error('[HooksDatabase] Prompt tracking migration error:', error.message);
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

      console.error('[HooksDatabase] Removing UNIQUE constraint from session_summaries.sdk_session_id...');

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

        console.error('[HooksDatabase] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id');
      } catch (error: any) {
        // Rollback on error
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error: any) {
      console.error('[HooksDatabase] Migration error (remove UNIQUE constraint):', error.message);
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
   */
  updateSDKSessionId(id: number, sdkSessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `);

    const result = stmt.run(sdkSessionId, id);

    if (result.changes === 0) {
      console.error(`[HooksDatabase] Skipped updating sdk_session_id for session ${id} - already set (prevents FOREIGN KEY constraint violation)`);
    }
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
    type: string,
    text: string,
    promptNumber?: number
  ): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(sdkSessionId, project, text, type, promptNumber || null, now.toISOString(), nowEpoch);
  }

  /**
   * Store a session summary (from SDK parsing)
   */
  storeSummary(
    sdkSessionId: string,
    project: string,
    summary: {
      request?: string;
      investigated?: string;
      learned?: string;
      completed?: string;
      next_steps?: string;
      files_read?: string;
      files_edited?: string;
      notes?: string;
    },
    promptNumber?: number
  ): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sdkSessionId,
      project,
      summary.request || null,
      summary.investigated || null,
      summary.learned || null,
      summary.completed || null,
      summary.next_steps || null,
      summary.files_read || null,
      summary.files_edited || null,
      summary.notes || null,
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
