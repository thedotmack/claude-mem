// SPDX-License-Identifier: Apache-2.0
//
// Every chat, copied whole into claude-mem (its chat transcript mirror, POST /api/chat-transcripts),
// so the full transcripts live in claude-mem's own folder no matter what happens to OpenDuet.
//
// A thread is sent after each run finishes, and only up to its last finished run, so a reply still
// streaming is never kept half-written. claude-mem skips a message it already has, so sending a
// thread again is always safe. What was sent is remembered per thread (`mirrored_seq`,
// `mirrored_at`); a catch-up pass at start and every minute sends whatever is behind, which covers
// chats from before the mirror existed and anything missed while claude-mem was not running.

import type { ChatStore } from './store.js';
import { messagesFromEvents } from './messages.js';

export const MIRROR_SOURCE = 'openduet';
/** Messages per request; claude-mem takes at most 500. */
const MESSAGES_PER_REQUEST = 200;
/** A request body stays under this unless one message alone is larger (claude-mem takes up to 64 MB). */
const REQUEST_BYTE_BUDGET = 3 * 1024 * 1024;
const CATCH_UP_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

type BehindRow = { id: string; name: string | null; updated_at: string; target_seq: number };

/** claude-mem answered, but would not keep this thread (for example its file was changed by hand). */
class RefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type MirrorOptions = {
  store: ChatStore;
  /** claude-mem's worker, e.g. http://127.0.0.1:37877. */
  workerUrl: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** 0 turns the periodic catch-up off (tests). */
  catchUpIntervalMs?: number;
};

export type ClaudeMemMirror = {
  /** Send this thread soon (after a run finished or it was renamed). */
  schedule: (threadId: string) => void;
  /** Send every thread that is behind. Resolves when done; never throws. */
  catchUp: () => Promise<{ threads: number; appended: number; failed: number }>;
  stop: () => void;
};

export function prepareMirrorColumns(store: ChatStore): void {
  const columns = new Set(
    store.db.query<{ name: string }, []>('PRAGMA table_info(threads)').all().map((column) => column.name),
  );
  if (!columns.has('mirrored_seq')) store.db.exec('ALTER TABLE threads ADD COLUMN mirrored_seq INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('mirrored_at')) store.db.exec('ALTER TABLE threads ADD COLUMN mirrored_at TEXT');
}

/** Threads with a finished run not sent yet, or renamed since they were sent. */
function threadsBehind(store: ChatStore, threadId?: string): BehindRow[] {
  return store.db
    .query<BehindRow, string[]>(
      `SELECT t.id, t.name, t.updated_at,
              COALESCE((SELECT MAX(e.seq) FROM events e
                        WHERE e.thread_id = t.id AND e.type IN ('RUN_FINISHED', 'RUN_ERROR')), 0) AS target_seq
       FROM threads t
       WHERE ${threadId ? 't.id = ? AND' : ''}
             (COALESCE((SELECT MAX(e.seq) FROM events e
                        WHERE e.thread_id = t.id AND e.type IN ('RUN_FINISHED', 'RUN_ERROR')), 0) > t.mirrored_seq
              OR (t.mirrored_at IS NOT NULL AND t.updated_at <> t.mirrored_at))
       ORDER BY t.updated_at`,
    )
    .all(...(threadId ? [threadId] : []));
}

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (current.length > 0 && (current.length >= MESSAGES_PER_REQUEST || bytes + size > REQUEST_BYTE_BUDGET)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

export function createClaudeMemMirror(options: MirrorOptions): ClaudeMemMirror {
  const { store } = options;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = `${options.workerUrl.replace(/\/+$/, '')}/api/chat-transcripts`;
  prepareMirrorColumns(store);

  let chain: Promise<unknown> = Promise.resolve();
  const pending = new Set<string>();
  let lastFailureLogged = 0;

  const sendThread = async (row: BehindRow): Promise<number> => {
    const events = store.threadEvents(row.id).filter((event) => event.seq <= row.target_seq);
    const messages = messagesFromEvents(events.map((event) => event.payload)).map((message) => ({
      id: message.id,
      role: message.role,
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    }));
    let appended = 0;
    for (const batch of batches(messages)) {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: MIRROR_SOURCE, conversationId: row.id, title: row.name, messages: batch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new RefusedError(response.status, `claude-mem answered ${response.status} ${text.slice(0, 200)}`);
      }
      appended += Number(((await response.json()) as { appended?: number }).appended ?? 0);
    }
    // The thread's own updated_at, read with the name that was sent: a rename while this was in
    // flight leaves updated_at newer than mirrored_at, so the next pass sends the new name.
    store.db
      .query('UPDATE threads SET mirrored_seq = ?, mirrored_at = ? WHERE id = ?')
      .run(row.target_seq, row.updated_at, row.id);
    return appended;
  };

  const run = (threadId?: string) => {
    const next = chain.then(async () => {
      let appended = 0;
      let failed = 0;
      const rows = threadsBehind(store, threadId);
      for (const row of rows) {
        try {
          appended += await sendThread(row);
        } catch (error) {
          failed++;
          // One line a minute at most: claude-mem being down is normal while it starts.
          if (Date.now() - lastFailureLogged > 60_000) {
            lastFailureLogged = Date.now();
            log(`chat mirror: could not send thread ${row.id} to claude-mem (${(error as Error).message}); will retry`);
          }
          // A refusal is about this thread only, so the others still go. Anything else (claude-mem not
          // running, a timeout) would fail for every thread alike, so the pass stops until next time.
          if (!(error instanceof RefusedError && error.status < 500)) break;
        }
      }
      if (appended > 0) log(`chat mirror: ${appended} message(s) kept in claude-mem`);
      return { threads: rows.length, appended, failed };
    });
    chain = next.catch(() => undefined);
    return next.catch(() => ({ threads: 0, appended: 0, failed: 1 }));
  };

  const schedule = (threadId: string) => {
    if (pending.has(threadId)) return;
    pending.add(threadId);
    queueMicrotask(() => {
      pending.delete(threadId);
      void run(threadId);
    });
  };

  const interval = options.catchUpIntervalMs ?? CATCH_UP_INTERVAL_MS;
  const timer = interval > 0 ? setInterval(() => void run(), interval) : null;
  if (interval > 0) void run();

  return {
    schedule,
    catchUp: () => run(),
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
