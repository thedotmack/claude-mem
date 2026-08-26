import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

/**
 * `schema_versions` row 11 records that the discovery_tokens migration once ran. It says
 * nothing about whether the columns are there now — and something rebuilding
 * `session_summaries` to its pre-discovery_tokens shape (an old-version worker spawned
 * from a stale plugin cache) leaves the row behind. The guard used to return early on
 * that row, so the repair never ran again and every summary write failed with
 * `table session_summaries has no column named discovery_tokens` (#3738).
 */

function hasColumn(db: Database, table: string, column: string): boolean {
  const info = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.some(col => col.name === column);
}

/**
 * A database whose migration history says "applied" while the column is absent.
 *
 * Only row 11 is seeded. The canonical `session_summaries` CREATE does not declare
 * `discovery_tokens` — migration 11 is what adds it — so letting the store build the
 * table while the row already exists reproduces the reported state exactly: the shape an
 * old-version worker leaves behind, with the history claiming the migration is done.
 */
function seedHistoryWithoutTheColumn(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
    11,
    new Date().toISOString(),
  );
}

describe('discovery_tokens column repair (#3738)', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('re-adds the column when history says applied but the table lacks it', () => {
    const db = new Database(':memory:');
    seedHistoryWithoutTheColumn(db);

    const applied = db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(11) as { version: number } | undefined;
    expect(applied?.version).toBe(11);

    store = new SessionStore(db);

    expect(hasColumn(db, 'session_summaries', 'discovery_tokens')).toBe(true);
    expect(hasColumn(db, 'observations', 'discovery_tokens')).toBe(true);
  });

  it('lets a summary row carry discovery_tokens afterwards', () => {
    const db = new Database(':memory:');
    seedHistoryWithoutTheColumn(db);
    store = new SessionStore(db);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('content-1', 'mem-1', 'proj', now, Date.now(), 'completed');

    // The failure users reported was on the write, not at boot, so drive a write.
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_summaries (memory_session_id, project, created_at, created_at_epoch, discovery_tokens)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('mem-1', 'proj', now, Date.now(), 7),
    ).not.toThrow();

    const row = db
      .prepare('SELECT discovery_tokens FROM session_summaries WHERE memory_session_id = ?')
      .get('mem-1') as { discovery_tokens: number } | undefined;
    expect(row?.discovery_tokens).toBe(7);
  });

  it('adds the column once, not once per boot', () => {
    const db = new Database(':memory:');
    seedHistoryWithoutTheColumn(db);

    // Not closed between the two: `close()` closes the shared handle, and what is
    // under test is the second boot seeing the repaired table, not connection reuse.
    new SessionStore(db);
    // A second boot must not try to ALTER an already-present column.
    store = new SessionStore(db);

    const info = db.query('PRAGMA table_info(session_summaries)').all() as Array<{ name: string }>;
    expect(info.filter(col => col.name === 'discovery_tokens').length).toBe(1);
  });
});
