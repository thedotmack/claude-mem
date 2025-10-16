import { Database } from 'bun:sqlite';
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
    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    // Ensure optimized settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
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
    const query = this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return query.all(project, limit) as any[];
  }

  /**
   * Find active SDK session for a Claude session
   */
  findActiveSDKSession(claudeSessionId: string): {
    id: number;
    sdk_session_id: string | null;
    project: string;
  } | null {
    const query = this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `);

    return query.get(claudeSessionId) as any || null;
  }

  /**
   * Create a new SDK session
   */
  createSDKSession(claudeSessionId: string, project: string, userPrompt: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const query = this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `);

    query.run(claudeSessionId, project, userPrompt, now.toISOString(), nowEpoch);

    // Get the last inserted ID
    const lastIdQuery = this.db.query('SELECT last_insert_rowid() as id');
    const result = lastIdQuery.get() as { id: number };
    return result.id;
  }

  /**
   * Update SDK session ID (captured from init message)
   */
  updateSDKSessionId(id: number, sdkSessionId: string): void {
    const query = this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `);

    query.run(sdkSessionId, id);
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

    const query = this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    query.run(sdkSessionId, project, text, type, now.toISOString(), nowEpoch);
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

    const query = this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    query.run(
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

    const query = this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `);

    query.run(now.toISOString(), nowEpoch, id);
  }

  /**
   * Mark SDK session as failed
   */
  markSessionFailed(id: number): void {
    const now = new Date();
    const nowEpoch = now.getTime();

    const query = this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `);

    query.run(now.toISOString(), nowEpoch, id);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
