import { Database } from '../sqlite/sqlite-compat.js';
import type { QueueMessage, EnqueuePayload } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * SimpleQueue - Dead-simple persistent work queue
 *
 * No state machine, no retries, no recovery logic.
 * Messages are added, peeked, and removed. That's it.
 *
 * Reuses the existing pending_messages table schema but ignores
 * status columns - we just use id for ordering.
 */
export class SimpleQueue {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Add a message to the queue
   * @returns The database ID of the queued message
   */
  enqueue(sessionDbId: number, claudeSessionId: string, payload: EnqueuePayload): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, claude_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `);

    const result = stmt.run(
      sessionDbId,
      claudeSessionId,
      payload.type,
      payload.tool_name || null,
      payload.tool_input ? JSON.stringify(payload.tool_input) : null,
      payload.tool_response ? JSON.stringify(payload.tool_response) : null,
      payload.cwd || null,
      payload.last_user_message || null,
      payload.last_assistant_message || null,
      payload.prompt_number || null,
      now
    );

    const id = result.lastInsertRowid as number;
    logger.debug('SimpleQueue', `Enqueued message ${id} for session ${claudeSessionId}`);
    return id;
  }

  /**
   * Get the oldest message without removing it
   * @returns The oldest message or null if queue is empty
   */
  peek(): QueueMessage | null {
    const stmt = this.db.prepare(`
      SELECT
        id, session_db_id, claude_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message,
        prompt_number, created_at_epoch
      FROM pending_messages
      WHERE status IN ('pending', 'processing')
      ORDER BY id ASC
      LIMIT 1
    `);
    return stmt.get() as QueueMessage | null;
  }

  /**
   * Remove a message from the queue
   */
  remove(id: number): void {
    const stmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
    stmt.run(id);
    logger.debug('SimpleQueue', `Removed message ${id}`);
  }

  /**
   * Get total count of messages in queue
   */
  count(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Get all messages in the queue (for debugging/UI)
   */
  getAll(): QueueMessage[] {
    const stmt = this.db.prepare(`
      SELECT
        id, session_db_id, claude_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message,
        prompt_number, created_at_epoch
      FROM pending_messages
      WHERE status IN ('pending', 'processing')
      ORDER BY id ASC
    `);
    return stmt.all() as QueueMessage[];
  }

  /**
   * Purge all messages from the queue
   * @returns Number of messages deleted
   */
  purge(): number {
    const stmt = this.db.prepare("DELETE FROM pending_messages WHERE status IN ('pending', 'processing')");
    const result = stmt.run();
    logger.info('SimpleQueue', `Purged ${result.changes} messages`);
    return result.changes;
  }
}
