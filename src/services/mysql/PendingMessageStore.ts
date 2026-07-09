/**
 * MySQL PendingMessageStore
 *
 * Async persistent work queue for SDK messages using MySQL.
 */

import { MySQLDatabase, ResultSetHeader } from './Database.js';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/** Messages processing longer than this are considered stale */
const STALE_PROCESSING_THRESHOLD_MS = 300_000;

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
  // Claude Code subagent identity — NULL for main-session messages.
  agent_type: string | null;
  agent_id: string | null;
}

/**
 * PendingMessageStore - Persistent work queue for SDK messages (MySQL)
 */
export class PendingMessageStore {
  private db: MySQLDatabase;
  private maxRetries: number;

  constructor(db: MySQLDatabase, maxRetries: number = 3) {
    this.db = db;
    this.maxRetries = maxRetries;
  }

  /**
   * Enqueue a new message
   */
  async enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number> {
    const now = Date.now();
    const result = await this.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch,
        agent_type, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      sessionDbId,
      contentSessionId,
      message.type,
      message.tool_name || null,
      message.tool_input ? JSON.stringify(message.tool_input) : null,
      message.tool_response ? JSON.stringify(message.tool_response) : null,
      message.cwd || null,
      message.last_assistant_message || null,
      message.prompt_number || null,
      now,
      message.agentType ?? null,
      message.agentId ?? null
    );

