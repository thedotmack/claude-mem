/**
 * User prompt retrieval operations
 */

import type { DbAdapter } from '../adapter.js';
import { queryOne, queryAll } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import type { UserPromptRecord, LatestPromptResult } from '../../../types/database.js';
import type { RecentUserPromptResult, PromptWithProject, GetPromptsByIdsOptions } from './types.js';

/**
 * Get user prompt by session ID and prompt number
 * @returns The prompt text, or null if not found
 */
export async function getUserPrompt(
  db: DbAdapter,
  contentSessionId: string,
  promptNumber: number
): Promise<string | null> {
  const result = await queryOne<{ prompt_text: string }>(db, `
    SELECT prompt_text
    FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ?
    LIMIT 1
  `, [contentSessionId, promptNumber]);
  return result?.prompt_text ?? null;
}

/**
 * Get current prompt number by counting user_prompts for this session
 * Replaces the prompt_counter column which is no longer maintained
 */
export async function getPromptNumberFromUserPrompts(db: DbAdapter, contentSessionId: string): Promise<number> {
  const result = await queryOne<{ count: number }>(db, `
    SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
  `, [contentSessionId]);
  return result!.count;
}

/**
 * Get latest user prompt with session info for a Claude session
 * Used for syncing prompts to Chroma during session initialization
 */
export async function getLatestUserPrompt(
  db: DbAdapter,
  contentSessionId: string
): Promise<LatestPromptResult | undefined> {
  const result = await queryOne<LatestPromptResult>(db, `
    SELECT
      up.*,
      s.memory_session_id,
      s.project
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `, [contentSessionId]);
  return result ?? undefined;
}

/**
 * Get recent user prompts across all sessions (for web UI)
 */
export async function getAllRecentUserPrompts(
  db: DbAdapter,
  limit: number = 100
): Promise<RecentUserPromptResult[]> {
  return queryAll<RecentUserPromptResult>(db, `
    SELECT
      up.id,
      up.content_session_id,
      s.project,
      up.prompt_number,
      up.prompt_text,
      up.created_at,
      up.created_at_epoch
    FROM user_prompts up
    LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    ORDER BY up.created_at_epoch DESC
    LIMIT ?
  `, [limit]);
}

/**
 * Get a single user prompt by ID
 */
export async function getPromptById(db: DbAdapter, id: number): Promise<PromptWithProject | null> {
  return queryOne<PromptWithProject>(db, `
    SELECT
      p.id,
      p.content_session_id,
      p.prompt_number,
      p.prompt_text,
      s.project,
      p.created_at,
      p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id = ?
    LIMIT 1
  `, [id]);
}

/**
 * Get multiple user prompts by IDs
 */
export async function getPromptsByIds(db: DbAdapter, ids: number[]): Promise<PromptWithProject[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return queryAll<PromptWithProject>(db, `
    SELECT
      p.id,
      p.content_session_id,
      p.prompt_number,
      p.prompt_text,
      s.project,
      p.created_at,
      p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id IN (${placeholders})
    ORDER BY p.created_at_epoch DESC
  `, ids);
}

/**
 * Get user prompts by IDs (for hybrid Chroma search)
 * Returns prompts in specified temporal order with optional project filter
 */
export async function getUserPromptsByIds(
  db: DbAdapter,
  ids: number[],
  options: GetPromptsByIdsOptions = {}
): Promise<UserPromptRecord[]> {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  const projectFilter = project ? 'AND s.project = ?' : '';
  if (project) params.push(project);

  return queryAll<UserPromptRecord>(db, `
    SELECT
      up.*,
      s.project,
      s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.id IN (${placeholders}) ${projectFilter}
    ORDER BY up.created_at_epoch ${orderClause}
    ${limitClause}
  `, params);
}
