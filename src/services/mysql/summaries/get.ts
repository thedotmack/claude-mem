/**
 * Get summaries (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import type { SessionSummaryRecord } from '../../../types/database.js';
import type { SessionSummary, GetByIdsOptions } from './types.js';

export async function getSummaryForSession(
  db: MySQLDatabase, memorySessionId: string
): Promise<SessionSummary | null> {
  return await db.prepare(`
    SELECT \`request\`, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, prompt_number, created_at, created_at_epoch
    FROM session_summaries WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC LIMIT 1
  `).get(memorySessionId) as SessionSummary || null;
}

export async function getSummaryById(
  db: MySQLDatabase, id: number
): Promise<SessionSummaryRecord | null> {
  return await db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(id) as SessionSummaryRecord || null;
}

export async function getSummariesByIds(
  db: MySQLDatabase, ids: number[], options: GetByIdsOptions = {}
): Promise<SessionSummaryRecord[]> {
  if (ids.length === 0) return [];
  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];
  const whereClause = project
    ? `WHERE id IN (${placeholders}) AND project = ?`
    : `WHERE id IN (${placeholders})`;
  if (project) params.push(project);

  return await db.prepare(`
    SELECT * FROM session_summaries ${whereClause}
    ORDER BY created_at_epoch ${orderClause} ${limitClause}
  `).all(...params) as SessionSummaryRecord[];
}
