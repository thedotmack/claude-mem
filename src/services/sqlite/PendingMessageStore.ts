import type { DbAdapter } from './adapter.js';
import { exec, queryOne, queryAll } from './adapter.js';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/** Messages processing longer than this are considered stale and reset to pending by self-healing */
const STALE_PROCESSING_THRESHOLD_MS = 60_000;

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
  private db: DbAdapter;
  private maxRetries: number;

  constructor(db: DbAdapter, maxRetries: number = 3) {
    this.db = db;
    this.maxRetries = maxRetries;
  }

  /**
   * Enqueue a new message (persist before processing)
   * @returns The database ID of the persisted message
   */
  async enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number> {
    const now = Date.now();
    const result = await exec(this.db, `
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `, [
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
    ]);

    return result.lastInsertRowid;
  }

  /**
   * Atomically claim the next pending message by marking it as 'processing'.
   * Self-healing: resets any stale 'processing' messages (>60s) back to 'pending' first.
   * Message stays in DB until confirmProcessed() is called.
   *
   * The claim itself is a single atomic UPDATE with a subquery, eliminating the
   * race condition where two callers could SELECT the same row before either UPDATEs.
   */
  async claimNextMessage(sessionDbId: number): Promise<PersistentPendingMessage | null> {
    const now = Date.now();

    // Self-healing: reset stale 'processing' messages back to 'pending'
    const staleCutoff = now - STALE_PROCESSING_THRESHOLD_MS;
    const resetResult = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status = 'processing'
        AND started_processing_at_epoch < ?
    `, [sessionDbId, staleCutoff]);
    if (resetResult.rowsAffected > 0) {
      logger.info('QUEUE', `SELF_HEAL | sessionDbId=${sessionDbId} | recovered ${resetResult.rowsAffected} stale processing message(s)`);
    }

    // Atomic claim: UPDATE with subquery ensures only one caller can claim a given row.
    // If two callers race, the subquery sees status='pending' so only the first UPDATE
    // matches; the second finds no pending row (or a different one).
    const claimResult = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'processing', started_processing_at_epoch = ?
      WHERE id = (
        SELECT id FROM pending_messages
        WHERE session_db_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      )
    `, [now, sessionDbId]);

    if (claimResult.rowsAffected === 0) {
      return null;
    }

    // Fetch the claimed row by its processing timestamp and session
    const msg = await queryOne<PersistentPendingMessage>(this.db, `
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'processing' AND started_processing_at_epoch = ?
      ORDER BY id ASC
      LIMIT 1
    `, [sessionDbId, now]);

    if (msg) {
      logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${msg.id} | type=${msg.message_type}`, {
        sessionId: sessionDbId
      });
    }

    return msg;
  }

  /**
   * Confirm a message was successfully processed - DELETE it from the queue.
   */
  async confirmProcessed(messageId: number): Promise<void> {
    const result = await exec(this.db, 'DELETE FROM pending_messages WHERE id = ?', [messageId]);
    if (result.rowsAffected > 0) {
      logger.debug('QUEUE', `CONFIRMED | messageId=${messageId} | deleted from queue`);
    }
  }

  /**
   * Reset stale 'processing' messages back to 'pending' for retry.
   */
  async resetStaleProcessingMessages(thresholdMs: number = 5 * 60 * 1000, sessionDbId?: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    let result;
    if (sessionDbId !== undefined) {
      result = await exec(this.db, `
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing' AND started_processing_at_epoch < ? AND session_db_id = ?
      `, [cutoff, sessionDbId]);
    } else {
      result = await exec(this.db, `
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing' AND started_processing_at_epoch < ?
      `, [cutoff]);
    }
    if (result.rowsAffected > 0) {
      logger.info('QUEUE', `RESET_STALE | count=${result.rowsAffected} | thresholdMs=${thresholdMs}${sessionDbId !== undefined ? ` | sessionDbId=${sessionDbId}` : ''}`);
    }
    return result.rowsAffected;
  }

  /**
   * Get all pending messages for session (ordered by creation time)
   */
  async getAllPending(sessionDbId: number): Promise<PersistentPendingMessage[]> {
    return queryAll<PersistentPendingMessage>(this.db, `
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
    `, [sessionDbId]);
  }

  /**
   * Get all queue messages (for UI display)
   */
  async getQueueMessages(): Promise<(PersistentPendingMessage & { project: string | null })[]> {
    return queryAll<PersistentPendingMessage & { project: string | null }>(this.db, `
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
  }

  /**
   * Get count of stuck messages (processing longer than threshold)
   */
  async getStuckCount(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await queryOne<{ count: number }>(this.db, `
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `, [cutoff]);
    return result!.count;
  }

  /**
   * Retry a specific message (reset to pending)
   */
  async retryMessage(messageId: number): Promise<boolean> {
    const result = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE id = ? AND status IN ('pending', 'processing', 'failed')
    `, [messageId]);
    return result.rowsAffected > 0;
  }

  /**
   * Reset all processing messages for a session to pending
   */
  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const result = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status = 'processing'
    `, [sessionDbId]);
    return result.rowsAffected;
  }

  /**
   * Mark all processing messages for a session as failed
   */
  async markSessionMessagesFailed(sessionDbId: number): Promise<number> {
    const now = Date.now();
    const result = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status = 'processing'
    `, [now, sessionDbId]);
    return result.rowsAffected;
  }

  /**
   * Mark all pending and processing messages for a session as failed (abandoned).
   */
  async markAllSessionMessagesAbandoned(sessionDbId: number): Promise<number> {
    const now = Date.now();
    const result = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `, [now, sessionDbId]);
    return result.rowsAffected;
  }

  /**
   * Abort a specific message (delete from queue)
   */
  async abortMessage(messageId: number): Promise<boolean> {
    const result = await exec(this.db, 'DELETE FROM pending_messages WHERE id = ?', [messageId]);
    return result.rowsAffected > 0;
  }

  /**
   * Retry all stuck messages at once
   */
  async retryAllStuck(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `, [cutoff]);
    return result.rowsAffected;
  }

  /**
   * Get recently processed messages (for UI feedback)
   */
  async getRecentlyProcessed(limit: number = 10, withinMinutes: number = 30): Promise<(PersistentPendingMessage & { project: string | null })[]> {
    const cutoff = Date.now() - (withinMinutes * 60 * 1000);
    return queryAll<PersistentPendingMessage & { project: string | null }>(this.db, `
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status = 'processed' AND pm.completed_at_epoch > ?
      ORDER BY pm.completed_at_epoch DESC
      LIMIT ?
    `, [cutoff, limit]);
  }

  /**
   * Mark message as failed (with retry logic)
   */
  async markFailed(messageId: number): Promise<void> {
    const now = Date.now();
    const msg = await queryOne<{ retry_count: number }>(this.db,
      'SELECT retry_count FROM pending_messages WHERE id = ?', [messageId]);

    if (!msg) return;

    if (msg.retry_count < this.maxRetries) {
      await exec(this.db, `
        UPDATE pending_messages
        SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL
        WHERE id = ?
      `, [messageId]);
    } else {
      await exec(this.db, `
        UPDATE pending_messages
        SET status = 'failed', completed_at_epoch = ?
        WHERE id = ?
      `, [now, messageId]);
    }
  }

  /**
   * Reset stuck messages (processing -> pending if stuck longer than threshold)
   */
  async resetStuckMessages(thresholdMs: number): Promise<number> {
    const cutoff = thresholdMs === 0 ? Date.now() : Date.now() - thresholdMs;
    const result = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `, [cutoff]);
    return result.rowsAffected;
  }

  /**
   * Get count of pending messages for a session
   */
  async getPendingCount(sessionDbId: number): Promise<number> {
    const result = await queryOne<{ count: number }>(this.db, `
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `, [sessionDbId]);
    return result!.count;
  }

  /**
   * Check if any session has pending work.
   */
  async hasAnyPendingWork(): Promise<boolean> {
    const stuckCutoff = Date.now() - (5 * 60 * 1000);
    const resetResult = await exec(this.db, `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `, [stuckCutoff]);
    if (resetResult.rowsAffected > 0) {
      logger.info('QUEUE', `STUCK_RESET | hasAnyPendingWork reset ${resetResult.rowsAffected} stuck processing message(s) older than 5 minutes`);
    }

    const result = await queryOne<{ count: number }>(this.db, `
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    return result!.count > 0;
  }

  /**
   * Get all session IDs that have pending messages (for recovery on startup)
   */
  async getSessionsWithPendingMessages(): Promise<number[]> {
    const results = await queryAll<{ session_db_id: number }>(this.db, `
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    return results.map(r => r.session_db_id);
  }

  /**
   * Get session info for a pending message (for recovery)
   */
  async getSessionInfoForMessage(messageId: number): Promise<{ sessionDbId: number; contentSessionId: string } | null> {
    const result = await queryOne<{ session_db_id: number; content_session_id: string }>(this.db, `
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `, [messageId]);
    return result ? { sessionDbId: result.session_db_id, contentSessionId: result.content_session_id } : null;
  }

  /**
   * Clear all failed messages from the queue
   */
  async clearFailed(): Promise<number> {
    const result = await exec(this.db, `
      DELETE FROM pending_messages
      WHERE status = 'failed'
    `);
    return result.rowsAffected;
  }

  /**
   * Clear all pending, processing, and failed messages from the queue
   */
  async clearAll(): Promise<number> {
    const result = await exec(this.db, `
      DELETE FROM pending_messages
      WHERE status IN ('pending', 'processing', 'failed')
    `);
    return result.rowsAffected;
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
