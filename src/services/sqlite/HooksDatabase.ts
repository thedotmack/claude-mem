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

    // Run migration to add worker_port column if it doesn't exist
    this.ensureWorkerPortColumn();
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
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
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
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT type, text, created_at
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
   */
  updateSDKSessionId(id: number, sdkSessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `);

    stmt.run(sdkSessionId, id);
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
    text: string
  ): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(sdkSessionId, project, text, type, now.toISOString(), nowEpoch);
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
    }
  ): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
