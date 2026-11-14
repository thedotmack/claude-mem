import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DB_INIT_BUSY_RETRY_DELAYS_MS,
  initializeDatabaseWithBusyRetry,
  isTransientSqliteBusy,
} from '../../src/services/worker/db-init-retry.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

function sqliteError(code: string, message = 'database is locked'): Error {
  return Object.assign(new Error(message), { code });
}

/** A database manager whose initialize() throws the queued errors in order, then succeeds. */
function fakeDb(failures: unknown[]) {
  const calls: string[] = [];
  return {
    calls,
    async initialize() {
      calls.push('initialize');
      const next = failures.shift();
      if (next !== undefined) throw next;
    },
    async close() {
      calls.push('close');
    },
  };
}

beforeEach(() => {
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
});

describe('isTransientSqliteBusy', () => {
  it('accepts SQLITE_BUSY and its extended codes', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY', 'SQLITE_BUSY_TIMEOUT']) {
      expect(isTransientSqliteBusy(sqliteError(code))).toBe(true);
    }
  });

  it('rejects other errors', () => {
    for (const value of [
      sqliteError('SQLITE_LOCKED'),
      sqliteError('SQLITE_CORRUPT'),
      sqliteError('SQLITE_BUSYX'),
      new Error('database is locked'),
      'SQLITE_BUSY',
      null,
      undefined,
    ]) {
      expect(isTransientSqliteBusy(value)).toBe(false);
    }
  });

  it('matches the error bun:sqlite throws for a WAL snapshot conflict (#3603)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-busy-snapshot-'));
    const path = join(dir, 'snapshot.db');
    const a = new Database(path);
    const b = new Database(path);
    try {
      a.run('PRAGMA journal_mode = WAL');
      a.run('CREATE TABLE t (x INTEGER)');
      // busy_timeout does not apply to snapshot conflicts: SQLite fails at once.
      a.run('PRAGMA busy_timeout = 5000');
      a.run('BEGIN');
      a.query('SELECT count(*) FROM t').get();
      b.run('INSERT INTO t VALUES (1)');
      let thrown: unknown;
      try {
        a.run('INSERT INTO t VALUES (2)');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string }).code).toBe('SQLITE_BUSY_SNAPSHOT');
      expect(isTransientSqliteBusy(thrown)).toBe(true);
      a.run('ROLLBACK');
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('initializeDatabaseWithBusyRetry', () => {
  it('initializes once when the database is free', async () => {
    const db = fakeDb([]);
    const sleeps: number[] = [];
    await initializeDatabaseWithBusyRetry(db, { sleep: async ms => { sleeps.push(ms); } });
    expect(db.calls).toEqual(['initialize']);
    expect(sleeps).toEqual([]);
  });

  it('closes, waits and retries after SQLITE_BUSY_SNAPSHOT, then succeeds', async () => {
    const db = fakeDb([sqliteError('SQLITE_BUSY_SNAPSHOT'), sqliteError('SQLITE_BUSY')]);
    const sleeps: number[] = [];
    await initializeDatabaseWithBusyRetry(db, { sleep: async ms => { sleeps.push(ms); } });
    expect(db.calls).toEqual(['initialize', 'close', 'initialize', 'close', 'initialize']);
    expect(sleeps).toEqual(DB_INIT_BUSY_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('throws the last busy error once the retries are spent', async () => {
    const delaysMs = [1, 2];
    const last = sqliteError('SQLITE_BUSY_SNAPSHOT', 'last');
    const db = fakeDb([sqliteError('SQLITE_BUSY_SNAPSHOT'), sqliteError('SQLITE_BUSY'), last]);
    await expect(initializeDatabaseWithBusyRetry(db, { delaysMs, sleep: async () => {} })).rejects.toBe(last);
    expect(db.calls.filter(call => call === 'initialize')).toHaveLength(3);
  });

  it('does not retry an error that is not SQLITE_BUSY*', async () => {
    const corrupt = sqliteError('SQLITE_CORRUPT', 'database disk image is malformed');
    const db = fakeDb([corrupt]);
    await expect(initializeDatabaseWithBusyRetry(db, { sleep: async () => {} })).rejects.toBe(corrupt);
    expect(db.calls).toEqual(['initialize']);
  });

  it('stops retrying when the worker starts shutting down during the wait', async () => {
    let shuttingDown = false;
    const busy = sqliteError('SQLITE_BUSY_SNAPSHOT');
    const db = fakeDb([busy]);
    await expect(initializeDatabaseWithBusyRetry(db, {
      sleep: async () => { shuttingDown = true; },
      shouldStop: () => shuttingDown,
    })).rejects.toBe(busy);
    expect(db.calls).toEqual(['initialize', 'close']);
  });

  it('reports the busy error and stops when close fails', async () => {
    const busy = sqliteError('SQLITE_BUSY_SNAPSHOT');
    const db = fakeDb([busy]);
    db.close = async () => { throw new Error('close failed'); };
    await expect(initializeDatabaseWithBusyRetry(db, { sleep: async () => {} })).rejects.toBe(busy);
    expect(db.calls).toEqual(['initialize']);
  });
});

// tests/preload.ts points CLAUDE_MEM_DATA_DIR at a disposable directory, so this
// real DatabaseManager never opens user data.
describe('DatabaseManager after a busy-retry close', () => {
  it('gives the next initialize() a live tool-use index signal', async () => {
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    });
    const signals: (AbortSignal | undefined)[] = [];
    spyOn(SessionSearch.prototype, 'configureToolUseIndex').mockImplementation(async (_enabled, signal) => {
      signals.push(signal);
    });
    const manager = new DatabaseManager();
    try {
      await manager.initialize();
      await manager.close();
      await manager.initialize();
      await manager.initializeToolUseSearch();
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
    } finally {
      await manager.close();
    }
  });
});
