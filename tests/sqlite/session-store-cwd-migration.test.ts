// #2864: sdk_sessions.cwd is added by a PRAGMA-guarded migration. The guard
// makes it idempotent on its own, but the schema ledger is how this codebase
// records that a change was applied, so the version has to land too.
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const SESSION_CWD_SCHEMA_VERSION = 50;

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function open(): { store: SessionStore; dbPath: string } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-cwd-migration-'));
  const dbPath = path.join(tempRoot, 'claude-mem.db');
  return { store: new SessionStore(dbPath), dbPath };
}

describe('sdk_sessions.cwd migration (#2864)', () => {
  it('records its schema version in the ledger', () => {
    const { store } = open();
    const row = store.db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(SESSION_CWD_SCHEMA_VERSION) as { version: number } | undefined;
    store.close();

    expect(row?.version).toBe(SESSION_CWD_SCHEMA_VERSION);
  });

  it('adds the column and index', () => {
    const { store } = open();
    const cols = store.db.prepare('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
    const idx = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sdk_sessions_cwd'")
      .get() as { name: string } | undefined;
    store.close();

    expect(cols.some(c => c.name === 'cwd')).toBe(true);
    expect(idx?.name).toBe('idx_sdk_sessions_cwd');
  });

  it('reopens cleanly without duplicating the ledger entry', () => {
    const { store, dbPath } = open();
    store.close();
    const reopened = new SessionStore(dbPath);
    const count = (reopened.db
      .prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = ?')
      .get(SESSION_CWD_SCHEMA_VERSION) as { n: number }).n;
    reopened.close();

    expect(count).toBe(1);
  });
});
