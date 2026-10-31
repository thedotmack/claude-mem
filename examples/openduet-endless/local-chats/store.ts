// SPDX-License-Identifier: Apache-2.0
//
// Where the chats live: one SQLite file. A thread is a row; everything said in it is the list of
// AG-UI events the runner sent, in the order they arrived. Messages and state are rebuilt from those
// events on read (messages.ts), so nothing is stored twice.

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type ThreadRow = {
  id: string;
  user_id: string;
  agent_id: string;
  name: string | null;
  learning_container_id: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
};

export type ThreadSummary = {
  id: string;
  name: string | null;
  agentId: string;
  createdById: string;
  organizationId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt: string;
  lastRunAt?: string;
};

export type StoredEvent = { seq: number; eventId: string; runId: string; payload: Record<string, unknown> };

export function summarize(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    createdById: row.user_id,
    organizationId: 'local',
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUpdatedAt: row.updated_at,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
  };
}

export class ChatStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fresh = !existsSync(path);
      this.db = new Database(path, { create: true });
      if (fresh) chmodSync(path, 0o600);
    } else {
      this.db = new Database(':memory:');
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT,
        learning_container_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS threads_by_owner ON threads (user_id, agent_id, updated_at);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread_id, seq);
      CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  getThread(id: string): ThreadRow | null {
    return this.db.query<ThreadRow, [string]>('SELECT * FROM threads WHERE id = ?').get(id) ?? null;
  }

  createThread(input: { id: string; userId: string; agentId: string; name?: string; learningContainerId?: string }): ThreadRow {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO threads (id, user_id, agent_id, name, learning_container_id, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(input.id, input.userId, input.agentId, input.name ?? null, input.learningContainerId ?? null, now, now);
    return this.getThread(input.id)!;
  }

  updateThread(id: string, changes: { name?: string | null; archived?: boolean }): ThreadRow | null {
    const row = this.getThread(id);
    if (!row) return null;
    const name = changes.name !== undefined ? changes.name : row.name;
    const archived = changes.archived !== undefined ? (changes.archived ? 1 : 0) : row.archived;
    this.db.query('UPDATE threads SET name = ?, archived = ?, updated_at = ? WHERE id = ?').run(name, archived, new Date().toISOString(), id);
    return this.getThread(id);
  }

  touchRun(id: string): void {
    const now = new Date().toISOString();
    this.db.query('UPDATE threads SET last_run_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }

  deleteThread(id: string): boolean {
    return this.db.query('DELETE FROM threads WHERE id = ?').run(id).changes > 0;
  }

  /** Newest first, keyset-paged on (updated_at, id). The cursor is the last row's pair. */
  listThreads(input: { userId: string; agentId: string; includeArchived: boolean; limit: number; cursor?: string }): {
    rows: ThreadRow[];
    nextCursor: string | null;
  } {
    const limit = Math.max(1, Math.min(input.limit, 200));
    let after: { updatedAt: string; id: string } | null = null;
    if (input.cursor) {
      try {
        after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      } catch {
        after = null;
      }
    }
    const rows = this.db
      .query<ThreadRow, (string | number)[]>(
        `SELECT * FROM threads
         WHERE user_id = ? AND agent_id = ? ${input.includeArchived ? '' : 'AND archived = 0'}
         ${after ? 'AND (updated_at < ? OR (updated_at = ? AND id < ?))' : ''}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...[input.userId, input.agentId, ...(after ? [after.updatedAt, after.updatedAt, after.id] : []), limit + 1]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor:
        rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at, id: last.id })).toString('base64url') : null,
    };
  }

  /** Stores one event. An event id seen before is a resend after a lost acknowledgement: kept once. */
  appendEvent(threadId: string, runId: string, eventId: string, payload: Record<string, unknown>): { seq: number; inserted: boolean } {
    const existing = this.db.query<{ seq: number }, [string]>('SELECT seq FROM events WHERE event_id = ?').get(eventId);
    if (existing) return { seq: existing.seq, inserted: false };
    const result = this.db
      .query('INSERT INTO events (thread_id, run_id, event_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadId, runId, eventId, String(payload.type ?? ''), JSON.stringify(payload), new Date().toISOString());
    return { seq: Number(result.lastInsertRowid), inserted: true };
  }

  private rowsToEvents(rows: { seq: number; event_id: string; run_id: string; payload: string }[]): StoredEvent[] {
    return rows.map((row) => ({ seq: row.seq, eventId: row.event_id, runId: row.run_id, payload: JSON.parse(row.payload) }));
  }

  /** Every event in the thread after `afterSeq` (0 for all), oldest first. */
  threadEvents(threadId: string, afterSeq = 0): StoredEvent[] {
    return this.rowsToEvents(
      this.db
        .query<{ seq: number; event_id: string; run_id: string; payload: string }, [string, number]>(
          'SELECT seq, event_id, run_id, payload FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq',
        )
        .all(threadId, afterSeq),
    );
  }

  runEvents(threadId: string, runId: string): StoredEvent[] {
    return this.rowsToEvents(
      this.db
        .query<{ seq: number; event_id: string; run_id: string; payload: string }, [string, string]>(
          'SELECT seq, event_id, run_id, payload FROM events WHERE thread_id = ? AND run_id = ? ORDER BY seq',
        )
        .all(threadId, runId),
    );
  }

  /** The stored position of an event in its thread, or null when the thread never had it. */
  seqOf(threadId: string, eventId: string): number | null {
    return (
      this.db.query<{ seq: number }, [string, string]>('SELECT seq FROM events WHERE thread_id = ? AND event_id = ?').get(threadId, eventId)
        ?.seq ?? null
    );
  }

  latestEventId(threadId: string): string | null {
    return (
      this.db
        .query<{ event_id: string }, [string]>('SELECT event_id FROM events WHERE thread_id = ? ORDER BY seq DESC LIMIT 1')
        .get(threadId)?.event_id ?? null
    );
  }
}
