/**
 * Session retrieval functions
 * Database-first parameter pattern for functional composition
 */

import type { DbAdapter } from '../adapter.js';
import { queryOne, queryAll } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import type {
  SessionBasic,
  SessionFull,
  SessionWithStatus,
  SessionSummaryDetail,
} from './types.js';

/**
 * Get session by ID (basic fields only)
 */
export async function getSessionById(db: DbAdapter, id: number): Promise<SessionBasic | null> {
  return queryOne<SessionBasic>(db, `
    SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title
    FROM sdk_sessions
    WHERE id = ?
    LIMIT 1
  `, [id]);
}

/**
 * Get SDK sessions by memory session IDs
 * Used for exporting session metadata
 */
export async function getSdkSessionsBySessionIds(
  db: DbAdapter,
  memorySessionIds: string[]
): Promise<SessionFull[]> {
  if (memorySessionIds.length === 0) return [];

  const placeholders = memorySessionIds.map(() => '?').join(',');
  return queryAll<SessionFull>(db, `
    SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title,
           started_at, started_at_epoch, completed_at, completed_at_epoch, status
    FROM sdk_sessions
    WHERE memory_session_id IN (${placeholders})
    ORDER BY started_at_epoch DESC
  `, memorySessionIds);
}

/**
 * Get recent sessions with their status and summary info
 * Returns sessions ordered oldest-first for display
 */
export async function getRecentSessionsWithStatus(
  db: DbAdapter,
  project: string,
  limit: number = 3
): Promise<SessionWithStatus[]> {
  return queryAll<SessionWithStatus>(db, `
    SELECT * FROM (
      SELECT
        s.memory_session_id,
        s.status,
        s.started_at,
        s.started_at_epoch,
        s.user_prompt,
        CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
      FROM sdk_sessions s
      LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
      WHERE s.project = ? AND s.memory_session_id IS NOT NULL
      GROUP BY s.memory_session_id
      ORDER BY s.started_at_epoch DESC
      LIMIT ?
    )
    ORDER BY started_at_epoch ASC
  `, [project, limit]);
}

/**
 * Get full session summary by ID (includes request_summary and learned_summary)
 */
export async function getSessionSummaryById(
  db: DbAdapter,
  id: number
): Promise<SessionSummaryDetail | null> {
  return queryOne<SessionSummaryDetail>(db, `
    SELECT
      s.id,
      s.memory_session_id,
      s.content_session_id,
      s.project,
      s.user_prompt,
      ss.request AS request_summary,
      ss.learned AS learned_summary,
      s.status,
      ss.created_at,
      ss.created_at_epoch
    FROM sdk_sessions s
    LEFT JOIN session_summaries ss ON s.memory_session_id = ss.memory_session_id
    WHERE s.id = ?
    ORDER BY ss.created_at_epoch DESC
    LIMIT 1
  `, [id]);
}
