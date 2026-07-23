import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export type ObserverJobState = 'pending' | 'claimed' | 'settled' | 'quarantined';

export type ObserverJob = {
  id: number;
  sessionDbId: number;
  sourceEventId: string;
  payload: PendingMessage;
  state: ObserverJobState;
  attempts: number;
  lastErrorClass: string | null;
  nextAttemptAtEpoch: number | null;
};

export type ObserverJobMetrics = {
  pending: number;
  claimed: number;
  quarantined: number;
  settled: number;
};

export type ObserverStatus = ObserverJobMetrics & {
  /**
   * This is deliberately a queue/recovery diagnostic, not a claim that the
   * provider has authenticated. A provider canary is a separate, active
   * probe and must not be faked from process liveness.
   */
  state: 'ready' | 'degraded' | 'blocked' | 'recovering';
  lastErrorClass: string | null;
  oldestPendingAgeMs: number | null;
};

/**
 * Durable observer source-event ledger. This intentionally does not reuse the
 * retired pending_messages queue: job identity, recovery state, error class,
 * and generation checkpoints are explicit and survive worker restarts.
 */
export class ObserverJobStore {
  constructor(private readonly db: Database) {
    this.initialize();
    logger.debug('WORKER', 'Durable observer job ledger initialized');
  }

  admit(sessionDbId: number, payload: PendingMessage): { id: number; admitted: boolean } {
    const sourceEventId = sourceEventIdFor(payload);
    const now = Date.now();
    const inserted = this.db.prepare(`
      INSERT INTO observer_jobs (
        session_db_id, source_event_id, payload_json, state, attempts,
        created_at_epoch, updated_at_epoch
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(session_db_id, source_event_id) DO NOTHING
      RETURNING id
    `).get(sessionDbId, sourceEventId, JSON.stringify(payload), now, now) as { id: number } | null;

    if (inserted) {
      return { id: inserted.id, admitted: true };
    }

    const existing = this.db.prepare(`
      SELECT id FROM observer_jobs
      WHERE session_db_id = ? AND source_event_id = ?
    `).get(sessionDbId, sourceEventId) as { id: number } | null;
    if (!existing) {
      throw new Error('observer job admission conflict without an existing job');
    }
    return { id: existing.id, admitted: false };
  }

