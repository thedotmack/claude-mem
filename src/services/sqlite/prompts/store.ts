
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export function saveUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
  promptText: string,
  sourceEventId?: string
): number {
  const normalizedSourceEventId = sourceEventId?.trim() || null;
  if (normalizedSourceEventId) {
    const existing = db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND source_event_id = ?
    `).get(contentSessionId, normalizedSourceEventId) as { id: number } | undefined;
    if (existing) return existing.id;
  }

  const existingByNumber = db.prepare(`
    SELECT id FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ?
  `).get(contentSessionId, promptNumber) as { id: number } | undefined;
  if (existingByNumber) return existingByNumber.id;

  const now = new Date();
  const nowEpoch = now.getTime();

  const stmt = db.prepare(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, source_event_id, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(contentSessionId, promptNumber, normalizedSourceEventId, promptText, now.toISOString(), nowEpoch);
  return result.lastInsertRowid as number;
}
