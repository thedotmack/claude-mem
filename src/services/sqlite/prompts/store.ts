/**
 * User prompt storage operations
 */

import type { DbAdapter } from '../adapter.js';
import { exec } from '../adapter.js';
import { logger } from '../../../utils/logger.js';

/**
 * Save a user prompt to the database
 * @returns The inserted row ID
 */
export async function saveUserPrompt(
  db: DbAdapter,
  contentSessionId: string,
  promptNumber: number,
  promptText: string
): Promise<number> {
  const now = new Date();
  const nowEpoch = now.getTime();

  const result = await exec(db, `
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `, [contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch]);

  return result.lastInsertRowid;
}
