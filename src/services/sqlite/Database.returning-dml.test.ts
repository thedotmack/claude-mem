/**
 * Regression test for the RETURNING-DML write-amplification bug.
 *
 * The first cut of `BunSqliteHandleWrapper`/`ClaudeMemDatabase`'s `execute`
 * path classified DML by checking for `\breturning\b`, then ran `query.run()`
 * AND a fresh `query.all()` to capture RETURNING rows. Both `.run()` and
 * `.all()` execute the underlying DML, so the row was inserted twice.
 *
 * The fix: for RETURNING DML, use a single `.all()` call (which executes the
 * DML once and returns the RETURNING rows). For plain DML, keep `.run()`.
 *
 * This test always runs (default bun-sqlite backend, no env-flag gating).
 * Place a parallel libSQL coverage in `Database.libsql-smoke.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

// Re-import the private wrapper class via the same module path the impl uses.
// We can't import `BunSqliteHandleWrapper` directly because it isn't exported,
// but `ClaudeMemDatabase`'s `execute` method shares the same logic and IS
// exported. The fix lives in both — testing one verifies both since the fix
// is structurally identical.
import { ClaudeMemDatabase } from './Database.js';

describe('ClaudeMemDatabase RETURNING-DML execution count', () => {
  let cmd: ClaudeMemDatabase;
  let raw: Database;
  // Project-local scratch dir per CLAUDE.md ("never /tmp/").
  const dbPath = `${process.cwd()}/.scratch/returning-dml-test-${process.pid}-${Date.now()}.db`;

  beforeEach(() => {
    cmd = new ClaudeMemDatabase(dbPath);
    raw = (cmd as unknown as { db: Database }).db;
    raw.exec(`
      CREATE TABLE IF NOT EXISTS rdml (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT NOT NULL UNIQUE,
        n INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(async () => {
    await cmd.close();
    for (const suffix of ['', '-shm', '-wal', '-journal']) {
      try {
        const path = `${dbPath}${suffix}`;
        // @ts-expect-error — Bun ships fs/promises but the type narrowing
        // here would require an extra import for a single throwaway path.
        require('node:fs').rmSync(path, { force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  it('INSERT ... RETURNING id inserts exactly one row', async () => {
    const result = await cmd.execute({
      sql: 'INSERT INTO rdml (tag, n) VALUES (?, ?) RETURNING id',
      args: ['unique-tag-1', 7],
    });

    // Row count in the table must be exactly 1, NOT 2.
    const countRow = raw.query('SELECT COUNT(*) AS c FROM rdml').get() as { c: number };
    expect(countRow.c).toBe(1);

    // RETURNING rows captured.
    expect(result.rows.length).toBe(1);
    expect(Number((result.rows[0] as { id: bigint | number }).id)).toBe(1);
  });

  it('INSERT ... RETURNING id inside transaction inserts exactly one row', async () => {
    const tx = await cmd.transaction('write');
    try {
      const result = await tx.execute({
        sql: 'INSERT INTO rdml (tag, n) VALUES (?, ?) RETURNING id',
        args: ['unique-tag-tx', 11],
      });
      expect(result.rows.length).toBe(1);
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    const countRow = raw.query('SELECT COUNT(*) AS c FROM rdml').get() as { c: number };
    expect(countRow.c).toBe(1);
  });

  it('UPDATE ... RETURNING id updates exactly once (no double-write)', async () => {
    raw.run("INSERT INTO rdml (tag, n) VALUES ('to-update', 0)");

    const result = await cmd.execute({
      sql: 'UPDATE rdml SET n = n + 1 WHERE tag = ? RETURNING id, n',
      args: ['to-update'],
    });

    expect(result.rows.length).toBe(1);
    // n must be 1 (incremented once), NOT 2 (double-execution).
    const row = result.rows[0] as { id: bigint | number; n: bigint | number };
    expect(Number(row.n)).toBe(1);

    // Confirm the actual stored value.
    const stored = raw.query('SELECT n FROM rdml WHERE tag = ?').get('to-update') as { n: number };
    expect(stored.n).toBe(1);
  });

  it('plain INSERT (no RETURNING) still surfaces lastInsertRowid via .run()', async () => {
    const result = await cmd.execute({
      sql: 'INSERT INTO rdml (tag, n) VALUES (?, ?)',
      args: ['plain-insert', 99],
    });

    expect(result.rows).toEqual([]);
    expect(result.rowsAffected).toBe(1);
    expect(result.lastInsertRowid).toBeDefined();
    expect(Number(result.lastInsertRowid)).toBe(1);

    const countRow = raw.query('SELECT COUNT(*) AS c FROM rdml').get() as { c: number };
    expect(countRow.c).toBe(1);
  });

  it('INSERT ... ON CONFLICT DO NOTHING RETURNING id returns empty rows on conflict', async () => {
    // Prime the table with the conflicting row.
    raw.run("INSERT INTO rdml (tag, n) VALUES ('conflict-tag', 5)");

    const result = await cmd.execute({
      sql: 'INSERT INTO rdml (tag, n) VALUES (?, ?) ON CONFLICT(tag) DO NOTHING RETURNING id',
      args: ['conflict-tag', 6],
    });

    // ON CONFLICT DO NOTHING returns no rows — rows array is empty.
    expect(result.rows).toEqual([]);

    // Table still has exactly 1 row, and n was NOT changed by the failed insert.
    const stored = raw.query('SELECT n FROM rdml WHERE tag = ?').get('conflict-tag') as { n: number };
    expect(stored.n).toBe(5);
  });
});
