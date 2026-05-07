import { Database } from 'bun:sqlite';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

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
  status: 'pending' | 'processing';
  created_at_epoch: number;
  agent_type: string | null;
  agent_id: string | null;
}

export class PendingMessageStore {
  private db: Database;

  constructor(
    db: Database,
    private onMutate?: () => void
  ) {
    this.db = db;
  }

  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO pending_messages (
        session_db_id, content_session_id, tool_use_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, created_at_epoch,
        agent_type, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
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

    if (result.changes > 0) {
      this.onMutate?.();
      return result.lastInsertRowid as number;
    }
    return 0;
  }

  claimNextMessage(sessionDbId: number): PersistentPendingMessage | null {
    const sql = `
      UPDATE pending_messages
         SET status = 'processing'
       WHERE id = (
         SELECT id FROM pending_messages
          WHERE session_db_id = ? AND status = 'pending'
          ORDER BY id ASC
          LIMIT 1
       )
       RETURNING *
    `;
    const claimed = this.db.prepare(sql).get(sessionDbId) as PersistentPendingMessage | null;
    if (claimed) {
      logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${claimed.id} | type=${claimed.message_type}`, {
        sessionId: sessionDbId
      });
    }
    if (claimed) {
      this.onMutate?.();
    }
    return claimed;
  }

  clearPendingForSession(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages WHERE session_db_id = ?
    `);
    const changes = stmt.run(sessionDbId).changes;
    if (changes > 0) {
      logger.info('QUEUE', `CLEARED | sessionDbId=${sessionDbId} | rowsDeleted=${changes}`, {
        sessionId: sessionDbId
      });
      this.onMutate?.();
    }
    return changes;
  }

  resetProcessingToPending(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
         SET status = 'pending'
       WHERE session_db_id = ? AND status = 'processing'
    `);
    const changes = stmt.run(sessionDbId).changes;
    if (changes > 0) {
      logger.info('QUEUE', `RESET_PROCESSING | sessionDbId=${sessionDbId} | rowsReset=${changes}`, {
        sessionId: sessionDbId
      });
      this.onMutate?.();
    }
    return changes;
  }

  getPendingCount(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.get(sessionDbId) as { count: number };
    return result.count;
  }

  getTotalQueueDepth(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  hasAnyPendingWork(): boolean {
    return this.getTotalQueueDepth() > 0;
  }

  getSessionsWithPendingMessages(): number[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
      ORDER BY session_db_id ASC
    `);
    return (stmt.all() as Array<{ session_db_id: number }>).map(row => row.session_db_id);
  }

  confirmProcessed(messageId: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE id = ? AND status = 'processing'
    `);
    const changes = stmt.run(messageId).changes;
    if (changes > 0) {
      this.onMutate?.();
    }
    return changes;
  }

  peekPendingTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    const stmt = this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as Array<{ message_type: string; tool_name: string | null }>;
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
