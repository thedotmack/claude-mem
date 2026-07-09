/**
 * Get user prompts (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import type { UserPromptRecord, LatestPromptResult } from '../../../types/database.js';
import type { RecentUserPromptResult, PromptWithProject, GetPromptsByIdsOptions } from './types.js';

export async function getUserPrompt(
  db: MySQLDatabase, contentSessionId: string, promptNumber: number
): Promise<string | null> {
  const result = await db.prepare(`
    SELECT prompt_text FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ? LIMIT 1
  `).get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
  return result?.prompt_text ?? null;
}

export async function getPromptNumberFromUserPrompts(
  db: MySQLDatabase, contentSessionId: string
): Promise<number> {
  const result = await db.prepare(
    'SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?'
  ).get(contentSessionId) as { count: number };
  return result.count;
}

export async function getLatestUserPrompt(
  db: MySQLDatabase, contentSessionId: string
): Promise<LatestPromptResult | undefined> {
  return await db.prepare(`
    SELECT up.*, s.memory_session_id, s.project
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
    ORDER BY up.created_at_epoch DESC LIMIT 1
  `).get(contentSessionId) as LatestPromptResult | undefined;
}

export async function getAllRecentUserPrompts(
  db: MySQLDatabase, limit: number = 100
): Promise<RecentUserPromptResult[]> {
  return await db.prepare(`
    SELECT up.id, up.content_session_id, s.project, up.prompt_number,
           up.prompt_text, up.created_at, up.created_at_epoch
    FROM user_prompts up
    LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    ORDER BY up.created_at_epoch DESC LIMIT ?
  `).all(limit) as RecentUserPromptResult[];
}

export async function getPromptById(
  db: MySQLDatabase, id: number
): Promise<PromptWithProject | null> {
  return await db.prepare(`
    SELECT p.id, p.content_session_id, p.prompt_number, p.prompt_text,
           s.project, p.created_at, p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id = ? LIMIT 1
  `).get(id) as PromptWithProject || null;
}

export async function getPromptsByIds(
  db: MySQLDatabase, ids: number[]
): Promise<PromptWithProject[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return await db.prepare(`
    SELECT p.id, p.content_session_id, p.prompt_number, p.prompt_text,
           s.project, p.created_at, p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id IN (${placeholders})
    ORDER BY p.created_at_epoch DESC
  `).all(...ids) as PromptWithProject[];
}

export async function getUserPromptsByIds(
  db: MySQLDatabase, ids: number[], options: GetPromptsByIdsOptions = {}
): Promise<UserPromptRecord[]> {
  if (ids.length === 0) return [];
  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];
  const projectFilter = project ? 'AND s.project = ?' : '';
  if (project) params.push(project);

  return await db.prepare(`
    SELECT up.*, s.project, s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.id IN (${placeholders}) ${projectFilter}
    ORDER BY up.created_at_epoch ${orderClause} ${limitClause}
  `).all(...params) as UserPromptRecord[];
}
