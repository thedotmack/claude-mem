/**
 * Store user prompts (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import { logger } from '../../../utils/logger.js';

export async function saveUserPrompt(
  db: MySQLDatabase,
  contentSessionId: string,
  promptNumber: number,
  promptText: string
): Promise<number> {
  const now = new Date();
  const nowEpoch = now.getTime();
  const result = await db.prepare(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
  return result.insertId;
}
