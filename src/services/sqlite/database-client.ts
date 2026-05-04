/**
 * Shared async database client interface for the Phase 1B libSQL migration.
 *
 * Both the existing `bun:sqlite`-backed `ClaudeMemDatabase` (sync wrapped in
 * Promises) and the new `@libsql/client`-backed `LibSqlDatabase` implement
 * this interface so consumer files can be migrated from sync `db.prepare(...)`
 * call sites to `await client.execute(...)` one file at a time without
 * forking the call sites by backend.
 *
 * Surface mirrors `@libsql/client` (the eventual single backend after Step 6),
 * not `bun:sqlite`. Bind parameters use plain TS types — never re-export
 * `bun:sqlite`'s `SQLQueryBindings`.
 *
 * See `.scratch/PHASE_1_HANDOFF.md` §2 Step 1 for the wider plan and §4 for
 * the bun:sqlite → libSQL conversion patterns.
 */

/**
 * Bind parameter types accepted by `execute`. Plain TS — no `bun:sqlite`
 * imports leak. `@libsql/client` accepts `null | string | number | bigint |
 * Uint8Array | ArrayBuffer | boolean`. We accept the strict subset that's
 * unambiguous on both backends; numbers stay number, BigInts stay BigInt,
 * and BLOBs are passed as `Uint8Array`.
 */
export type DatabaseBindValue = string | number | bigint | Uint8Array | null;
export type DatabaseBindArgs = Array<DatabaseBindValue>;

/**
 * Shape of `(await db.execute(...))` — modeled on `@libsql/client`'s
 * `ResultSet`. The `bun:sqlite` shim must produce the same shape.
 *
 * - `rows`: array of plain objects keyed by column name. Empty array if no
 *   rows matched (NOT undefined).
 * - `columns`: column names in declaration order.
 * - `rowsAffected`: number of rows changed by the statement (replaces
 *   `bun:sqlite`'s `result.changes`).
 * - `lastInsertRowid`: rowid of the last INSERT, or undefined if not
 *   applicable. `@libsql/client` returns BigInt; the bun:sqlite shim returns
 *   BigInt too for consistency. Cast with `Number(...)` at every use site.
 */
export interface DatabaseExecuteResult {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

/**
 * Statement passed to `execute` / `tx.execute`. Mirrors `@libsql/client`'s
 * `InStatement`. `args` is optional for parameterless DDL.
 */
export interface DatabaseStatement {
  sql: string;
  args?: DatabaseBindArgs;
}

/**
 * Transaction modes accepted by `transaction()`. Mirrors `@libsql/client`'s
 * `TransactionMode` — `"write"` is the right default for claude-mem (every
 * existing `db.transaction(fn)` performs writes). `"read"` is reserved for
 * future read-only optimization, `"deferred"` matches SQLite's default.
 */
export type DatabaseTransactionMode = 'write' | 'read' | 'deferred';

/**
 * Active transaction handle. Mirrors `@libsql/client`'s `Transaction`. Every
 * method is async even on the `bun:sqlite` shim so consumer code looks the
 * same on both backends.
 */
export interface DatabaseTransaction {
  execute(stmt: DatabaseStatement): Promise<DatabaseExecuteResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Async database client. Both `ClaudeMemDatabase` and `LibSqlDatabase` expose
 * exactly this surface. Step 6 of Phase 1B deletes `ClaudeMemDatabase` and
 * leaves `LibSqlDatabase` as the only implementation.
 */
export interface IDatabaseClient {
  /**
   * Execute a single statement. Replaces every
   * `db.prepare(sql).run/get/all(args)` call site:
   * - `.run(...)`  → check `result.rowsAffected`
   * - `.get(...)`  → `result.rows[0]` (undefined if no row)
   * - `.all(...)`  → `result.rows`
   */
  execute(stmt: DatabaseStatement): Promise<DatabaseExecuteResult>;

  /**
   * Execute a multi-statement SQL script (e.g. migrations). Replaces every
   * `db.exec(multiStatementSql)` call site. Single statements should use
   * `execute` instead.
   */
  executeMultiple(sql: string): Promise<void>;

  /**
   * Open a transaction. Replaces `db.transaction(fn)`. Caller must `commit()`
   * or `rollback()` explicitly:
   *
   *   const tx = await client.transaction("write");
   *   try {
   *     await tx.execute({ sql, args });
   *     await tx.commit();
   *   } catch (err) {
   *     await tx.rollback();
   *     throw err;
   *   }
   */
  transaction(mode?: DatabaseTransactionMode): Promise<DatabaseTransaction>;

  /** Close the underlying connection / pool. Idempotent. */
  close(): Promise<void>;
}
