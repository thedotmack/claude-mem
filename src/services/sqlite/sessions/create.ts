/**
 * Session creation and update functions
 * Database-first parameter pattern for functional composition
 */

import type { DbAdapter } from '../adapter.js';
import { exec, queryOne } from '../adapter.js';
import { logger } from '../../../utils/logger.js';

/**
 * Create a new SDK session (idempotent - returns existing session ID if already exists)
 *
 * IDEMPOTENCY via INSERT OR IGNORE pattern:
 * - Prompt #1: session_id not in database -> INSERT creates new row
 * - Prompt #2+: session_id exists -> INSERT ignored, fetch existing ID
 * - Result: Same database ID returned for all prompts in conversation
 *
 * Pure get-or-create: never modifies memory_session_id.
 * Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level.
 */
export async function createSDKSession(
  db: DbAdapter,
  contentSessionId: string,
  project: string,
  userPrompt: string,
  customTitle?: string
): Promise<number> {
  const now = new Date();
  const nowEpoch = now.getTime();

  // Check for existing session
  const existing = await queryOne<{ id: number }>(db, `
    SELECT id FROM sdk_sessions WHERE content_session_id = ?
  `, [contentSessionId]);

  if (existing) {
    // Backfill project if session was created by another hook with empty project
    if (project) {
      await exec(db, `
        UPDATE sdk_sessions SET project = ?
        WHERE content_session_id = ? AND (project IS NULL OR project = '')
      `, [project, contentSessionId]);
    }
    // Backfill custom_title if provided and not yet set
    if (customTitle) {
      await exec(db, `
        UPDATE sdk_sessions SET custom_title = ?
        WHERE content_session_id = ? AND custom_title IS NULL
      `, [customTitle, contentSessionId]);
    }
    return existing.id;
  }

  // New session - insert fresh row
  // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
  // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
  // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
  await exec(db, `
    INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, user_prompt, custom_title, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'active')
  `, [contentSessionId, project, userPrompt, customTitle || null, now.toISOString(), nowEpoch]);

  // Return new ID
  const row = await queryOne<{ id: number }>(db, 'SELECT id FROM sdk_sessions WHERE content_session_id = ?', [contentSessionId]);
  return row!.id;
}

/**
 * Update the memory session ID for a session
 * Called by SDKAgent when it captures the session ID from the first SDK message
 * Also used to RESET to null on stale resume failures (worker-service.ts)
 */
export async function updateMemorySessionId(
  db: DbAdapter,
  sessionDbId: number,
  memorySessionId: string | null
): Promise<void> {
  await exec(db, `
    UPDATE sdk_sessions
    SET memory_session_id = ?
    WHERE id = ?
  `, [memorySessionId, sessionDbId]);
}
