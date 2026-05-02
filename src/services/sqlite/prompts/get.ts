
import type { Database } from 'bun:sqlite';
import type { UserPromptRecord, LatestPromptResult } from '../../../types/database.js';
import type { GetPromptsByIdsOptions } from './types.js';

export function getUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number
): string | null {
  const stmt = db.prepare(`
    SELECT prompt_text
    FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ?
    LIMIT 1
  `);

  const result = stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
  return result?.prompt_text ?? null;
}

export function getPromptNumberFromUserPrompts(db: Database, contentSessionId: string): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
  `).get(contentSessionId) as { count: number };
  return result.count;
}

export function getLatestUserPrompt(
  db: Database,
  contentSessionId: string
): LatestPromptResult | undefined {
  const stmt = db.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `);

  return stmt.get(contentSessionId) as LatestPromptResult | undefined;
}

export function getUserPromptsByIds(
  db: Database,
  ids: number[],
  options: GetPromptsByIdsOptions = {}
): UserPromptRecord[] {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  const projectFilter = project ? 'AND s.project = ?' : '';
  if (project) params.push(project);

  const stmt = db.prepare(`
    SELECT
      up.*,
      s.project,
      s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.id IN (${placeholders}) ${projectFilter}
    ORDER BY up.created_at_epoch ${orderClause}
    ${limitClause}
  `);

  return stmt.all(...params) as UserPromptRecord[];
}
