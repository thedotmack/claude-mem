import { Database } from 'bun:sqlite';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/**
 * Provider for the set of currently-live worker PIDs.
 *
 * The self-healing claim query reclaims any 'processing' row whose
 * worker_pid is NOT a live worker (crash recovery without a timer).
 *
 * Default: a single-worker process supplies just its own PID. Multi-worker
 * deployments inject a callback backed by `supervisor/process-registry.ts`
 * (`getSupervisor().getRegistry().getAll().filter(r => r.type === 'worker').map(r => r.pid)`).
 */
export type LiveWorkerPidsProvider = () => readonly number[];

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
  completed_at_epoch: number | null;
  worker_pid: number | null;
  // Claude Code subagent identity — NULL for main-session messages.
  agent_type: string | null;
  agent_id: string | null;
}

/**
 * PendingMessageStore - Persistent work queue for SDK messages
 *
 * Messages are persisted before processing using a claim-confirm pattern.
 * This simplifies the lifecycle and eliminates duplicate processing bugs.
 *
 * Lifecycle:
 * 1. enqueue() - Message persisted with status 'pending'
 * 2. claimNextMessage() - Atomically claims next pending message (marks as 'processing'
 *    and stamps the live worker's PID). Self-healing: reclaims any 'processing' row
 *    whose worker_pid is no longer alive (worker crash) in the same UPDATE.
 * 3. confirmProcessed() - Deletes message after successful processing
 *
 * Self-healing semantics:
 *   A 'processing' row is reclaimable iff worker_pid IS NULL or worker_pid is
 *   not present in the live-pids list at claim time. No timer, no
 *   stale-cutoff timestamp — liveness is the truth.
 */
export class PendingMessageStore {
  private db: Database;
  private maxRetries: number;
  private workerPid: number;
  private getLiveWorkerPids: LiveWorkerPidsProvider;

  /**
   * @param db                  SQLite database
   * @param maxRetries          Per-message retry ceiling for transient SDK failures (default 3)
   * @param workerPid           PID of the worker that owns this store; stamped into worker_pid on claim.
   *                            Defaults to process.pid so single-process deployments need no extra wiring.
   * @param getLiveWorkerPids   Provider for the set of all currently-live worker PIDs.
   *                            Defaults to `[workerPid]` — only this worker is alive.
   *                            Multi-worker deployments inject a supervisor-backed provider.
   */
  constructor(
    db: Database,
    maxRetries: number = 3,
    workerPid: number = process.pid,
    getLiveWorkerPids?: LiveWorkerPidsProvider
  ) {
    this.db = db;
    this.maxRetries = maxRetries;
    this.workerPid = workerPid;
    this.getLiveWorkerPids = getLiveWorkerPids ?? (() => [this.workerPid]);
  }

