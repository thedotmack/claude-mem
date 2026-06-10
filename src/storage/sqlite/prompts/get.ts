
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { LatestPromptResult } from '../../../types/database.js';
import { DEFAULT_PLATFORM_SOURCE } from '../../../shared/platform-source.js';

export function findRecentDuplicateUserPrompt(
  db: Database,
  contentSessionId: string,
  promptText: string,
  windowMs: number
): LatestPromptResult | undefined {
  const cutoffEpoch = Date.now() - windowMs;
  const stmt = db.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `);

  return (stmt.get(contentSessionId, promptText, cutoffEpoch) as LatestPromptResult | null) ?? undefined;
}
