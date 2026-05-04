/**
 * Phase 1B Step 1 smoke test for `LibSqlDatabase`.
 *
 * Runs against a per-suite throwaway file under the project's `.scratch/`
 * directory. We intentionally avoid `file::memory:` for this smoke test:
 * `@libsql/client`'s SQLite-3 backend reopens the in-memory DB on every
 * connection (no shared-cache URI parsing path through the napi-rs
 * binding), so anything written via `executeMultiple` is invisible to a
 * subsequent `execute` or `transaction` call. A real file path is the
 * minimum viable shape for this wrapper test. Production tests against
 * sqld go through the docker harness in
 * `containers/sync-host/dev-sqld/docker-compose.yml`.
 *
 * The bare `:memory:` shorthand is bun:sqlite-only; libSQL requires the
 * `file:` prefix when an in-memory DB IS used elsewhere. See
 * `.scratch/PHASE_1_HANDOFF.md` §4 (last row of the conversion-pattern
 * table).
 *
 * Skipped unless `CLAUDE_MEM_DB_BACKEND=libsql` is set, so the default
 * `bun test` run on the bun-sqlite branch doesn't pull in the libsql
 * native dep at startup. Run explicitly with:
 *
 *   CLAUDE_MEM_DB_BACKEND=libsql bun test src/services/sqlite/Database.libsql-smoke.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LibSqlDatabase } from './Database.js';

const shouldRun = process.env.CLAUDE_MEM_DB_BACKEND === 'libsql';
const describeOrSkip = shouldRun ? describe : describe.skip;

describeOrSkip('LibSqlDatabase smoke (local file)', () => {
  let client: LibSqlDatabase;
  // Project-local scratch dir, never /tmp — see CLAUDE.md "File Locations".
  const scratchDir = join(process.cwd(), '.scratch', 'libsql-smoke');
  const dbPath = join(scratchDir, `smoke-${process.pid}-${Date.now()}.db`);

  beforeAll(() => {
    mkdirSync(scratchDir, { recursive: true });
    client = new LibSqlDatabase({ url: `file:${dbPath}` });
  });

  afterAll(async () => {
    await client.close();
    // Best-effort cleanup of the throwaway DB and its sidecar files
    // (libSQL may write `<path>-info`, `<path>-wal`, etc. — see
    // PHASE_1_HANDOFF.md §5 gotcha #6).
    for (const suffix of ['', '-info', '-wal', '-shm', '-client_wal_index']) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) {
        try {
          rmSync(p, { force: true });
        } catch {
          // Ignore cleanup errors — test isolation handles repeats.
        }
      }
    }
  });

  it('creates a table, inserts a row, reads it back', async () => {
    await client.executeMultiple(`
      CREATE TABLE smoke (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg TEXT NOT NULL,
        n INTEGER NOT NULL
      );
    `);

    const insertResult = await client.execute({
      sql: 'INSERT INTO smoke (msg, n) VALUES (?, ?)',
      args: ['hello-libsql', 42],
    });

    expect(insertResult.rowsAffected).toBe(1);
    expect(insertResult.lastInsertRowid).toBeDefined();
    // BigInt cast verified per gotcha #4 in PHASE_1_HANDOFF.md §5.
    expect(Number(insertResult.lastInsertRowid)).toBe(1);

    const selectResult = await client.execute({
      sql: 'SELECT id, msg, n FROM smoke WHERE msg = ?',
      args: ['hello-libsql'],
    });

    expect(selectResult.rows.length).toBe(1);
    const row = selectResult.rows[0];
    expect(Number(row.id)).toBe(1);
    expect(row.msg).toBe('hello-libsql');
    expect(Number(row.n)).toBe(42);
  });

  it('returns an empty rows array when no row matches', async () => {
    const result = await client.execute({
      sql: 'SELECT id, msg FROM smoke WHERE msg = ?',
      args: ['nope'],
    });

    expect(result.rows).toEqual([]);
    expect(result.rows[0]).toBeUndefined();
  });

  it('rolls back a transaction without committing', async () => {
    await client.executeMultiple(`
      CREATE TABLE tx_smoke (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg TEXT NOT NULL
      );
    `);

    const tx = await client.transaction('write');
    try {
      await tx.execute({
        sql: 'INSERT INTO tx_smoke (msg) VALUES (?)',
        args: ['should-roll-back'],
      });
      await tx.rollback();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    const after = await client.execute({
      sql: 'SELECT COUNT(*) AS c FROM tx_smoke',
    });
    expect(Number(after.rows[0].c)).toBe(0);
  });

  it('commits a transaction and persists rows', async () => {
    const tx = await client.transaction('write');
    try {
      await tx.execute({
        sql: 'INSERT INTO tx_smoke (msg) VALUES (?)',
        args: ['committed'],
      });
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    const after = await client.execute({
      sql: 'SELECT msg FROM tx_smoke WHERE msg = ?',
      args: ['committed'],
    });
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].msg).toBe('committed');
  });
});
