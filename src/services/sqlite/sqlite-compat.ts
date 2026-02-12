/**
 * SQLite Compatibility Layer
 *
 * Wraps better-sqlite3 to provide a bun:sqlite-compatible API.
 * This allows the codebase to work with Node.js instead of requiring Bun runtime.
 *
 * API mapping:
 *   bun:sqlite db.run(sql)       → better-sqlite3 db.exec(sql)       [multi-statement DDL]
 *   bun:sqlite db.query(sql)     → better-sqlite3 db.prepare(sql)    [returns Statement]
 *   bun:sqlite new Database(path, {create, readwrite}) → better-sqlite3 new Database(path)
 *
 * APIs that are identical (no wrapping needed):
 *   db.prepare(sql).run/get/all(), db.transaction(), db.close(),
 *   stmt.run() returns { changes, lastInsertRowid }
 */

import BetterSqlite3 from 'better-sqlite3';

export class Database {
  private _db: BetterSqlite3.Database;

  constructor(path: string, _options?: { create?: boolean; readwrite?: boolean }) {
    // better-sqlite3 creates read-write databases by default.
    // The `create` and `readwrite` options from bun:sqlite map to defaults.
    this._db = new BetterSqlite3(path);
  }

  /**
   * Execute one or more SQL statements (DDL, PRAGMA, etc.)
   * Maps bun:sqlite db.run(sql) which accepts multi-statement strings.
   * better-sqlite3's db.exec() handles multi-statement SQL.
   */
  run(sql: string): void {
    this._db.exec(sql);
  }

  /**
   * Prepare a single SQL statement for repeated execution.
   * Maps bun:sqlite db.query(sql) which returns a Statement object.
   * In bun:sqlite, query() and prepare() both return Statement objects
   * with identical APIs (.run(), .get(), .all()).
   */
  query(sql: string): BetterSqlite3.Statement {
    return this._db.prepare(sql);
  }

  /**
   * Prepare a single SQL statement.
   * Identical API between bun:sqlite and better-sqlite3.
   */
  prepare(sql: string): BetterSqlite3.Statement {
    return this._db.prepare(sql);
  }

  /**
   * Create a transaction function.
   * Identical API between bun:sqlite and better-sqlite3.
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
