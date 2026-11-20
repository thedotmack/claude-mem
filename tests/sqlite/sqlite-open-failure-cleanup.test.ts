import { describe, expect, it, spyOn } from 'bun:test';
import { Database, type Statement } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, openConfiguredSqliteDatabase, openGuardedSqliteDatabase,
  SchemaNewerThanBinaryError } from '../../src/services/sqlite/connection.js';

function fixture(run: (dbPath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-open-cleanup-'));
  const dbPath = join(dir, 'database.db');
  const seed = new Database(dbPath);
  seed.run('CREATE TABLE original (value TEXT)');
  seed.close();
  try { run(dbPath); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Observe real handles and statements without changing any SQLite result. */
function observeHandles(dbPath: string) {
  const handles = new Set<Database>();
  const statements: Statement[] = [];
  const run = Database.prototype.run;
  const prepare = Database.prototype.prepare;
  const runSpy = spyOn(Database.prototype, 'run').mockImplementation(function (this: Database, ...args: any[]) {
    if (this.filename === dbPath) handles.add(this);
    return (run as Function).apply(this, args);
  } as any);
  const prepareSpy = spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, ...args: any[]) {
    const statement = (prepare as Function).apply(this, args);
    if (this.filename === dbPath) { handles.add(this); statements.push(statement); }
    return statement;
  } as any);
  return { handles, statements, cleanup() {
    prepareSpy.mockRestore(); runSpy.mockRestore();
    for (const handle of handles) { try { handle.close(true); } catch {} }
  } };
}

describe('owned SQLite connection initialization', () => {
  it('closes a read-only handle when enabling WAL fails', () => fixture(dbPath => {
    const observed = observeHandles(dbPath);
    try {
      expect(() => openConfiguredSqliteDatabase(dbPath, { readonly: true })).toThrow(/readonly|read-only/i);
      expect(observed.handles.size).toBe(1);
      const [handle] = observed.handles;
      expect(() => handle.prepare('SELECT 1').get()).toThrow();
    } finally { observed.cleanup(); }
    const probe = new Database(dbPath);
    try { expect(probe.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' }); }
    finally { probe.close(); }
  }));

  it('releases the refused newer-schema handle and every statement created during its guard', () => fixture(dbPath => {
    const newer = new Database(dbPath);
    newer.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    newer.close();
    const observed = observeHandles(dbPath);
    try {
      let failure: unknown;
      try { openGuardedSqliteDatabase(dbPath); } catch (error) { failure = error; }
      expect(failure instanceof SchemaNewerThanBinaryError).toBe(true);
      expect(observed.handles.size).toBe(1);
      expect(observed.statements.length).toBeGreaterThan(0);
      for (const statement of observed.statements) expect(() => statement.get()).toThrow();
      const [handle] = observed.handles;
      expect(() => handle.prepare('SELECT 1')).toThrow();
    } finally { observed.cleanup(); }
  }));

  it('keeps the initialization failure when closing also throws', () => fixture(dbPath => {
    const newer = new Database(dbPath);
    newer.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    newer.close();
    const observed = observeHandles(dbPath);
    const close = Database.prototype.close;
    let closes = 0;
    const closeSpy = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, strict?: boolean) {
      close.call(this, strict);
      closes++;
      throw new Error('secondary cleanup failure');
    });
    try {
      let failure: unknown;
      try { openGuardedSqliteDatabase(dbPath); } catch (error) { failure = error; }
      expect(closes).toBe(1);
      expect(failure instanceof SchemaNewerThanBinaryError).toBe(true);
    } finally { closeSpy.mockRestore(); observed.cleanup(); }
  }));

  it('finalizes each owned statement before attempting strict close', () => fixture(dbPath => {
    // Bun versions predating automatic statement finalization in close(true)
    // reject strict close with SQLITE_BUSY if even one prepared query remains.
    // Observe the statements before invoking close, independently of the
    // installed runtime's automatic cleanup behavior.
    for (const newerSchema of [false, true]) {
      const seed = new Database(dbPath);
      seed.run(`PRAGMA user_version = ${newerSchema ? LATEST_SCHEMA_VERSION + 1 : 0}`);
      seed.close();
      const observed = observeHandles(dbPath);
      const close = Database.prototype.close;
      let closes = 0;
      let liveStatementsAtClose = 0;
      const closeSpy = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, strict?: boolean) {
        closes++;
        for (const statement of observed.statements) {
          try { statement.get(); liveStatementsAtClose++; } catch {}
        }
        return close.call(this, strict);
      });
      try {
        expect(() => newerSchema
          ? openGuardedSqliteDatabase(dbPath)
          : openConfiguredSqliteDatabase(dbPath, { readonly: true })).toThrow();
        expect(observed.statements.length).toBeGreaterThan(0);
        expect(closes).toBe(1);
        expect(liveStatementsAtClose).toBe(0);
      } finally { closeSpy.mockRestore(); observed.cleanup(); }
    }
  }));

  it('returns a live configured connection on success for its caller to own', () => fixture(dbPath => {
    for (const open of [openConfiguredSqliteDatabase, openGuardedSqliteDatabase]) {
      const db = open(dbPath);
      try {
        db.run("INSERT INTO original VALUES ('retained')");
        expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      } finally { db.close(); }
    }
  }));
});
