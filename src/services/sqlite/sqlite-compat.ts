/**
 * SQLite Compatibility Layer
 *
 * Provides bun:sqlite-compatible API using better-sqlite3 for Node.js compatibility.
 * This allows the same code to run on both Bun and Node.js.
 */

import BetterSqlite3, { Database as BetterDatabase, Statement as BetterStatement } from 'better-sqlite3';

/**
 * Statement wrapper that provides bun:sqlite-compatible API
 */
class StatementWrapper {
  private stmt: BetterStatement;

  constructor(stmt: BetterStatement) {
    this.stmt = stmt;
  }

  all(...params: any[]): any[] {
    return this.stmt.all(...params);
  }

  get(...params: any[]): any {
    return this.stmt.get(...params);
  }

  run(...params: any[]): any {
    return this.stmt.run(...params);
  }

  values(...params: any[]): any[] {
    // better-sqlite3 doesn't have values(), simulate with all()
    return this.stmt.all(...params).map((row: any) => Object.values(row));
  }
}

/**
 * Database wrapper that provides bun:sqlite-compatible API
 */
export class Database {
  private db: BetterDatabase;

  constructor(filename: string, options?: { create?: boolean; readwrite?: boolean; readonly?: boolean }) {
    // better-sqlite3 creates by default, uses different option names
    const opts: BetterSqlite3.Options = {};
    if (options?.readonly) {
      opts.readonly = true;
    }
    // better-sqlite3 creates the file by default if it doesn't exist
    this.db = new BetterSqlite3(filename, opts);
  }

  /**
   * Execute SQL statement(s) - compatible with bun:sqlite db.run()
   */
  run(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Prepare a statement - compatible with bun:sqlite db.query()
   */
  query(sql: string): StatementWrapper {
    return new StatementWrapper(this.db.prepare(sql));
  }

  /**
   * Prepare a statement - better-sqlite3 native API
   */
  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.db.prepare(sql));
  }

  /**
   * Execute SQL - better-sqlite3 native API
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Create a transaction - compatible with bun:sqlite
   */
  transaction<T>(fn: (db: Database) => T): () => T {
    const wrappedFn = this.db.transaction(() => fn(this));
    return wrappedFn;
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }

  /**
   * Check if database is open
   */
  get open(): boolean {
    return this.db.open;
  }

  /**
   * Get the underlying better-sqlite3 database (for advanced usage)
   */
  get raw(): BetterDatabase {
    return this.db;
  }
}

export default Database;
