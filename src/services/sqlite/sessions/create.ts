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
 * Pure get-or-create: never modifies memory_session_id.
 * Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level.
 */
export function createSDKSession(
  db: Database,
  contentSessionId: string,
  project: string,
  userPrompt: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  // Check for existing session
  const existing = db.prepare(`
    SELECT id FROM sdk_sessions WHERE content_session_id = ?
  `).get(contentSessionId) as { id: number } | undefined;

  if (existing) {
    // Backfill project if session was created by another hook with empty project
    if (project) {
      db.prepare(`
        UPDATE sdk_sessions SET project = ?
        WHERE content_session_id = ? AND (project IS NULL OR project = '')
      `).run(project, contentSessionId);
    }
    return existing.id;
  }

  // New session - insert fresh row
  // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
  // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
  // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
  db.prepare(`
    INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), nowEpoch);

  // Return new ID
  const row = db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
    .get(contentSessionId) as { id: number };
  return row.id;
}

/**
 * Update the memory session ID for a session
 * Called by SDKAgent when it captures the session ID from the first SDK message
 * Also used to RESET to null on stale resume failures (worker-service.ts)
 */
export function updateMemorySessionId(
  db: Database,
  sessionDbId: number,
  memorySessionId: string | null
): void {
  db.prepare(`
    UPDATE sdk_sessions
    SET memory_session_id = ?
    WHERE id = ?
  `).run(memorySessionId, sessionDbId);
}
