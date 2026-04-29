import { Database } from 'bun:sqlite';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export type LiveWorkerPidsProvider = () => readonly number[];

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
  agent_type: string | null;
  agent_id: string | null;
}

export class PendingMessageStore {
  private db: Database;
  private maxRetries: number;
  private workerPid: number;
  private getLiveWorkerPids: LiveWorkerPidsProvider;

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

  claimNextMessage(sessionDbId: number): PersistentPendingMessage | null {
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

  confirmProcessed(messageId: number): void {
    const stmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
    const result = stmt.run(messageId);
    if (result.changes > 0) {
      logger.debug('QUEUE', `CONFIRMED | messageId=${messageId} | deleted from queue`);
    }
  }

  clearFailedOlderThan(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status = 'failed' AND COALESCE(failed_at_epoch, completed_at_epoch, 0) < ?
    `);
    return stmt.run(cutoff).changes;
  }

  getAllPending(sessionDbId: number): PersistentPendingMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as PersistentPendingMessage[];
  }

  transitionMessagesTo(
    status: 'failed' | 'abandoned',
    filter: { sessionDbId: number }
  ): number {
    const now = Date.now();
    const statusClause = status === 'failed'
      ? `status = 'processing'`
      : `status IN ('pending', 'processing')`;

    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND ${statusClause}
    `);
    return stmt.run(now, filter.sessionDbId).changes;
  }

  markFailed(messageId: number): void {
    const now = Date.now();

    const msg = this.db.prepare('SELECT retry_count FROM pending_messages WHERE id = ?').get(messageId) as { retry_count: number } | undefined;

    if (!msg) return;

    if (msg.retry_count < this.maxRetries) {
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', retry_count = retry_count + 1, worker_pid = NULL
        WHERE id = ?
      `);
      stmt.run(messageId);
    } else {
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'failed', completed_at_epoch = ?
        WHERE id = ?
      `);
      stmt.run(now, messageId);
    }
  }

  getPendingCount(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.get(sessionDbId) as { count: number };
    return result.count;
  }

  peekPendingTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    const stmt = this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as Array<{ message_type: string; tool_name: string | null }>;
  }

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

  getSessionsWithPendingMessages(): number[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const results = stmt.all() as { session_db_id: number }[];
    return results.map(r => r.session_db_id);
  }

  getSessionInfoForMessage(messageId: number): { sessionDbId: number; contentSessionId: string } | null {
    const stmt = this.db.prepare(`
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `);
    const result = stmt.get(messageId) as { session_db_id: number; content_session_id: string } | undefined;
    return result ? { sessionDbId: result.session_db_id, contentSessionId: result.content_session_id } : null;
  }

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
