/**
 * Database adapter interface
 *
 * All database code programs against this interface.
 * Implementations: LibsqlAdapter (local, remote, replica modes)
 */

/**
 * Result from a SQL execution
 */
export interface ExecResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
  lastInsertRowid: number;
}

/**
 * Thin async adapter that wraps any libSQL-compatible client.
 * All DB code programs against this interface.
 */
export interface DbAdapter {
  /** Single statement execution (DML, DDL, PRAGMAs) */
  execute(sql: string, args?: unknown[]): Promise<ExecResult>;

  /** Multiple statements in a write transaction (replaces db.transaction) */
  batch(stmts: Array<{ sql: string; args?: unknown[] }>): Promise<ExecResult[]>;

  /** Multi-statement DDL string (splits on `;`, for migrations) */
  executeScript(sql: string): Promise<void>;

  /**
   * Run a callback inside a transaction.
   * In local mode: uses BEGIN/COMMIT/ROLLBACK.
   * In remote mode: uses client.transaction() for proper scoping.
   * The callback receives a transaction-scoped adapter — all operations
   * within the callback run on the same transaction without leaking
   * to concurrent requests.
   */
  withTransaction<T>(fn: (txDb: DbAdapter) => Promise<T>): Promise<T>;

  /** Close the connection */
  close(): Promise<void>;
}

// ─── Convenience helpers ──────────────────────────────────────

/**
 * Query a single row, typed as T. Returns null if no match.
 */
export async function queryOne<T>(db: DbAdapter, sql: string, args?: unknown[]): Promise<T | null> {
  const result = await db.execute(sql, args);
  return (result.rows[0] as T | undefined) ?? null;
}

/**
 * Query all rows, typed as T[].
 */
export async function queryAll<T>(db: DbAdapter, sql: string, args?: unknown[]): Promise<T[]> {
  const result = await db.execute(sql, args);
  return result.rows as T[];
}

/**
 * Execute a statement returning the full ExecResult.
 */
export async function exec(db: DbAdapter, sql: string, args?: unknown[]): Promise<ExecResult> {
  return db.execute(sql, args);
}
