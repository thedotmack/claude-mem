/**
 * Get session summaries from the database
 */
import type { DbAdapter } from '../adapter.js';
import { queryOne, queryAll } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import type { SessionSummaryRecord } from '../../../types/database.js';
import type { SessionSummary, GetByIdsOptions } from './types.js';

/**
 * Get summary for a specific session
 *
 * @param db - Database adapter
 * @param memorySessionId - SDK memory session ID
 * @returns Most recent summary for the session, or null if none exists
 */
export async function getSummaryForSession(
  db: DbAdapter,
  memorySessionId: string
): Promise<SessionSummary | null> {
  return queryOne<SessionSummary>(db, `
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at,
      created_at_epoch
    FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `, [memorySessionId]);
}

/**
 * Get a single session summary by ID
 *
 * @param db - Database adapter
 * @param id - Summary ID
 * @returns Full summary record or null if not found
 */
export async function getSummaryById(
  db: DbAdapter,
  id: number
): Promise<SessionSummaryRecord | null> {
  return queryOne<SessionSummaryRecord>(db, `
    SELECT * FROM session_summaries WHERE id = ?
  `, [id]);
}

/**
 * Get session summaries by IDs (for hybrid Chroma search)
 * Returns summaries in specified temporal order
 *
 * @param db - Database adapter
 * @param ids - Array of summary IDs
 * @param options - Query options (orderBy, limit, project)
 */
export async function getSummariesByIds(
  db: DbAdapter,
  ids: number[],
  options: GetByIdsOptions = {}
): Promise<SessionSummaryRecord[]> {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  // Apply project filter
  const whereClause = project
    ? `WHERE id IN (${placeholders}) AND project = ?`
    : `WHERE id IN (${placeholders})`;
  if (project) params.push(project);

  return queryAll<SessionSummaryRecord>(db, `
    SELECT * FROM session_summaries
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `, params);
}