  /**
   * Enqueue a new message (persist before processing).
   *
   * Uses `INSERT OR IGNORE` so duplicate (content_session_id, tool_use_id)
   * pairs collapse to a single row — the UNIQUE INDEX added in plan 01 phase 1
   * is the authority on tool-use idempotency. Per principle 3 (UNIQUE
   * constraint over dedup window), we don't time-gate duplicates.
   *
   * @returns The database ID of the persisted message, or 0 when the insert
   *          was suppressed by ON CONFLICT (caller must handle 0 explicitly).
   */
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO pending_messages (
        session_db_id, content_session_id, tool_use_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch,
        agent_type, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `);

    const result = stmt.run(
      sessionDbId,
      contentSessionId,
      message.toolUseId ?? null,
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

    return result.lastInsertRowid as number;
  }

  /**
   * PATHFINDER plan 03 phase 6: pair tool_use rows with their tool_result by
   * (content_session_id, tool_use_id) at read time. Replaces the per-process
   * `pendingTools` Map deleted from `src/services/transcripts/processor.ts`.
   *
   * Returns observation rows whose tool_use_id is non-null and which have at
   * least one prior matching row in the same session (the UNIQUE INDEX
   * guarantees at most one logical pair survives per id).
   */
  pairToolUsesByJoin(contentSessionId: string): Array<{
    tool_use_id: string;
    tool_use_payload: string | null;
    tool_result_payload: string | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT u.tool_use_id   AS tool_use_id,
             u.tool_input    AS tool_use_payload,
             r.tool_response AS tool_result_payload
        FROM pending_messages u
        JOIN pending_messages r USING (content_session_id, tool_use_id)
       WHERE u.content_session_id = ?
         AND u.tool_use_id IS NOT NULL
         AND u.tool_input IS NOT NULL
         AND r.tool_response IS NOT NULL
    `);
    return stmt.all(contentSessionId) as Array<{
      tool_use_id: string;
      tool_use_payload: string | null;
      tool_result_payload: string | null;
    }>;
  }

  /**
   * Atomically claim the next message for `sessionDbId`.
   *
   * A row is claimable iff:
   *   - status = 'pending', OR
   *   - status = 'processing' AND worker_pid is not in the live-pids set
   *     (i.e. the previous owner crashed). This is the self-healing branch:
   *     liveness is checked at claim time, not by a background reaper.
   *
   * The claim stamps the live worker's PID and flips status to 'processing'
   * in a single UPDATE … WHERE id = (subquery).
   */
  claimNextMessage(sessionDbId: number): PersistentPendingMessage | null {
    // Build a parameterized IN-list of live worker PIDs. We always include
    // this worker's PID so that an in-flight claim doesn't accidentally
    // self-reclaim a row we just stamped (the predicate is "NOT IN live").
    const livePids = this.getLivePidsIncludingSelf();
    const placeholders = livePids.map(() => '?').join(',');

    const sql = `
      UPDATE pending_messages
         SET status     = 'processing',
             worker_pid = ?
       WHERE id = (
         SELECT id FROM pending_messages
          WHERE session_db_id = ?
            AND (
              status = 'pending'
              OR (status = 'processing' AND (worker_pid IS NULL OR worker_pid NOT IN (${placeholders})))
            )
          ORDER BY id ASC
          LIMIT 1
       )
       RETURNING *
    `;

    const stmt = this.db.prepare(sql);
    const params: (number | string)[] = [this.workerPid, sessionDbId, ...livePids];
    const claimed = stmt.get(...params) as PersistentPendingMessage | null;

    if (claimed) {
      logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${claimed.id} | type=${claimed.message_type} | workerPid=${this.workerPid}`, {
        sessionId: sessionDbId
      });
    }
    return claimed;
  }

  private getLivePidsIncludingSelf(): number[] {
    const pids = this.getLiveWorkerPids();
    if (pids.includes(this.workerPid)) return [...pids];
    return [...pids, this.workerPid];
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
   * Get count of 'processing' rows whose worker_pid is no longer alive.
   * These are the rows the self-healing claim would reclaim on next call.
   * Returned for diagnostics / UI display only — there is no background
   * timer that acts on this count.
   */
  getStuckCount(): number {
    const livePids = this.getLivePidsIncludingSelf();
    const placeholders = livePids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS count FROM pending_messages
       WHERE status = 'processing'
         AND (worker_pid IS NULL OR worker_pid NOT IN (${placeholders}))
    `);
    const result = stmt.get(...livePids) as { count: number };
    return result.count;
  }

  /**
   * Retry a specific message (reset to pending)
   * Works for pending (re-queue), processing (reset stuck), and failed messages
   */
  retryMessage(messageId: number): boolean {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', worker_pid = NULL
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
      SET status = 'pending', worker_pid = NULL
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
        SET status = 'pending', retry_count = retry_count + 1, worker_pid = NULL
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
   * Peek at pending message types for a session (for tier routing).
   * Returns list of { message_type, tool_name } without claiming.
   */
  peekPendingTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    const stmt = this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as Array<{ message_type: string; tool_name: string | null }>;
  }

  /**
   * Check if any session has work that could be claimed right now.
   *
   * Counts a row as work iff it is 'pending' or it is 'processing' under a
   * worker_pid that is not currently alive (the same predicate the
   * self-healing claim uses). No side effects — no UPDATE, no timer.
   */
  hasAnyPendingWork(): boolean {
    const livePids = this.getLivePidsIncludingSelf();
    const placeholders = livePids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
       WHERE status = 'pending'
          OR (status = 'processing' AND (worker_pid IS NULL OR worker_pid NOT IN (${placeholders})))
    `);
    const result = stmt.get(...livePids) as { count: number };
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
      last_assistant_message: persistent.last_assistant_message || undefined,
      agentId: persistent.agent_id ?? undefined,
      agentType: persistent.agent_type ?? undefined
    };
  }
}
