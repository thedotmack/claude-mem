import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/sessions/create.js';

function makeDb(): { db: Database; sessionDbId: number } {
  const db = new Database(':memory:');
  new MigrationRunner(db).runAllMigrations();
  const sessionDbId = createSDKSession(db, 'sess-1', 'proj', 'initial');
  return { db, sessionDbId };
}

function insertPendingRow(
  db: Database,
  opts: {
    sessionDbId: number;
    contentSessionId: string;
    toolUseId: string;
    foldKey: string;
    foldCount?: number;
    createdAtEpoch: number;
    id?: number;
  }
): void {
  const cols = [
    'session_db_id',
    'content_session_id',
    'tool_use_id',
    'message_type',
    'tool_name',
    'tool_input',
    'tool_response',
    'created_at_epoch',
    'fold_key',
    'fold_count'
  ];
  const placeholders = ['?', '?', '?', "'observation'", "'Bash'", "'{}'", "'{}'", '?', '?', '?'];
  const args: Array<string | number> = [
    opts.sessionDbId,
    opts.contentSessionId,
    opts.toolUseId,
    opts.createdAtEpoch,
    opts.foldKey,
    opts.foldCount ?? 1
  ];
  if (opts.id !== undefined) {
    cols.unshift('id');
    placeholders.unshift('?');
    args.unshift(opts.id);
  }
  db.prepare(
    `INSERT INTO pending_messages (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`
  ).run(...args);
}

describe('PendingMessageStore.findFoldCandidate', () => {
  it('returns null when no matching row exists', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const hit = store.findFoldCandidate(sessionDbId, 'abc1234567890abc', 30_000, Date.now());
    expect(hit).toBeNull();
  });

  it('returns the most recent row inside the window', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    insertPendingRow(db, {
      sessionDbId,
      contentSessionId: 'sess-1',
      toolUseId: 'tu-1',
      foldKey: 'foldkey-aaa',
      createdAtEpoch: now - 10_000
    });
    const hit = store.findFoldCandidate(sessionDbId, 'foldkey-aaa', 30_000, now);
    expect(hit).not.toBeNull();
    expect(hit!.createdAtEpoch).toBe(now - 10_000);
  });

  it('returns null when the row is outside the window', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    insertPendingRow(db, {
      sessionDbId,
      contentSessionId: 'sess-1',
      toolUseId: 'tu-1',
      foldKey: 'foldkey-aaa',
      createdAtEpoch: now - 60_000
    });
    const hit = store.findFoldCandidate(sessionDbId, 'foldkey-aaa', 30_000, now);
    expect(hit).toBeNull();
  });

  it('isolates by session_db_id', () => {
    const { db, sessionDbId } = makeDb();
    const otherSessionDbId = createSDKSession(db, 'sess-2', 'proj', 'initial');
    const store = new PendingMessageStore(db);
    const now = Date.now();
    insertPendingRow(db, {
      sessionDbId: otherSessionDbId,
      contentSessionId: 'sess-2',
      toolUseId: 'tu-1',
      foldKey: 'foldkey-aaa',
      createdAtEpoch: now - 5_000
    });
    const hit = store.findFoldCandidate(sessionDbId, 'foldkey-aaa', 30_000, now);
    expect(hit).toBeNull();
  });

  it('returns the newest row when multiple match within the window', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    insertPendingRow(db, {
      sessionDbId,
      contentSessionId: 'sess-1',
      toolUseId: 'tu-1',
      foldKey: 'foldkey-aaa',
      createdAtEpoch: now - 20_000
    });
    insertPendingRow(db, {
      sessionDbId,
      contentSessionId: 'sess-1',
      toolUseId: 'tu-2',
      foldKey: 'foldkey-aaa',
      createdAtEpoch: now - 5_000
    });
    const hit = store.findFoldCandidate(sessionDbId, 'foldkey-aaa', 30_000, now);
    expect(hit).not.toBeNull();
    expect(hit!.createdAtEpoch).toBe(now - 5_000);
  });
});

describe('PendingMessageStore.bumpFoldCount', () => {
  it('increments fold_count and returns the new value', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const now = Date.now();
    insertPendingRow(db, {
      id: 42,
      sessionDbId,
      contentSessionId: 'sess-1',
      toolUseId: 'tu-1',
      foldKey: 'foldkey-aaa',
      foldCount: 3,
      createdAtEpoch: now
    });
    const result = store.bumpFoldCount(42);
    expect(result.newCount).toBe(4);
    const row = db.prepare('SELECT fold_count FROM pending_messages WHERE id = 42').get() as { fold_count: number };
    expect(row.fold_count).toBe(4);
  });

  it('throws when the target row does not exist', () => {
    const { db } = makeDb();
    const store = new PendingMessageStore(db);
    expect(() => store.bumpFoldCount(9999)).toThrow();
  });
});

describe('PendingMessageStore.enqueue with foldKey', () => {
  it('persists foldKey when provided', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const messageId = store.enqueue(
      sessionDbId,
      'sess-1',
      { type: 'observation', tool_name: 'Bash', toolUseId: 'tu-fold' },
      'foldkey-xyz'
    );
    expect(messageId).toBeGreaterThan(0);
    const row = db
      .prepare('SELECT fold_key, fold_count FROM pending_messages WHERE id = ?')
      .get(messageId) as { fold_key: string | null; fold_count: number };
    expect(row.fold_key).toBe('foldkey-xyz');
    expect(row.fold_count).toBe(1);
  });

  it('persists null foldKey when omitted', () => {
    const { db, sessionDbId } = makeDb();
    const store = new PendingMessageStore(db);
    const messageId = store.enqueue(
      sessionDbId,
      'sess-1',
      { type: 'observation', tool_name: 'Bash', toolUseId: 'tu-nofold' }
    );
    expect(messageId).toBeGreaterThan(0);
    const row = db
      .prepare('SELECT fold_key FROM pending_messages WHERE id = ?')
      .get(messageId) as { fold_key: string | null };
    expect(row.fold_key).toBeNull();
  });
});
