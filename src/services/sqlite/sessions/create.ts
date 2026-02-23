/**
 * Session creation and update functions
 * Database-first parameter pattern for functional composition
 */

import type { Database } from '../sqlite-compat.js';

/**
 * Create a new SDK session (idempotent via INSERT OR IGNORE).
 * Returns the same database ID for all calls with the same contentSessionId.
 *
 * On subsequent calls: updates project (last non-empty wins) and
 * backfills userPrompt (first non-empty wins).
 */
export function createSDKSession(
  db: Database,
  contentSessionId: string,
  project: string,
  userPrompt: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  // memory_session_id starts NULL, set later by SDKAgent via updateMemorySessionId().
  // CRITICAL: memory_session_id must NEVER equal contentSessionId -- that would
  // inject memory messages into the user's transcript.
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
    (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), nowEpoch);

  // Update project when non-empty (last non-empty wins).
  // Covers backfill after race condition and project change on resume.
  if (project) {
    db.prepare('UPDATE sdk_sessions SET project = ? WHERE content_session_id = ?')
      .run(project, contentSessionId);
  }

  // Backfill userPrompt only when currently empty (first non-empty wins).
  // Unlike project (tracks cwd), userPrompt records the session's initial request.
  if (userPrompt) {
    db.prepare(`
      UPDATE sdk_sessions SET user_prompt = ?
      WHERE content_session_id = ? AND (user_prompt IS NULL OR user_prompt = '')
    `).run(userPrompt, contentSessionId);
  }

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
