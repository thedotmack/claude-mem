import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { SessionSummaryRecord } from '../../../types/database.js';
import type { SessionSummary, GetByIdsOptions } from './types.js';

export function getSummaryForSession(
  db: Database,
  memorySessionId: string
): SessionSummary | null {
  const stmt = db.prepare(`
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at,
      created_at_epoch
    FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `);

  return (stmt.get(memorySessionId) as SessionSummary | undefined) || null;
}

export function getSummaryById(
  db: Database,
  id: number
): SessionSummaryRecord | null {
  const stmt = db.prepare(`
    SELECT * FROM session_summaries WHERE id = ?
  `);

  return (stmt.get(id) as SessionSummaryRecord | undefined) || null;
}

export function getSummariesByIds(
  db: Database,
  ids: number[],
  options: GetByIdsOptions = {}
): SessionSummaryRecord[] {
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

  const stmt = db.prepare(`
    SELECT * FROM session_summaries
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `);

  return stmt.all(...params) as SessionSummaryRecord[];
}
