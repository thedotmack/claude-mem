import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { RecentSummary, SummaryWithSessionInfo, FullSummary } from './types.js';

export function getRecentSummaries(
  db: Database,
  project: string,
  limit: number = 10
): RecentSummary[] {
  const stmt = db.prepare(`
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(project, limit) as RecentSummary[];
}

export function getRecentSummariesWithSessionInfo(
  db: Database,
  project: string,
  limit: number = 3
): SummaryWithSessionInfo[] {
  const stmt = db.prepare(`
    SELECT
      memory_session_id, request, learned, completed, next_steps,
      prompt_number, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(project, limit) as SummaryWithSessionInfo[];
}

export function getAllRecentSummaries(
  db: Database,
  limit: number = 50
): FullSummary[] {
  const stmt = db.prepare(`
    SELECT id, request, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, project, prompt_number,
           created_at, created_at_epoch
    FROM session_summaries
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(limit) as FullSummary[];
}
