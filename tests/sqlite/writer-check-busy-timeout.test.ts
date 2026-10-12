// The writer-stamp check is the first statement on a fresh connection, ahead
// of the pragmas that set busy_timeout. Opened while another process held the
// database lock (two openers at once), it failed in ~1 ms with "database is
// locked" instead of waiting, which fails worker boot. The check now waits on
// the same busy timeout as every other statement.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { LATEST_SCHEMA_VERSION, openGuardedSqliteDatabase } from '../../src/services/sqlite/connection.js';

// Long enough that the guarded open below starts while the lock is still held
// even on a loaded runner, and well inside the 5 s busy timeout.
const HOLD_MS = 1500;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Holds an EXCLUSIVE lock on a rollback-journal database from another process for HOLD_MS. */
async function holdExclusiveLock(dbPath: string): Promise<Bun.Subprocess> {
  const holder = Bun.spawn([
    process.execPath,
    '-e',
    `const { Database } = require('bun:sqlite');
     const db = new Database(${JSON.stringify(dbPath)});
     db.run('BEGIN EXCLUSIVE');
     db.run('PRAGMA user_version = ${LATEST_SCHEMA_VERSION}');
     console.log('LOCKED');
     setTimeout(() => { db.run('COMMIT'); db.close(); }, ${HOLD_MS});`,
  ], { stdout: 'pipe' });
  const reader = holder.stdout.getReader();
  let output = '';
  while (!output.includes('LOCKED')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('lock holder exited before locking');
    output += new TextDecoder().decode(value);
  }
  return holder;
}

describe('writer-stamp check waits for a concurrent opener', () => {
  it('waits out a held lock instead of failing with "database is locked"', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmem-busy-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'claude-mem.db');
    const seed = new Database(dbPath);
    seed.run('PRAGMA journal_mode = DELETE');
    seed.run('CREATE TABLE seed (x)');
    seed.close();

    const holder = await holdExclusiveLock(dbPath);
    // The regression was a throw ("database is locked") about 1 ms into the
    // open; asserting the open succeeds avoids depending on runner timing.
    let opened: Database | null = null;
    expect(() => { opened = openGuardedSqliteDatabase(dbPath); }).not.toThrow();
    opened!.close();
    await holder.exited;
  });
});
