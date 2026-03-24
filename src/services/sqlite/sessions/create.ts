/**
 * Session creation and update functions
 * Database-first parameter pattern for functional composition
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../../shared/platform-source.js';

function resolveCreateSessionArgs(
  customTitle?: string,
  platformSource?: string
): { customTitle?: string; platformSource?: string } {
  return {
    customTitle,
    platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined
  };
}

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
  userPrompt: string,
  customTitle?: string,
  platformSource?: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();
  const resolved = resolveCreateSessionArgs(customTitle, platformSource);
  const normalizedPlatformSource = resolved.platformSource ?? DEFAULT_PLATFORM_SOURCE;

  // Check for existing session
  const existing = db.prepare(`
    SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
  `).get(contentSessionId) as { id: number; platform_source: string | null } | undefined;

  if (existing) {
    // Backfill project if session was created by another hook with empty project
    if (project) {
      db.prepare(`
        UPDATE sdk_sessions SET project = ?
        WHERE content_session_id = ? AND (project IS NULL OR project = '')
      `).run(project, contentSessionId);
    }
    // Backfill custom_title if provided and not yet set
    if (resolved.customTitle) {
      db.prepare(`
        UPDATE sdk_sessions SET custom_title = ?
        WHERE content_session_id = ? AND custom_title IS NULL
      `).run(resolved.customTitle, contentSessionId);
    }

    if (resolved.platformSource) {
      const storedPlatformSource = existing.platform_source?.trim()
        ? normalizePlatformSource(existing.platform_source)
        : undefined;

      if (!storedPlatformSource) {
        db.prepare(`
          UPDATE sdk_sessions SET platform_source = ?
          WHERE content_session_id = ?
            AND COALESCE(platform_source, '') = ''
        `).run(resolved.platformSource, contentSessionId);
      } else if (storedPlatformSource !== resolved.platformSource) {
        throw new Error(
          `Platform source conflict for session ${contentSessionId}: existing=${storedPlatformSource}, received=${resolved.platformSource}`
        );
      }
    }
    return existing.id;
  }

  // New session - insert fresh row
  // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
  // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
  // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
  db.prepare(`
    INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch);

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