  claim(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE observer_jobs
      SET state = 'claimed', updated_at_epoch = ?
      WHERE id = ? AND state = 'pending'
    `).run(Date.now(), id);
    return result.changes === 1;
  }

  /** Claimed jobs are reset atomically before a new worker begins processing. */
  recover(sessionDbId: number): ObserverJob[] {
    const recover = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE observer_jobs
        SET state = 'pending', updated_at_epoch = ?
        WHERE session_db_id = ? AND state = 'claimed'
      `).run(Date.now(), sessionDbId);
      return this.db.prepare(`
        SELECT id, session_db_id, source_event_id, payload_json, state, attempts,
               last_error_class, next_attempt_at_epoch
        FROM observer_jobs
        WHERE session_db_id = ? AND state = 'pending'
        ORDER BY id
      `).all(sessionDbId) as Array<{
        id: number;
        session_db_id: number;
        source_event_id: string;
        payload_json: string;
        state: ObserverJobState;
        attempts: number;
        last_error_class: string | null;
        next_attempt_at_epoch: number | null;
      }>;
    });

    return recover().map(row => ({
      id: row.id,
      sessionDbId: row.session_db_id,
      sourceEventId: row.source_event_id,
      payload: JSON.parse(row.payload_json) as PendingMessage,
      state: row.state,
      attempts: row.attempts,
      lastErrorClass: row.last_error_class,
      nextAttemptAtEpoch: row.next_attempt_at_epoch,
    }));
  }

  reset(ids: number[], errorClass: string, nextAttemptAtEpoch: number | null = null): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE observer_jobs
      SET state = 'pending', attempts = attempts + 1, last_error_class = ?,
          next_attempt_at_epoch = ?, updated_at_epoch = ?
      WHERE id IN (${placeholders}) AND state = 'claimed'
    `).run(errorClass, nextAttemptAtEpoch, Date.now(), ...ids);
  }

  settle(ids: number[]): void {
    this.setState(ids, 'settled');
  }

  quarantine(ids: number[], errorClass: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE observer_jobs
      SET state = 'quarantined', attempts = attempts + 1, last_error_class = ?,
          next_attempt_at_epoch = NULL, updated_at_epoch = ?
      WHERE id IN (${placeholders}) AND state = 'claimed'
    `).run(errorClass, Date.now(), ...ids);
  }

  checkpoint(sessionDbId: number, generation: number, checkpoint: unknown): void {
    this.db.prepare(`
      INSERT INTO observer_generations (session_db_id, generation, checkpoint_json, updated_at_epoch)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_db_id) DO UPDATE SET
        generation = excluded.generation,
        checkpoint_json = excluded.checkpoint_json,
        updated_at_epoch = excluded.updated_at_epoch
    `).run(sessionDbId, generation, JSON.stringify(checkpoint), Date.now());
  }

  getCheckpoint(sessionDbId: number): { generation: number; checkpoint: unknown } | null {
    const row = this.db.prepare(`
      SELECT generation, checkpoint_json FROM observer_generations WHERE session_db_id = ?
    `).get(sessionDbId) as { generation: number; checkpoint_json: string } | null;
    return row ? { generation: row.generation, checkpoint: JSON.parse(row.checkpoint_json) } : null;
  }

  metrics(sessionDbId: number): ObserverJobMetrics {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count FROM observer_jobs
      WHERE session_db_id = ? GROUP BY state
    `).all(sessionDbId) as Array<{ state: ObserverJobState; count: number }>;
    const metrics: ObserverJobMetrics = { pending: 0, claimed: 0, quarantined: 0, settled: 0 };
    for (const row of rows) metrics[row.state] = row.count;
    return metrics;
  }

  status(): ObserverStatus {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count FROM observer_jobs GROUP BY state
    `).all() as Array<{ state: ObserverJobState; count: number }>;
    const metrics: ObserverJobMetrics = { pending: 0, claimed: 0, quarantined: 0, settled: 0 };
    for (const row of rows) metrics[row.state] = row.count;

    const latest = this.db.prepare(`
      SELECT last_error_class FROM observer_jobs
      WHERE last_error_class IS NOT NULL
      ORDER BY updated_at_epoch DESC LIMIT 1
    `).get() as { last_error_class: string } | null;
    const oldest = this.db.prepare(`
      SELECT MIN(created_at_epoch) AS created_at_epoch
      FROM observer_jobs WHERE state = 'pending'
    `).get() as { created_at_epoch: number | null };
    const lastErrorClass = latest?.last_error_class ?? null;
    const blocked = metrics.pending > 0 && (lastErrorClass === 'auth_invalid' || lastErrorClass === 'setup_required');
    const state = blocked
      ? 'blocked'
      : metrics.claimed > 0 || (metrics.pending > 0 && lastErrorClass !== null)
        ? 'recovering'
        : metrics.quarantined > 0
          ? 'degraded'
          : 'ready';

    return {
      ...metrics,
      state,
      lastErrorClass,
      oldestPendingAgeMs: oldest.created_at_epoch === null ? null : Math.max(0, Date.now() - oldest.created_at_epoch),
    };
  }

  private setState(ids: number[], state: 'settled'): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE observer_jobs
      SET state = ?, updated_at_epoch = ?
      WHERE id IN (${placeholders}) AND state = 'claimed'
    `).run(state, Date.now(), ...ids);
  }

  private initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS observer_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        source_event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'claimed', 'settled', 'quarantined')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_class TEXT,
        next_attempt_at_epoch INTEGER,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER NOT NULL,
        UNIQUE(session_db_id, source_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observer_jobs_recovery
        ON observer_jobs(session_db_id, state, id);
      CREATE TABLE IF NOT EXISTS observer_generations (
        session_db_id INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        checkpoint_json TEXT NOT NULL,
        updated_at_epoch INTEGER NOT NULL
      );
    `);
  }
}

function sourceEventIdFor(payload: PendingMessage): string {
  if (payload.toolUseId) return `tool:${payload.toolUseId}`;
  return `event:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
