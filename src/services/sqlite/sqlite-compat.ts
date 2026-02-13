/**
 * SQLite Compatibility Layer
 *
 * Wraps better-sqlite3 to provide a simplified Database API used throughout the codebase.
 *
 * API:
 *   db.run(sql)    — Execute multi-statement SQL (DDL, PRAGMA) via better-sqlite3 db.exec()
 *   db.query(sql)  — Prepare a statement via better-sqlite3 db.prepare() [returns Statement]
 *   db.prepare(sql) — Same as query(), direct pass-through to better-sqlite3
 *   db.transaction(fn) — Create a transaction function
 *   db.close()     — Close the database connection
 */

import BetterSqlite3 from 'better-sqlite3';

export class Database {
  private _db: BetterSqlite3.Database;

  constructor(path: string, _options?: { create?: boolean; readwrite?: boolean }) {
    // better-sqlite3 creates read-write databases by default.
    this._db = new BetterSqlite3(path);
  }

  /**
   * Execute one or more SQL statements (DDL, PRAGMA, etc.)
   * Delegates to better-sqlite3's db.exec() which handles multi-statement SQL.
   */
  run(sql: string): void {
    this._db.exec(sql);
  }

  /**
   * Prepare a single SQL statement for repeated execution.
   * Returns a Statement object with .run(), .get(), .all() methods.
   */
  query(sql: string): BetterSqlite3.Statement {
    return this._db.prepare(sql);
  }

  /**
   * Prepare a single SQL statement.
   */
  prepare(sql: string): BetterSqlite3.Statement {
    return this._db.prepare(sql);
  }

  /**
   * Create a transaction function.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic constraint must be `any` to match better-sqlite3's Transaction type signature
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return this._db.transaction(fn) as unknown as T;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this._db.close();
  }
}

export default Database;
