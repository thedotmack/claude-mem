import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

/** Sessions idle this long with no queue progress are considered orphaned. */
const DEFAULT_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export interface StalePendingSweepResult {
  staleSessions: number;
  deletedMessages: number;
  failedSessions: number;
}

export interface StalePendingSweepOptions {
  thresholdMs?: number;
  now?: number;
}

/**
 * Clear pending_messages left behind by sessions that never got an SDK
 * processor (e.g. sessions that fire INIT_COMPLETE then die). Such rows sit
 * on status='pending' forever and inflate the WebUI "unprocessed" counter.
 *
 * A session is swept when its NEWEST pending_message predates the threshold
 * AND it is not in `activeSessionIds`. Its pending_messages are deleted and an
 * 'active' session is marked 'failed'.
 */
export function sweepStalePendingMessages(
  db: Database,
  activeSessionIds: Iterable<number>,
  options: StalePendingSweepOptions = {},
): StalePendingSweepResult {
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const now = options.now ?? Date.now();
  const cutoff = now - thresholdMs;
  const active = activeSessionIds instanceof Set
    ? activeSessionIds
    : new Set<number>(activeSessionIds);

  const result: StalePendingSweepResult = { staleSessions: 0, deletedMessages: 0, failedSessions: 0 };

  const candidates = db.prepare(
    `SELECT session_db_id AS sid, COUNT(*) AS n
       FROM pending_messages
      GROUP BY session_db_id
     HAVING MAX(created_at_epoch) < ?`
  ).all(cutoff) as { sid: number; n: number }[];

  const stale = candidates.filter(c => !active.has(c.sid));
  if (stale.length === 0) return result;

  const deletePending = db.prepare('DELETE FROM pending_messages WHERE session_db_id = ?');
  const failSession = db.prepare(
    `UPDATE sdk_sessions
        SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ? AND status = 'active'`
  );
  const nowIso = new Date(now).toISOString();

  db.run('BEGIN IMMEDIATE');
  try {
    for (const c of stale) {
      deletePending.run(c.sid);
      result.deletedMessages += c.n;
      if (failSession.run(nowIso, now, c.sid).changes > 0) result.failedSessions += 1;
      result.staleSessions += 1;
    }
    db.run('COMMIT');
  } catch (err: unknown) {
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  logger.info('SYSTEM', 'Stale pending_messages sweep complete', { ...result });
  return result;
}
