import { Database } from 'bun:sqlite';
import { getDatabase } from './Database.js';
import { normalizeTimestamp } from './types.js';

/**
 * Represents a streaming session row in the database
 */
export interface StreamingSessionRow {
  id: number;
  claude_session_id: string;
  sdk_session_id?: string;
  project: string;
  title?: string;
  subtitle?: string;
  user_prompt?: string;
  started_at: string;
  started_at_epoch: number;
  updated_at?: string;
  updated_at_epoch?: number;
  completed_at?: string;
  completed_at_epoch?: number;
  status: 'active' | 'completed' | 'failed';
}

/**
 * Input type for creating a new streaming session
 */
export interface StreamingSessionInput {
  claude_session_id: string;
  project: string;
  user_prompt?: string;
  started_at?: string | Date | number;
}

/**
 * Input type for updating a streaming session
 */
export interface StreamingSessionUpdate {
  sdk_session_id?: string;
  title?: string;
  subtitle?: string;
  status?: 'active' | 'completed' | 'failed';
  completed_at?: string | Date | number;
}

/**
 * Data Access Object for streaming session records
 * Handles real-time session tracking during SDK compression
 */
export class StreamingSessionStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new streaming session record
   * This should be called immediately when the hook receives a user prompt
   */
  create(input: StreamingSessionInput): StreamingSessionRow {
    const { isoString, epoch } = normalizeTimestamp(input.started_at);

    const stmt = this.db.query(`
      INSERT INTO streaming_sessions (
        claude_session_id, project, user_prompt, started_at, started_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, 'active')
    `);

    const info = stmt.run(
      input.claude_session_id,
      input.project,
      input.user_prompt || null,
      isoString,
      epoch
    );

    return this.getById(info.lastInsertRowid as number)!;
  }

  /**
   * Update a streaming session by internal ID
   * Uses atomic transaction to prevent race conditions
   */
  update(id: number, updates: StreamingSessionUpdate): StreamingSessionRow {
    const { isoString: updatedAt, epoch: updatedEpoch } = normalizeTimestamp(new Date());

    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Streaming session with id ${id} not found`);
    }

    const parts: string[] = [];
    const values: any[] = [];

    if (updates.sdk_session_id !== undefined) {
      parts.push('sdk_session_id = ?');
      values.push(updates.sdk_session_id);
    }
    if (updates.title !== undefined) {
      parts.push('title = ?');
      values.push(updates.title);
    }
    if (updates.subtitle !== undefined) {
      parts.push('subtitle = ?');
      values.push(updates.subtitle);
    }
    if (updates.status !== undefined) {
      parts.push('status = ?');
      values.push(updates.status);
    }
    if (updates.completed_at !== undefined) {
      const { isoString, epoch } = normalizeTimestamp(updates.completed_at);
      parts.push('completed_at = ?', 'completed_at_epoch = ?');
      values.push(isoString, epoch);
    }

    // Always update the updated_at timestamp
    parts.push('updated_at = ?', 'updated_at_epoch = ?');
    values.push(updatedAt, updatedEpoch);

    values.push(id);

    const stmt = this.db.query(`
      UPDATE streaming_sessions
      SET ${parts.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...values);

    return this.getById(id)!;
  }

  /**
   * Update a streaming session by Claude session ID
   * Convenience method for hooks that only have the Claude session ID
   */
  updateByClaudeSessionId(claudeSessionId: string, updates: StreamingSessionUpdate): StreamingSessionRow | null {
    const session = this.getByClaudeSessionId(claudeSessionId);
    if (!session) {
      return null;
    }
    return this.update(session.id, updates);
  }

  /**
   * Get streaming session by internal ID
   */
  getById(id: number): StreamingSessionRow | null {
    const stmt = this.db.query('SELECT * FROM streaming_sessions WHERE id = ?');
    return stmt.get(id) as StreamingSessionRow || null;
  }

  /**
   * Get streaming session by Claude session ID
   */
  getByClaudeSessionId(claudeSessionId: string): StreamingSessionRow | null {
    const stmt = this.db.query('SELECT * FROM streaming_sessions WHERE claude_session_id = ?');
    return stmt.get(claudeSessionId) as StreamingSessionRow || null;
  }

  /**
   * Get streaming session by SDK session ID
   */
  getBySdkSessionId(sdkSessionId: string): StreamingSessionRow | null {
    const stmt = this.db.query('SELECT * FROM streaming_sessions WHERE sdk_session_id = ?');
    return stmt.get(sdkSessionId) as StreamingSessionRow || null;
  }

  /**
   * Check if a streaming session exists by Claude session ID
   */
  has(claudeSessionId: string): boolean {
    const stmt = this.db.query('SELECT 1 FROM streaming_sessions WHERE claude_session_id = ? LIMIT 1');
    return Boolean(stmt.get(claudeSessionId));
  }

  /**
   * Get active streaming sessions for a project
   */
  getActiveForProject(project: string): StreamingSessionRow[] {
    const stmt = this.db.query(`
      SELECT * FROM streaming_sessions
      WHERE project = ? AND status = 'active'
      ORDER BY started_at_epoch DESC
    `);
    return stmt.all(project) as StreamingSessionRow[];
  }

  /**
   * Get all active streaming sessions
   */
  getAllActive(): StreamingSessionRow[] {
    const stmt = this.db.query(`
      SELECT * FROM streaming_sessions
      WHERE status = 'active'
      ORDER BY started_at_epoch DESC
    `);
    return stmt.all() as StreamingSessionRow[];
  }

  /**
   * Get recent streaming sessions (completed or failed)
   */
  getRecent(limit = 10): StreamingSessionRow[] {
    const stmt = this.db.query(`
      SELECT * FROM streaming_sessions
      ORDER BY started_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(limit) as StreamingSessionRow[];
  }

  /**
   * Mark a session as completed
   */
  markCompleted(id: number): StreamingSessionRow {
    return this.update(id, {
      status: 'completed',
      completed_at: new Date()
    });
  }

  /**
   * Mark a session as failed
   */
  markFailed(id: number): StreamingSessionRow {
    return this.update(id, {
      status: 'failed',
      completed_at: new Date()
    });
  }

  /**
   * Delete a streaming session by ID
   */
  deleteById(id: number): boolean {
    const stmt = this.db.query('DELETE FROM streaming_sessions WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  /**
   * Delete a streaming session by Claude session ID
   */
  deleteByClaudeSessionId(claudeSessionId: string): boolean {
    const stmt = this.db.query('DELETE FROM streaming_sessions WHERE claude_session_id = ?');
    const info = stmt.run(claudeSessionId);
    return info.changes > 0;
  }

  /**
   * Clean up old completed/failed sessions (older than N days)
   */
  cleanupOldSessions(daysOld = 30): number {
    const cutoffEpoch = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    const stmt = this.db.query(`
      DELETE FROM streaming_sessions
      WHERE status IN ('completed', 'failed')
        AND completed_at_epoch < ?
    `);
    const info = stmt.run(cutoffEpoch);
    return info.changes;
  }
}
