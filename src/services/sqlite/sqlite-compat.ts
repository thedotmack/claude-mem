/**
 * SQLite compatibility shim: better-sqlite3 with bun:sqlite API surface
 *
 * bun:sqlite provides two methods that better-sqlite3 doesn't:
 *   - db.run(sql)   — execute multi-statement DDL (maps to db.exec())
 *   - db.query(sql)  — alias for db.prepare()
 *
 * Constructor option mapping:
 *   bun:sqlite { create, readwrite, readonly } → better-sqlite3 { readonly, fileMustExist }
 */
import BetterSqlite3 from 'better-sqlite3';

export class Database extends BetterSqlite3 {
  constructor(path: string, options?: { create?: boolean; readwrite?: boolean; readonly?: boolean }) {
    const opts: BetterSqlite3.Options = {};
    if (options?.readonly) opts.readonly = true;
    if (options?.create === false) opts.fileMustExist = true;
    super(path, opts);
  }

  /** bun:sqlite compat: db.run(sql) executes bare SQL (DDL, PRAGMA, etc.) */
  run(sql: string): this {
    this.exec(sql);
    return this;
  }

  /** bun:sqlite compat: db.query(sql) is an alias for db.prepare(sql) */
  query<T = unknown>(sql: string): BetterSqlite3.Statement<T> {
    return this.prepare(sql) as BetterSqlite3.Statement<T>;
  }
}

export default Database;
