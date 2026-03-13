import { Database } from './sqlite-compat.js';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/** Messages processing longer than this are considered stale and reset to pending by self-healing */
const STALE_PROCESSING_THRESHOLD_MS = 60_000;

/** Maximum number of pending messages to recover per session on startup (#1262) */
const MAX_RECOVERY_BATCH_SIZE = 50;

/** Pending messages older than this are deleted during recovery instead of re-queued (#1262) */
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
 * Messages are persisted before processing using a claim-confirm pattern.
 * This simplifies the lifecycle and eliminates duplicate processing bugs.
 *
 * Lifecycle:
 * 1. enqueue() - Message persisted with status 'pending'
 * 2. claimNextMessage() - Atomically claims next pending message (marks as 'processing')
 * 3. confirmProcessed() - Deletes message after successful processing
 *
 * Self-healing:
 * - claimNextMessage() resets stale 'processing' messages (>60s) back to 'pending' before claiming
 * - This eliminates stuck messages from generator crashes without external timers
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
   * Self-healing: resets any stale 'processing' messages (>60s) back to 'pending' first.
   * Message stays in DB until confirmProcessed() is called.
   * Uses a transaction to prevent race conditions.
   */
  claimNextMessage(sessionDbId: number): PersistentPendingMessage | null {
    const claimTx = this.db.transaction((sessionId: number) => {
      // Capture time inside transaction so it's fresh if WAL contention causes retry
      const now = Date.now();
      // Self-healing: reset stale 'processing' messages back to 'pending'
      // This recovers from generator crashes without external timers
      // Note: strict < means messages must be OLDER than threshold to be reset
      const staleCutoff = now - STALE_PROCESSING_THRESHOLD_MS;
      const resetStmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE session_db_id = ? AND status = 'processing'
          AND started_processing_at_epoch < ?
      `);
      const resetResult = resetStmt.run(sessionId, staleCutoff);
      if (resetResult.changes > 0) {
        logger.info('QUEUE', `SELF_HEAL | sessionDbId=${sessionId} | recovered ${resetResult.changes} stale processing message(s)`);
      }

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
  resetStaleProcessingMessages(thresholdMs: number = 5 * 60 * 1000, sessionDbId?: number): number {
    const cutoff = Date.now() - thresholdMs;
    let stmt;
    let result;
    if (sessionDbId !== undefined) {
      stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing' AND started_processing_at_epoch < ? AND session_db_id = ?
      `);
      result = stmt.run(cutoff, sessionDbId);
    } else {
      stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing' AND started_processing_at_epoch < ?
      `);
      result = stmt.run(cutoff);
    }
    if (result.changes > 0) {
      logger.info('QUEUE', `RESET_STALE | count=${result.changes} | thresholdMs=${thresholdMs}${sessionDbId !== undefined ? ` | sessionDbId=${sessionDbId}` : ''}`);
    }

    // Delete messages older than MAX_PENDING_AGE_MS to prevent unbounded queue growth (#1262)
    const ageCutoff = Date.now() - MAX_PENDING_AGE_MS;
    const deleteStmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE created_at_epoch < ? AND status IN ('pending', 'processing')
    `);
    const deleteResult = deleteStmt.run(ageCutoff);
    if (deleteResult.changes > 0) {
      logger.info('QUEUE', `PRUNED_OLD | deleted=${deleteResult.changes} | messages older than 24h`);
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
   * Check if any session has pending work.
   * Excludes 'processing' messages stuck for >5 minutes (resets them to 'pending' as a side effect).
   */
  hasAnyPendingWork(): boolean {
    // Reset stuck 'processing' messages older than 5 minutes before checking
    const stuckCutoff = Date.now() - (5 * 60 * 1000);
    const resetStmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);
    const resetResult = resetStmt.run(stuckCutoff);
    if (resetResult.changes > 0) {
      logger.info('QUEUE', `STUCK_RESET | hasAnyPendingWork reset ${resetResult.changes} stuck processing message(s) older than 5 minutes`);
    }

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
   * Prune excess pending messages per session, keeping only the most recent N (#1262).
   * Deletes older messages beyond MAX_RECOVERY_BATCH_SIZE to prevent unbounded CPU
   * when hundreds of messages accumulated during crashes.
   * @returns Total number of messages deleted across all sessions
   */
  pruneExcessPendingMessages(): number {
    // Get all sessions with pending work
    const sessions = this.getSessionsWithPendingMessages();
    let totalDeleted = 0;

    for (const sessionDbId of sessions) {
      // Find the created_at_epoch cutoff: keep the N most recent, delete the rest
      const cutoffRow = this.db.prepare(`
        SELECT created_at_epoch FROM pending_messages
        WHERE session_db_id = ? AND status IN ('pending', 'processing')
        ORDER BY created_at_epoch DESC
        LIMIT 1 OFFSET ?
      `).get(sessionDbId, MAX_RECOVERY_BATCH_SIZE) as { created_at_epoch: number } | undefined;

      if (cutoffRow) {
        // Delete messages older than the Nth most recent
        const deleteResult = this.db.prepare(`
          DELETE FROM pending_messages
          WHERE session_db_id = ? AND status IN ('pending', 'processing')
            AND created_at_epoch <= ?
        `).run(sessionDbId, cutoffRow.created_at_epoch);

        if (deleteResult.changes > 0) {
          totalDeleted += deleteResult.changes;
          logger.info('QUEUE', `PRUNED_EXCESS | sessionDbId=${sessionDbId} | deleted=${deleteResult.changes} | kept=${MAX_RECOVERY_BATCH_SIZE}`);
        }
      }
    }

    return totalDeleted;
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
