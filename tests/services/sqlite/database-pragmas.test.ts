import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';

type BusyTimeoutRow = {
  busy_timeout?: number | string;
};

const SQLITE_BUSY_TIMEOUT_MS = 5000;

function getBusyTimeout(db: Database): number {
  const row = db.prepare('PRAGMA busy_timeout').get() as BusyTimeoutRow;
  return Number(row?.busy_timeout);
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
      rmSync(testDataDir, { recursive: true, force: true });
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
});
