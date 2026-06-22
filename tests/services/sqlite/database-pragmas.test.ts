import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';

type BusyTimeoutRow = {
  busy_timeout?: number | string;
  timeout?: number | string;
};

const SQLITE_BUSY_TIMEOUT_MS = 5000;

function getBusyTimeout(db: Database): number {
  const row = db.prepare('PRAGMA busy_timeout').get() as BusyTimeoutRow;
  return Number(row?.busy_timeout ?? row?.timeout ?? Object.values(row ?? {})[0]);
}

async function removeDirWithWindowsRetry(path: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 5 : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const busy = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EBUSY';
      if (!busy || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

describe('Database PRAGMAs', () => {
  it('applies busy_timeout in DatabaseManager initialization', async () => {
    const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    const testDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-sqlite-'));
    process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');
    const manager = new DatabaseManager();

    try {
      await manager.initialize();
      const db = manager.getConnection();
      expect(getBusyTimeout(db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      await manager.close();
      if (originalDataDir === undefined) {
        delete process.env.CLAUDE_MEM_DATA_DIR;
      } else {
        process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
      }
      await removeDirWithWindowsRetry(testDataDir);
    }
  });

  it('applies busy_timeout in direct connections', async () => {
    const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
    const store = new SessionStore(':memory:');

    try {
      expect(getBusyTimeout(store.db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      store.db.close();
    }
  });

  it('applies busy_timeout in SessionStore with path argument', async () => {
    const testDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-sessionstore-'));
    const testDbPath = join(testDataDir, 'test.db');

    const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
    const store = new SessionStore(testDbPath);

    try {
      expect(getBusyTimeout(store.db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      try {
        store.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (e) {
      }
      store.close();
      await removeDirWithWindowsRetry(testDataDir);
    }
  });

  it('preserves busy_timeout when SessionStore receives existing connection', async () => {
    const { Database } = await import('bun:sqlite');
    const testDb = new Database(':memory:');
    testDb.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
    const store = new SessionStore(testDb);

    try {
      expect(getBusyTimeout(store.db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  });
});
