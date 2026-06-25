import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { resolveDbPath } from '../../../src/shared/paths.js';

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
      if (!busy) throw error;
      if (attempt === attempts) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

describe('Database PRAGMAs', () => {
  it('applies busy_timeout in DatabaseManager initialization', async () => {
    const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    const originalChromaEnabled = process.env.CLAUDE_MEM_CHROMA_ENABLED;
    const testDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-sqlite-'));
    process.env.CLAUDE_MEM_DATA_DIR = testDataDir;
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'false';
    mkdirSync(join(testDataDir, 'logs'), { recursive: true });

    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');
    const manager = new DatabaseManager();

    try {
      await manager.initialize();
      const db = manager.getConnection();
      expect(getBusyTimeout(db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
      expect(resolveDbPath()).toBe(join(testDataDir, 'claude-mem.db'));
    } finally {
      await manager.close();
      if (originalDataDir === undefined) {
        delete process.env.CLAUDE_MEM_DATA_DIR;
      } else {
        process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
      }
      if (originalChromaEnabled === undefined) {
        delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
      } else {
        process.env.CLAUDE_MEM_CHROMA_ENABLED = originalChromaEnabled;
      }
      await removeDirWithWindowsRetry(testDataDir);
      mkdirSync(testDataDir, { recursive: true });
      mkdirSync(join(testDataDir, 'logs'), { recursive: true });
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

  it('applies busy_timeout in SessionSearch direct connections', async () => {
    const { SessionSearch } = await import('../../../src/services/sqlite/SessionSearch.js');
    const search = new SessionSearch(':memory:');

    try {
      expect(getBusyTimeout((search as unknown as { db: Database }).db)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      search.close();
    }
  });

  it('applies busy_timeout when SessionSearch receives an existing connection', async () => {
    const testDb = new Database(':memory:');

    const { SessionSearch } = await import('../../../src/services/sqlite/SessionSearch.js');
    const search = new SessionSearch(testDb);

    try {
      expect(getBusyTimeout(testDb)).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      search.close();
    }
  });
});
