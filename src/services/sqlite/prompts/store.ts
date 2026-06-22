
import type { Database } from 'bun:sqlite';
import { normalizeStoredPromptText } from '../prompt-storage.js';
import { logger } from '../../../utils/logger.js';
import { isCloudEnabled } from '../../cloud/config.js';
import { enqueueOutbox, notifyEnqueued } from '../../cloud/outbox.js';

export function saveUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
  promptText: string
): number {
  const now = new Date();
  const nowEpoch = now.getTime();
  const storedPromptText = normalizeStoredPromptText(promptText);

  // Read the cloud gate ONCE, before the transaction (default off => no-op).
  const cloudEnabled = isCloudEnabled();

  const stmt = db.prepare(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Wrap the base insert + outbox enqueue in one transaction so they commit
  // atomically (all-or-nothing). When cloud is disabled this is a single insert.
  const writeTx = db.transaction(() => {
    const result = stmt.run(contentSessionId, promptNumber, storedPromptText, now.toISOString(), nowEpoch);
    const id = result.lastInsertRowid as number;
    if (cloudEnabled) {
      enqueueOutbox(db, { kind: 'prompt', localId: id, lane: 'live', createdAtEpoch: nowEpoch });
    }
    return id;
  });

  const id = writeTx();
  // Wake the pusher AFTER commit, never inside the txn.
  if (cloudEnabled) notifyEnqueued();

  logger.debug('DB', 'Stored user prompt row', {
    contentSessionId,
    promptNumber,
    storedChars: storedPromptText.length,
  });
  return id;
}
