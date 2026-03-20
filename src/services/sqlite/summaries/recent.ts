/**
 * Get recent session summaries from the database
 */
import type { DbAdapter } from '../adapter.js';
import { queryAll } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import type { RecentSummary, SummaryWithSessionInfo, FullSummary } from './types.js';

/**
 * Get recent session summaries for a project
 *
 * @param db - Database adapter
 * @param project - Project name to filter by
 * @param limit - Maximum number of summaries to return (default 10)
 */
export async function getRecentSummaries(
  db: DbAdapter,
  project: string,
  limit: number = 10
): Promise<RecentSummary[]> {
  return queryAll<RecentSummary>(db, `
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [project, limit]);
}

/**
 * Get recent summaries with session info for context display
 *
 * @param db - Database adapter
 * @param project - Project name to filter by
 * @param limit - Maximum number of summaries to return (default 3)
 */
export async function getRecentSummariesWithSessionInfo(
  db: DbAdapter,
  project: string,
  limit: number = 3
): Promise<SummaryWithSessionInfo[]> {
  return queryAll<SummaryWithSessionInfo>(db, `
    SELECT
      memory_session_id, request, learned, completed, next_steps,
      prompt_number, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [project, limit]);
}

/**
 * Get recent summaries across all projects (for web UI)
 *
 * @param db - Database adapter
 * @param limit - Maximum number of summaries to return (default 50)
 */
export async function getAllRecentSummaries(
  db: DbAdapter,
  limit: number = 50
): Promise<FullSummary[]> {
  return queryAll<FullSummary>(db, `
    SELECT id, request, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, project, prompt_number,
           created_at, created_at_epoch
    FROM session_summaries
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [limit]);
}
