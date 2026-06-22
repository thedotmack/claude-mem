import { EventEmitter } from 'node:events';
import type { Database } from 'bun:sqlite';

/**
 * Cloud-sync outbox queue.
 *
 * SAFETY CONTRACT (Wave 1): every function here is PURE local SQLite. There is NO
 * network import in this module and NO async work. enqueueOutbox() is a single
 * synchronous INSERT designed to be called INSIDE an existing db.transaction(...)
 * so the outbox row commits atomically with the base row (all-or-nothing). If the
 * INSERT throws, it does so as a SQLite error which correctly rolls back the whole
 * surrounding transaction — that is the desired behavior.
 *
 * The pusher (which reads base tables by local_id and sends over the wire) is
 * Wave 2 and lives elsewhere. Nothing in this file does I/O beyond SQLite.
 */

export type OutboxKind = 'observation' | 'summary' | 'prompt' | 'delete' | 'update';
export type OutboxLane = 'live' | 'backfill';
export type OutboxStatus = 'pending' | 'inflight' | 'quarantined';

export interface OutboxEntry {
  kind: OutboxKind;
  localId?: number | null;
  targetTable?: string | null;
  lane?: OutboxLane;
  createdAtEpoch: number;
}

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  local_id: number | null;
  target_table: string | null;
  status: OutboxStatus;
  attempts: number;
  lane: OutboxLane;
  created_at_epoch: number;
}

/**
 * Module-level emitter the pusher (Wave 2) subscribes to so it can wake on enqueue
 * instead of polling. Exported so write sites can fire notifyEnqueued() AFTER their
 * transaction commits.
 */
export const outboxEvents = new EventEmitter();

/**
 * Wake the pusher. ORDERING CONTRACT: callers MUST invoke this AFTER the surrounding
 * db.transaction() has returned (i.e. after commit), NEVER inside the transaction —
 * otherwise the pusher could observe a row that has not yet committed.
 */
export function notifyEnqueued(): void {
  outboxEvents.emit('enqueued');
}

/**
 * Insert a single outbox row. SYNCHRONOUS, pure SQLite, no network, no async.
 * MUST be called inside an existing db.transaction(() => {...}) so the outbox row
 * and the base row commit together. Do NOT call notifyEnqueued() from here — the
 * caller fires it after commit.
 */
export function enqueueOutbox(db: Database, entry: OutboxEntry): void {
  db.prepare(
    `INSERT INTO cloud_outbox (kind, local_id, target_table, status, attempts, lane, created_at_epoch)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)`
  ).run(
    entry.kind,
    entry.localId ?? null,
    entry.targetTable ?? null,
    entry.lane ?? 'live',
    entry.createdAtEpoch
  );
}

/**
 * Atomically claim up to `limit` pending rows in `lane`, flipping them to 'inflight'
 * and returning them. A concurrent/second claim will not re-return the same rows.
 */
export function claimPending(db: Database, lane: OutboxLane, limit: number): OutboxRow[] {
  return db
    .prepare(
      `UPDATE cloud_outbox
          SET status = 'inflight'
        WHERE id IN (
          SELECT id FROM cloud_outbox
           WHERE status = 'pending' AND lane = ?
           ORDER BY id
           LIMIT ?
        )
      RETURNING *`
    )
    .all(lane, limit) as OutboxRow[];
}

/** Remove rows from the queue. Outbox is a queue: done = gone. */
export function markDone(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM cloud_outbox WHERE id IN (${placeholders})`).run(...ids);
}

/** Mark rows as poison-pilled so the pusher stops retrying them. */
export function markQuarantined(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE cloud_outbox SET status = 'quarantined' WHERE id IN (${placeholders})`).run(...ids);
}

/** Increment attempt counters and reset inflight rows back to pending for retry. */
export function bumpAttempts(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE cloud_outbox SET attempts = attempts + 1, status = 'pending' WHERE id IN (${placeholders})`
  ).run(...ids);
}

/** Counts grouped by status, e.g. { pending: 3, inflight: 1 }. */
export function countByStatus(db: Database): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM cloud_outbox GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.n;
  return out;
}

/** Age in ms of the oldest pending row (0 if none) — used for lag/health metrics. */
export function oldestPendingAgeMs(db: Database): number {
  const row = db
    .prepare(`SELECT MIN(created_at_epoch) AS oldest FROM cloud_outbox WHERE status = 'pending'`)
    .get() as { oldest: number | null } | undefined;
  if (!row || row.oldest == null) return 0;
  return Math.max(0, Date.now() - row.oldest);
}
