
import type { Database } from 'bun:sqlite';
import { normalizeStoredPromptText } from '../prompt-storage.js';
import { logger } from '../../../utils/logger.js';

export function saveUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
  promptText: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();
  const storedPromptText = normalizeStoredPromptText(promptText);

  const stmt = db.prepare(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(contentSessionId, promptNumber, storedPromptText, now.toISOString(), nowEpoch);
  logger.debug('DB', 'Stored user prompt row', {
    contentSessionId,
    promptNumber,
    storedChars: storedPromptText.length,
  });
  return result.lastInsertRowid as number;
}
