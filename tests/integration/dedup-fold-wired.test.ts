import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/sessions/create.js';
import {
  shouldFold,
  computeFoldKey,
  _resetDedupFoldConfigCache,
  type DedupFoldConfig,
  type PendingObservationForFold
} from '../../src/services/worker/dedup-fold.js';

function setupDb(): { db: Database; store: PendingMessageStore; sessionDbId: number } {
  const db = new Database(':memory:');
  new MigrationRunner(db).runAllMigrations();
  const sessionDbId = createSDKSession(db, 'sess-int-1', 'proj', 'initial');
  const store = new PendingMessageStore(db);
  return { db, store, sessionDbId };
}

function insertObs(
  db: Database,
  opts: {
    sessionDbId: number;
    contentSessionId: string;
    toolUseId: string;
    foldKey: string;
    createdAtEpoch: number;
    foldCount?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO pending_messages (
        session_db_id, content_session_id, tool_use_id, message_type,
        tool_name, tool_input, tool_response, created_at_epoch,
        fold_key, fold_count
      ) VALUES (?, ?, ?, 'observation', 'Bash', '{}', '{}', ?, ?, ?)`
    )
    .run(
      opts.sessionDbId,
      opts.contentSessionId,
      opts.toolUseId,
      opts.createdAtEpoch,
      opts.foldKey,
      opts.foldCount ?? 1
    );
  return result.lastInsertRowid as number;
}

function countPendingRows(db: Database, sessionDbId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as c FROM pending_messages WHERE session_db_id = ?')
    .get(sessionDbId) as { c: number };
  return row.c;
}

describe('dedup-fold end-to-end (real store + fold lib)', () => {
  beforeEach(() => {
    _resetDedupFoldConfigCache();
  });
  afterEach(() => {
    _resetDedupFoldConfigCache();
  });

  it('5x identical Bash(ls) within 30s collapses to 1 row with fold_count=5', () => {
    const { db, store, sessionDbId } = setupDb();
    const config: DedupFoldConfig = { enabled: true, windowSeconds: 30, disabledTools: [] };
    const now = Date.now();
    const obs: PendingObservationForFold = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/repo',
      agent_id: 'main',
      created_at_epoch: now
    };
    const foldKey = computeFoldKey(obs);

    const first = shouldFold(obs, sessionDbId, config, store);
    expect(first.fold).toBe(false);
    expect((first as { fold: false; foldKey?: string }).foldKey).toBe(foldKey);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-1',
      foldKey,
      createdAtEpoch: now
    });

    for (let i = 2; i <= 5; i++) {
      const decision = shouldFold(
        { ...obs, created_at_epoch: now + i * 1000 },
        sessionDbId,
        config,
        store
      );
      expect(decision.fold).toBe(true);
      const onto = (decision as { fold: true; foldOntoRowId: number }).foldOntoRowId;
      expect(onto).toBeGreaterThan(0);
      store.bumpFoldCount(onto);
    }

    expect(countPendingRows(db, sessionDbId)).toBe(1);
    const row = db
      .prepare('SELECT id, fold_count FROM pending_messages WHERE session_db_id = ?')
      .get(sessionDbId) as { id: number; fold_count: number };
    expect(row.fold_count).toBe(5);
  });

  it('crossing the 30s window opens a new row instead of folding', () => {
    const { db, store, sessionDbId } = setupDb();
    const config: DedupFoldConfig = { enabled: true, windowSeconds: 30, disabledTools: [] };
    const now = Date.now();
    const obs: PendingObservationForFold = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/repo',
      agent_id: 'main',
      created_at_epoch: now
    };
    const foldKey = computeFoldKey(obs);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-1',
      foldKey,
      createdAtEpoch: now
    });

    const insideWindow = shouldFold(
      { ...obs, created_at_epoch: now + 29_000 },
      sessionDbId,
      config,
      store
    );
    expect(insideWindow.fold).toBe(true);

    const outsideWindow = shouldFold(
      { ...obs, created_at_epoch: now + 31_000 },
      sessionDbId,
      config,
      store
    );
    expect(outsideWindow.fold).toBe(false);
    expect((outsideWindow as { fold: false; foldKey?: string }).foldKey).toBe(foldKey);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-2',
      foldKey,
      createdAtEpoch: now + 31_000
    });

    expect(countPendingRows(db, sessionDbId)).toBe(2);
  });

  it('disabled feature never folds even when a matching candidate exists', () => {
    const { db, store, sessionDbId } = setupDb();
    const disabledConfig: DedupFoldConfig = {
      enabled: false,
      windowSeconds: 30,
      disabledTools: []
    };
    const now = Date.now();
    const obs: PendingObservationForFold = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/repo',
      agent_id: 'main',
      created_at_epoch: now
    };
    const foldKey = computeFoldKey(obs);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-1',
      foldKey,
      createdAtEpoch: now
    });

    const decision = shouldFold(
      { ...obs, created_at_epoch: now + 5_000 },
      sessionDbId,
      disabledConfig,
      store
    );
    expect(decision.fold).toBe(false);
    expect((decision as { fold: false; foldKey?: string }).foldKey).toBeUndefined();
  });

  it('tool listed in disabledTools never folds', () => {
    const { db, store, sessionDbId } = setupDb();
    const config: DedupFoldConfig = {
      enabled: true,
      windowSeconds: 30,
      disabledTools: ['Bash']
    };
    const now = Date.now();
    const obs: PendingObservationForFold = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/repo',
      agent_id: 'main',
      created_at_epoch: now
    };
    const foldKey = computeFoldKey(obs);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-1',
      foldKey,
      createdAtEpoch: now
    });

    const decision = shouldFold(
      { ...obs, created_at_epoch: now + 5_000 },
      sessionDbId,
      config,
      store
    );
    expect(decision.fold).toBe(false);
    expect((decision as { fold: false; foldKey?: string }).foldKey).toBeUndefined();
  });

  it('subagent isolation: different agent_id produces different fold_key and does not fold', () => {
    const { db, store, sessionDbId } = setupDb();
    const config: DedupFoldConfig = { enabled: true, windowSeconds: 30, disabledTools: [] };
    const now = Date.now();

    const mainObs: PendingObservationForFold = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/repo',
      agent_id: 'main',
      created_at_epoch: now
    };
    const subObs: PendingObservationForFold = {
      ...mainObs,
      agent_id: 'sub-1',
      created_at_epoch: now + 5_000
    };

    const mainKey = computeFoldKey(mainObs);
    const subKey = computeFoldKey(subObs);
    expect(mainKey).not.toBe(subKey);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-main',
      foldKey: mainKey,
      createdAtEpoch: now
    });

    const decision = shouldFold(subObs, sessionDbId, config, store);
    expect(decision.fold).toBe(false);
    expect((decision as { fold: false; foldKey?: string }).foldKey).toBe(subKey);

    insertObs(db, {
      sessionDbId,
      contentSessionId: 'sess-int-1',
      toolUseId: 'tu-sub',
      foldKey: subKey,
      createdAtEpoch: now + 5_000
    });

    expect(countPendingRows(db, sessionDbId)).toBe(2);
  });
});
