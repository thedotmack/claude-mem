/**
 * Active session management functions
 * Database-first parameter pattern for functional composition
 */

import type { Database } from '../sqlite-compat.js';
import type { ActiveSessionRow } from './types.js';

/**
 * Get all sessions with status = 'active', ordered newest first.
 * Used for stale session detection and health checks.
 */
export function getActiveSessions(db: Database): ActiveSessionRow[] {
  const stmt = db.prepare(`
    SELECT id, content_session_id, project, user_prompt, started_at_epoch
    FROM sdk_sessions
    WHERE status = 'active'
    ORDER BY started_at_epoch DESC
  `);

  return stmt.all() as ActiveSessionRow[];
}

/**
 * Close a single active session by its database ID.
 * Sets status to 'completed' and records completed_at and completed_at_epoch.
 *
 * Only closes sessions that are currently 'active'.
 * Returns true if a row was updated, false otherwise (non-existent or already completed).
 */
export function closeSessionById(db: Database, sessionDbId: number): boolean {
  const now = new Date();
  const stmt = db.prepare(`
    UPDATE sdk_sessions
    SET
      status = 'completed',
      completed_at = ?,
      completed_at_epoch = ?
    WHERE id = ? AND status = 'active'
  `);

  const result = stmt.run(now.toISOString(), now.getTime(), sessionDbId);
  return result.changes > 0;
}

/**
 * Close all active sessions that started before thresholdEpochMs.
 * Sets status to 'completed' and records completed_at and completed_at_epoch.
 *
 * Returns the number of sessions closed.
 */
export function closeStaleSessionsOlderThan(db: Database, thresholdEpochMs: number): number {
  const now = new Date();
  const stmt = db.prepare(`
    UPDATE sdk_sessions
    SET
      status = 'completed',
      completed_at = ?,
      completed_at_epoch = ?
    WHERE status = 'active' AND started_at_epoch < ?
  `);

  const result = stmt.run(now.toISOString(), now.getTime(), thresholdEpochMs);
  return result.changes;
}
