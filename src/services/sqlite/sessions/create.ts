/**
 * Session creation and update functions
 * Database-first parameter pattern for functional composition
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

/**
 * Create a new SDK session (idempotent - returns existing session ID if already exists)
 *
 * IDEMPOTENCY via INSERT OR IGNORE pattern:
 * - Prompt #1: session_id not in database -> INSERT creates new row
 * - Prompt #2+: session_id exists -> INSERT ignored, fetch existing ID
 * - Result: Same database ID returned for all prompts in conversation
 *
 * WHY THIS MATTERS:
 * - NO "does session exist?" checks needed anywhere
 * - NO risk of creating duplicate sessions
 * - ALL hooks automatically connected via session_id
 * - SAVE hook observations go to correct session (same session_id)
 * - SDKAgent continuation prompt has correct context (same session_id)
 */
export function createSDKSession(
  db: Database,
  contentSessionId: string,
  project: string,
  userPrompt: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  // Pure INSERT OR IGNORE - no updates, no complexity
  // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
  // response and stored via updateMemorySessionId(). CRITICAL: memory_session_id must NEVER
  // equal contentSessionId - that would inject memory messages into the user's transcript!
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
    (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), nowEpoch);

  // Return existing or new ID
  const row = db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
    .get(contentSessionId) as { id: number };
  return row.id;
}

/**
 * Update the memory session ID for a session
 * Called by SDKAgent when it captures the session ID from the first SDK message
 */
export function updateMemorySessionId(
  db: Database,
  sessionDbId: number,
  memorySessionId: string
): void {
  db.prepare(`
    UPDATE sdk_sessions
    SET memory_session_id = ?
    WHERE id = ?
  `).run(memorySessionId, sessionDbId);
}
