
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { sweepStalePendingMessages } from '../../src/services/infrastructure/StalePendingSweep.js';
import { logger } from '../../src/utils/logger.js';

const HOUR_MS = 60 * 60 * 1000;

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function silenceLogger(): void {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
}

function restoreLogger(): void {
  loggerSpies.forEach(s => s.mockRestore());
  loggerSpies = [];
}

function seedSession(db: Database, suffix: string, status: 'active' | 'completed' | 'failed' = 'active'): number {
  const now = new Date().toISOString();
  const epoch = Date.now();
  const result = db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, 'test-project', ?, ?, ?)`
  ).run(`content-${suffix}`, `memory-${suffix}`, now, epoch, status);
  return Number(result.lastInsertRowid);
}

function seedPending(db: Database, sessionDbId: number, suffix: string, createdAtEpoch: number, count = 1): void {
  const insert = db.prepare(
    `INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
     VALUES (?, ?, 'observation', 'pending', ?)`
  );
  for (let i = 0; i < count; i++) insert.run(sessionDbId, `content-${suffix}`, createdAtEpoch);
}

function pendingCount(db: Database, sessionDbId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM pending_messages WHERE session_db_id = ?')
    .get(sessionDbId) as { n: number }).n;
}

function sessionStatus(db: Database, sessionDbId: number): string {
  return (db.prepare('SELECT status FROM sdk_sessions WHERE id = ?')
    .get(sessionDbId) as { status: string }).status;
}

describe('sweepStalePendingMessages', () => {
  let cmdb: ClaudeMemDatabase;
  let db: Database;
  const now = Date.now();

  beforeEach(() => {
    cmdb = new ClaudeMemDatabase(':memory:');
    db = cmdb.db;
    silenceLogger();
  });

  afterEach(() => {
    restoreLogger();
    cmdb.close();
  });

  it('deletes pending_messages of a stale orphaned session and marks the session failed', () => {
    const sid = seedSession(db, 'stale');
    seedPending(db, sid, 'stale', now - 8 * HOUR_MS, 3);

    const result = sweepStalePendingMessages(db, new Set<number>(), { now });

    expect(result.staleSessions).toBe(1);
    expect(result.deletedMessages).toBe(3);
    expect(result.failedSessions).toBe(1);
    expect(pendingCount(db, sid)).toBe(0);
    expect(sessionStatus(db, sid)).toBe('failed');
  });

  it('leaves a session with recent pending_messages untouched', () => {
    const sid = seedSession(db, 'recent');
    seedPending(db, sid, 'recent', now - 1 * HOUR_MS, 2);

    const result = sweepStalePendingMessages(db, new Set<number>(), { now });

    expect(result.staleSessions).toBe(0);
    expect(pendingCount(db, sid)).toBe(2);
    expect(sessionStatus(db, sid)).toBe('active');
  });

  it('skips a stale session that is still in the active set', () => {
    const sid = seedSession(db, 'active');
    seedPending(db, sid, 'active', now - 8 * HOUR_MS, 2);

    const result = sweepStalePendingMessages(db, new Set<number>([sid]), { now });

    expect(result.staleSessions).toBe(0);
    expect(pendingCount(db, sid)).toBe(2);
    expect(sessionStatus(db, sid)).toBe('active');
  });

  it('protects a session whose newest pending_message is recent even if older ones exist', () => {
    const sid = seedSession(db, 'mixed');
    seedPending(db, sid, 'mixed', now - 8 * HOUR_MS, 1);
    seedPending(db, sid, 'mixed', now - 1 * HOUR_MS, 1);

    const result = sweepStalePendingMessages(db, new Set<number>(), { now });

    expect(result.staleSessions).toBe(0);
    expect(pendingCount(db, sid)).toBe(2);
  });

  it('does not change a session whose status is not active', () => {
    const sid = seedSession(db, 'done', 'completed');
    seedPending(db, sid, 'done', now - 8 * HOUR_MS, 1);

    const result = sweepStalePendingMessages(db, new Set<number>(), { now });

    expect(result.deletedMessages).toBe(1);
    expect(result.failedSessions).toBe(0);
    expect(sessionStatus(db, sid)).toBe('completed');
  });
});
