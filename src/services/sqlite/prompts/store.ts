/**
 * User prompt storage operations
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

/**
 * Save a user prompt to the database
 * @returns The inserted row ID
 */
export function saveUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
  promptText: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  const stmt = db.prepare(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
  return result.lastInsertRowid as number;
}
