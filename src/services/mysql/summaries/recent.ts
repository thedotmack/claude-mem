/**
 * Recent summaries (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import type { RecentSummary, SummaryWithSessionInfo, FullSummary } from './types.js';

export async function getRecentSummaries(
  db: MySQLDatabase, project: string, limit: number = 10
): Promise<RecentSummary[]> {
  return await db.prepare(`
    SELECT \`request\`, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, prompt_number, created_at
    FROM session_summaries WHERE project = ?
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(project, limit) as RecentSummary[];
}

export async function getRecentSummariesWithSessionInfo(
  db: MySQLDatabase, project: string, limit: number = 3
): Promise<SummaryWithSessionInfo[]> {
  return await db.prepare(`
    SELECT memory_session_id, \`request\`, learned, completed, next_steps,
           prompt_number, created_at
    FROM session_summaries WHERE project = ?
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(project, limit) as SummaryWithSessionInfo[];
}

export async function getAllRecentSummaries(
  db: MySQLDatabase, limit: number = 50
): Promise<FullSummary[]> {
  return await db.prepare(`
    SELECT id, \`request\`, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, project, prompt_number,
           created_at, created_at_epoch
    FROM session_summaries ORDER BY created_at_epoch DESC LIMIT ?
  `).all(limit) as FullSummary[];
}