    return result.insertId;
  }

  /**
   * Atomically claim the next pending message
   */
  async claimNextMessage(sessionDbId: number): Promise<PersistentPendingMessage | null> {
    const tx = this.db.transaction(async (txConn) => {
      const now = Date.now();
      const staleCutoff = now - STALE_PROCESSING_THRESHOLD_MS;

      // Self-healing: reset stale 'processing' messages
      const resetStmt = txConn.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE session_db_id = ? AND status = 'processing'
          AND started_processing_at_epoch < ?
      `);
      const resetResult = await resetStmt.run(sessionDbId, staleCutoff);
      if (resetResult.affectedRows > 0) {
        logger.info('QUEUE', `SELF_HEAL | sessionDbId=${sessionDbId} | recovered ${resetResult.affectedRows} stale processing message(s)`);
      }

      const peekStmt = txConn.prepare(`
        SELECT * FROM pending_messages
        WHERE session_db_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `);
      const msg = await peekStmt.get(sessionDbId) as PersistentPendingMessage | null;

      if (msg) {
        const updateStmt = txConn.prepare(`
          UPDATE pending_messages
          SET status = 'processing', started_processing_at_epoch = ?
          WHERE id = ?
        `);
        await updateStmt.run(now, msg.id);

        logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${msg.id} | type=${msg.message_type}`, {
          sessionId: sessionDbId
        });
      }
      return msg;
    });

    return await tx();
  }

  /**
   * Confirm message was processed - DELETE from queue
   */
  async confirmProcessed(messageId: number): Promise<void> {
    const result = await this.db.prepare('DELETE FROM pending_messages WHERE id = ?').run(messageId);
    if (result.affectedRows > 0) {
      logger.debug('QUEUE', `CONFIRMED | messageId=${messageId} | deleted from queue`);
    }
  }

  /**
   * Reset stale processing messages
   */
  async resetStaleProcessingMessages(thresholdMs: number = 5 * 60 * 1000, sessionDbId?: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    let result: ResultSetHeader;

    if (sessionDbId !== undefined) {
      result = await this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing' AND started_processing_at_epoch < ? AND session_db_id = ?
      `).run(cutoff, sessionDbId);
    } else {
      result = await this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', started_processing_at_epoch = NULL
        WHERE status = 'processing' AND started_processing_at_epoch < ?
      `).run(cutoff);
    }

    if (result.affectedRows > 0) {
      logger.info('QUEUE', `RESET_STALE | count=${result.affectedRows} | thresholdMs=${thresholdMs}${sessionDbId !== undefined ? ` | sessionDbId=${sessionDbId}` : ''}`);
    }
    return result.affectedRows;
  }

  /**
   * Get all pending messages for session
   */
  async getAllPending(sessionDbId: number): Promise<PersistentPendingMessage[]> {
    return await this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
    `).all(sessionDbId) as PersistentPendingMessage[];
  }

  /**
   * Get all queue messages (for UI)
   */
  async getQueueMessages(): Promise<(PersistentPendingMessage & { project: string | null })[]> {
    return await this.db.prepare(`
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
    `).all() as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Get count of stuck messages
   */
  async getStuckCount(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).get(cutoff) as { count: number };
    return result.count;
  }

  /**
   * Retry a specific message
   */
  async retryMessage(messageId: number): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE id = ? AND status IN ('pending', 'processing', 'failed')
    `).run(messageId);
    return result.affectedRows > 0;
  }

  /**
   * Reset all processing messages for a session
   */
  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status = 'processing'
    `).run(sessionDbId);
    return result.affectedRows;
  }

  /**
   * Mark all processing messages for a session as failed
   */
  async markSessionMessagesFailed(sessionDbId: number): Promise<number> {
    const now = Date.now();
    const result = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status = 'processing'
    `).run(now, sessionDbId);
    return result.affectedRows;
  }

  /**
   * Mark all pending and processing messages for a session as abandoned
   */
  async markAllSessionMessagesAbandoned(sessionDbId: number): Promise<number> {
    const now = Date.now();
    const result = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).run(now, sessionDbId);
    return result.affectedRows;
  }

  /**
   * Abort a specific message
   */
  async abortMessage(messageId: number): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM pending_messages WHERE id = ?').run(messageId);
    return result.affectedRows > 0;
  }

  /**
   * Retry all stuck messages
   */
  async retryAllStuck(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(cutoff);
    return result.affectedRows;
  }

  /**
   * Get recently processed messages
   */
  async getRecentlyProcessed(limit: number = 10, withinMinutes: number = 30): Promise<(PersistentPendingMessage & { project: string | null })[]> {
    const cutoff = Date.now() - (withinMinutes * 60 * 1000);
    return await this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status = 'processed' AND pm.completed_at_epoch > ?
      ORDER BY pm.completed_at_epoch DESC
      LIMIT ?
    `).all(cutoff, limit) as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Mark message as failed (with retry logic)
   */
  async markFailed(messageId: number): Promise<void> {
    const now = Date.now();

    const msg = await this.db.prepare('SELECT retry_count FROM pending_messages WHERE id = ?').get(messageId) as { retry_count: number } | undefined;

    if (!msg) return;

    if (msg.retry_count < this.maxRetries) {
      await this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL
        WHERE id = ?
      `).run(messageId);
    } else {
      await this.db.prepare(`
        UPDATE pending_messages
        SET status = 'failed', completed_at_epoch = ?
        WHERE id = ?
      `).run(now, messageId);
    }
  }

  /**
   * Reset stuck messages
   */
  async resetStuckMessages(thresholdMs: number): Promise<number> {
    const cutoff = thresholdMs === 0 ? Date.now() : Date.now() - thresholdMs;

    const result = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(cutoff);

    return result.affectedRows;
  }

  /**
   * Get count of pending messages for a session
   */
  async getPendingCount(sessionDbId: number): Promise<number> {
    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).get(sessionDbId) as { count: number };
    return result.count;
  }

  /**
   * Peek at pending message types for a session
   */
  async peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>> {
    return await this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `).all(sessionDbId) as Array<{ message_type: string; tool_name: string | null }>;
  }

  /**
   * Check if any session has pending work
   */
  async hasAnyPendingWork(): Promise<boolean> {
    const stuckCutoff = Date.now() - (5 * 60 * 1000);
    const resetResult = await this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(stuckCutoff);
    if (resetResult.affectedRows > 0) {
      logger.info('QUEUE', `STUCK_RESET | hasAnyPendingWork reset ${resetResult.affectedRows} stuck processing message(s) older than 5 minutes`);
    }

    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `).get() as { count: number };
    return result.count > 0;
  }

  /**
   * Get all session IDs with pending messages
   */
  async getSessionsWithPendingMessages(): Promise<number[]> {
    const results = await this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `).all() as { session_db_id: number }[];
    return results.map(r => r.session_db_id);
  }

  /**
   * Get session info for a pending message
   */
  async getSessionInfoForMessage(messageId: number): Promise<{ sessionDbId: number; contentSessionId: string } | null> {
    const result = await this.db.prepare(`
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `).get(messageId) as { session_db_id: number; content_session_id: string } | undefined;
    return result ? { sessionDbId: result.session_db_id, contentSessionId: result.content_session_id } : null;
  }

  /**
   * Clear all failed messages
   */
  async clearFailed(): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status = 'failed'
    `).run();
    return result.affectedRows;
  }

  /**
   * Delete `status='failed'` rows older than `thresholdMs`. Called once at
   * worker startup so `pending_messages` does not grow unbounded on long-
   * running or high-failure-rate installations.
   */
  async clearFailedOlderThan(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status = 'failed' AND COALESCE(failed_at_epoch, completed_at_epoch, 0) < ?
    `).run(cutoff);
    return result.affectedRows;
  }

  /**
   * Clear all pending, processing, and failed messages
   */
  async clearAll(): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status IN ('pending', 'processing', 'failed')
    `).run();
    return result.affectedRows;
  }

  /**
   * Convert PersistentPendingMessage back to PendingMessage format
   */
  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name || undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number || undefined,
      cwd: persistent.cwd || undefined,
      last_assistant_message: persistent.last_assistant_message || undefined,
      agentId: persistent.agent_id ?? undefined,
      agentType: persistent.agent_type ?? undefined
    };
  }
}