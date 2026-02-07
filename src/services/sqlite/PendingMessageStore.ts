import { Database } from './sqlite-compat.js';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/**
 * Persistent pending message record from database
 */
export interface PersistentPendingMessage {
  id: number;
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  retry_count: number;
  created_at_epoch: number;
  started_processing_at_epoch: number | null;
  completed_at_epoch: number | null;
}

/**
 * PendingMessageStore - Persistent work queue for SDK messages
 *
 * Messages are persisted before processing using a claim-and-delete pattern.
 * This simplifies the lifecycle and eliminates duplicate processing bugs.
 *
 * Lifecycle:
 * 1. enqueue() - Message persisted with status 'pending'
 * 2. claimAndDelete() - Atomically claims and deletes message (process in memory)
 *
 * Recovery:
 * - getSessionsWithPendingMessages() - Find sessions that need recovery on startup
 */
export class PendingMessageStore {
  private db: Database;
  private maxRetries: number;

  constructor(db: Database, maxRetries: number = 3) {
    this.db = db;
    this.maxRetries = maxRetries;
  }

  /**
   * Enqueue a new message (persist before processing)
   * @returns The database ID of the persisted message
   */
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `);

    const result = stmt.run(
      sessionDbId,
      contentSessionId,
      message.type,
      message.tool_name || null,
      message.tool_input ? JSON.stringify(message.tool_input) : null,
      message.tool_response ? JSON.stringify(message.tool_response) : null,
      message.cwd || null,
      message.last_assistant_message || null,
      message.prompt_number || null,
      now
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Atomically claim the next pending message by marking it as 'processing'.
   * CRITICAL FIX: Does NOT delete - message stays in DB until confirmProcessed() is called.
   * This prevents message loss if the generator crashes mid-processing.
   * Uses a transaction to prevent race conditions.
   */
  claimAndDelete(sessionDbId: number): PersistentPendingMessage | null {
    const now = Date.now();
    const claimTx = this.db.transaction((sessionId: number) => {
      const peekStmt = this.db.prepare(`
        SELECT * FROM pending_messages
        WHERE session_db_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `);
      const msg = peekStmt.get(sessionId) as PersistentPendingMessage | null;

      if (msg) {
        // CRITICAL FIX: Mark as 'processing' instead of deleting
        // Message will be deleted by confirmProcessed() after successful store
        const updateStmt = this.db.prepare(`
          UPDATE pending_messages
          SET status = 'processing', started_processing_at_epoch = ?
          WHERE id = ?
        `);
        updateStmt.run(now, msg.id);

        // Log claim with minimal info (avoid logging full payload)
        logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionId} | messageId=${msg.id} | type=${msg.message_type}`, {
          sessionId: sessionId
        });
      }
      return msg;
    });

    return claimTx(sessionDbId) as PersistentPendingMessage | null;
  }

  /**
   * Confirm a message was successfully processed - DELETE it from the queue.
   * CRITICAL: Only call this AFTER the observation/summary has been stored to DB.
   * This prevents message loss on generator crash.
   */
  confirmProcessed(messageId: number): void {
    const stmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
    const result = stmt.run(messageId);
    if (result.changes > 0) {
      logger.debug('QUEUE', `CONFIRMED | messageId=${messageId} | deleted from queue`);
    }
  }

  /**
   * Reset stale 'processing' messages back to 'pending' for retry.
   * Called on worker startup and periodically to recover from crashes.
   * @param thresholdMs Messages processing longer than this are considered stale (default: 5 minutes)
   * @returns Number of messages reset
   */
  resetStaleProcessingMessages(thresholdMs: number = 5 * 60 * 1000): number {
    const cutoff = Date.now() - thresholdMs;
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);
    const result = stmt.run(cutoff);
    if (result.changes > 0) {
      logger.info('QUEUE', `RESET_STALE | count=${result.changes} | thresholdMs=${thresholdMs}`);
    }
    return result.changes;
  }

  /**
   * Get all pending messages for session (ordered by creation time)
   */
  getAllPending(sessionDbId: number): PersistentPendingMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as PersistentPendingMessage[];
  }

  /**
   * Get all queue messages (for UI display)
   * Returns pending, processing, and failed messages (not processed - they're deleted)
   * Joins with sdk_sessions to get project name
   */
  getQueueMessages(): (PersistentPendingMessage & { project: string | null })[] {
    const stmt = this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status IN ('pending', 'processing', 'failed')
      ORDER BY
        CASE pm.status
          WHEN 'failed' THEN 0
          WHEN 'processing' THEN 1
          WHEN 'pending' THEN 2
        END,
        pm.created_at_epoch ASC
    `);
    return stmt.all() as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Get count of stuck messages (processing longer than threshold)
   */
  getStuckCount(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);
    const result = stmt.get(cutoff) as { count: number };
    return result.count;
  }

  /**
   * Retry a specific message (reset to pending)
   * Works for pending (re-queue), processing (reset stuck), and failed messages
   */
  retryMessage(messageId: number): boolean {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE id = ? AND status IN ('pending', 'processing', 'failed')
    `);
    const result = stmt.run(messageId);
    return result.changes > 0;
  }

  /**
   * Reset all processing messages for a session to pending
   * Used when force-restarting a stuck session
   */
  resetProcessingToPending(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status = 'processing'
    `);
    const result = stmt.run(sessionDbId);
    return result.changes;
  }

  /**
   * Mark all processing messages for a session as failed
   * Used in error recovery when session generator crashes
   * @returns Number of messages marked failed
   */
  markSessionMessagesFailed(sessionDbId: number): number {
    const now = Date.now();

    // Atomic update - all processing messages for session → failed
    // Note: This bypasses retry logic since generator failures are session-level,
    // not message-level. Individual message failures use markFailed() instead.
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status = 'processing'
    `);

    const result = stmt.run(now, sessionDbId);
    return result.changes;
  }

  /**
   * Mark all pending and processing messages for a session as failed (abandoned).
   * Used when SDK session is terminated and no fallback agent is available:
   * prevents the session from appearing in getSessionsWithPendingMessages forever.
   * @returns Number of messages marked failed
   */
  markAllSessionMessagesAbandoned(sessionDbId: number): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.run(now, sessionDbId);
    return result.changes;
  }

  /**
   * Abort a specific message (delete from queue)
   */
  abortMessage(messageId: number): boolean {
    const stmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
    const result = stmt.run(messageId);
    return result.changes > 0;
  }

  /**
   * Retry all stuck messages at once
   */
  retryAllStuck(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get recently processed messages (for UI feedback)
   * Shows messages completed in the last N minutes so users can see their stuck items were processed
   */
  getRecentlyProcessed(limit: number = 10, withinMinutes: number = 30): (PersistentPendingMessage & { project: string | null })[] {
    const cutoff = Date.now() - (withinMinutes * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status = 'processed' AND pm.completed_at_epoch > ?
      ORDER BY pm.completed_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(cutoff, limit) as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Mark message as failed (status: pending -> failed or back to pending for retry)
   * If retry_count < maxRetries, moves back to 'pending' for retry
   * Otherwise marks as 'failed' permanently
   */
  markFailed(messageId: number): void {
    const now = Date.now();

    // Get current retry count
    const msg = this.db.prepare('SELECT retry_count FROM pending_messages WHERE id = ?').get(messageId) as { retry_count: number } | undefined;

    if (!msg) return;

    if (msg.retry_count < this.maxRetries) {
      // Move back to pending for retry
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL
        WHERE id = ?
      `);
      stmt.run(messageId);
    } else {
      // Max retries exceeded, mark as permanently failed
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'failed', completed_at_epoch = ?
        WHERE id = ?
      `);
      stmt.run(now, messageId);
    }
  }

  /**
   * Reset stuck messages (processing -> pending if stuck longer than threshold)
   * @param thresholdMs Messages processing longer than this are considered stuck (0 = reset all)
   * @returns Number of messages reset
   */
  resetStuckMessages(thresholdMs: number): number {
    const cutoff = thresholdMs === 0 ? Date.now() : Date.now() - thresholdMs;

    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);

    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get count of pending messages for a session
   */
  getPendingCount(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.get(sessionDbId) as { count: number };
    return result.count;
  }

  /**
   * Check if any session has pending work
   */
  hasAnyPendingWork(): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  /**
   * Get all session IDs that have pending messages (for recovery on startup)
   */
  getSessionsWithPendingMessages(): number[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const results = stmt.all() as { session_db_id: number }[];
    return results.map(r => r.session_db_id);
  }

  /**
   * Get session info for a pending message (for recovery)
   */
  getSessionInfoForMessage(messageId: number): { sessionDbId: number; contentSessionId: string } | null {
    const stmt = this.db.prepare(`
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `);
    const result = stmt.get(messageId) as { session_db_id: number; content_session_id: string } | undefined;
    return result ? { sessionDbId: result.session_db_id, contentSessionId: result.content_session_id } : null;
  }

  /**
   * Clear all failed messages from the queue
   * @returns Number of messages deleted
   */
  clearFailed(): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status = 'failed'
    `);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Clear all pending, processing, and failed messages from the queue
   * Keeps only processed messages (for history)
   * @returns Number of messages deleted
   */
  clearAll(): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status IN ('pending', 'processing', 'failed')
    `);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Convert a PersistentPendingMessage back to PendingMessage format
   */
  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name || undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number || undefined,
      cwd: persistent.cwd || undefined,
      last_assistant_message: persistent.last_assistant_message || undefined
    };
  }
}
