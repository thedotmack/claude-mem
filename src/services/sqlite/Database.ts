import { Database } from 'bun:sqlite';
import { createClient, type Client as LibSqlClient, type Transaction as LibSqlTransaction } from '@libsql/client';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';
import type {
  IDatabaseClient,
  DatabaseStatement,
  DatabaseExecuteResult,
  DatabaseTransaction,
  DatabaseTransactionMode,
  DatabaseBindArgs,
} from './database-client.js';

const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024;
const SQLITE_CACHE_SIZE_PAGES = 10_000;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

let dbInstance: Database | null = null;

export type DatabaseBackend = 'bun-sqlite' | 'libsql';

/**
 * Resolve the active backend from `process.env.CLAUDE_MEM_DB_BACKEND`. Reads
 * the env var once per call; consumers should cache the result. Defaults to
 * `bun-sqlite` for backward compatibility during the Phase 1B parallel
 * period — Step 6 deletes this flag and the `bun-sqlite` branch entirely.
 */
export function resolveDatabaseBackend(): DatabaseBackend {
  const raw = process.env.CLAUDE_MEM_DB_BACKEND;
  if (raw === 'libsql') return 'libsql';
  if (raw === undefined || raw === '' || raw === 'bun-sqlite') return 'bun-sqlite';
  throw new Error(
    `Invalid CLAUDE_MEM_DB_BACKEND=${raw}. Expected 'bun-sqlite' or 'libsql'.`,
  );
}

/**
 * Resolve the libSQL primary URL. Honors `TURSO_DATABASE_URL` if set;
 * otherwise falls back to a `file:` URL pointing at the existing local DB
 * file (`~/.claude-mem/claude-mem.db`). The `file:` prefix is required by
 * `@libsql/client` — bare paths are not accepted.
 */
function resolveLibSqlUrl(): string {
  const fromEnv = process.env.TURSO_DATABASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return `file:${DB_PATH}`;
}

/**
 * Bun-sqlite-backed implementation of `IDatabaseClient`. Wraps the existing
 * synchronous `bun:sqlite` API in `Promise.resolve(...)` so consumer files
 * can be migrated to `await client.execute(...)` without forking call sites
 * by backend. The legacy `db` field stays public during Phase 1B so existing
 * sync consumers (tests reaching for `.db`, transaction helpers, etc.) keep
 * working until they're converted in later steps.
 *
 * NOTE: Methods do NOT touch the underlying `bun:sqlite` calls — they're
 * just `Promise.resolve(...)` shims. The libSQL semantics live in
 * `LibSqlDatabase` below.
 */
export class ClaudeMemDatabase implements IDatabaseClient {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    this.db = new Database(dbPath, { create: true, readwrite: true });

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    const migrationRunner = new MigrationRunner(this.db);
    migrationRunner.runAllMigrations();
  }

  async execute(stmt: DatabaseStatement): Promise<DatabaseExecuteResult> {
    const args = stmt.args ?? [];
    const query = this.db.query(stmt.sql);
    // bun:sqlite's `Statement.run(...args)` returns `{ changes, lastInsertRowid }`
    // and also executes the statement. For SELECT-shaped queries we want the
    // rows back, so we always call `.all(...)` which returns the result rows
    // for SELECT and an empty array for non-SELECT. We then issue a separate
    // `.run(...)` call to capture `changes` / `lastInsertRowid` reliably.
    //
    // bun:sqlite quirk: calling `.all()` and `.run()` on the same Statement
    // executes the statement twice. For DML this would double-write. Detect
    // SELECT vs DML by inspecting the SQL prefix; this is a pragmatic shim
    // and acceptable here because Phase 1B Step 1 is short-lived.
    const trimmed = stmt.sql.trimStart();
    const isSelect = /^(select|with|pragma|explain)\b/i.test(trimmed);

    if (isSelect) {
      const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
      // Best-effort column extraction: read keys from the first row. SELECTs
      // returning zero rows lose column names — acceptable for the shim
      // because consumer code path matches `@libsql/client`'s `rows` field
      // and rarely inspects `columns` for SELECTs that returned nothing.
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return Promise.resolve({
        rows,
        columns,
        rowsAffected: 0,
        lastInsertRowid: undefined,
      });
    }

    // DML branch. For DML with `RETURNING`, we MUST use `.all()` (single
    // execution that returns the RETURNING rows). Calling `.run()` followed
    // by a fresh `.all()` would execute the DML twice — a write-amplification
    // bug that corrupts data. For plain DML, `.run()` is correct.
    if (/\breturning\b/i.test(trimmed)) {
      const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return Promise.resolve({
        rows,
        columns,
        // rowsAffected approximated as rows.length — for INSERT/UPDATE/DELETE
        // RETURNING this matches the standard SQL contract. Callers that need
        // lastInsertRowid for RETURNING DML should read it from rows[0].id
        // per PHASE_1_HANDOFF.md §4 conversion patterns.
        rowsAffected: rows.length,
        lastInsertRowid: undefined,
      });
    }

    const runResult = query.run(...(args as Parameters<typeof query.run>));
    return Promise.resolve({
      rows: [],
      columns: [],
      rowsAffected: Number(runResult.changes),
      lastInsertRowid:
        runResult.lastInsertRowid !== undefined && runResult.lastInsertRowid !== null
          ? BigInt(runResult.lastInsertRowid as number | bigint)
          : undefined,
    });
  }

  async executeMultiple(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  async transaction(_mode: DatabaseTransactionMode = 'write'): Promise<DatabaseTransaction> {
    // bun:sqlite doesn't expose BEGIN/COMMIT directly via a transaction
    // handle the way `@libsql/client` does, but we can mimic it with raw
    // `BEGIN` / `COMMIT` / `ROLLBACK` statements. Mode is currently ignored
    // on the bun:sqlite shim — bun:sqlite uses SQLite's deferred mode by
    // default, which is the same as `@libsql/client`'s `"deferred"`. The
    // libSQL backend honors mode.
    this.db.run('BEGIN');
    let settled = false;
    const db = this.db;
    return Promise.resolve({
      execute: async (stmt) => {
        const args = stmt.args ?? [];
        const trimmed = stmt.sql.trimStart();
        const isSelect = /^(select|with|pragma|explain)\b/i.test(trimmed);
        const query = db.query(stmt.sql);

        if (isSelect) {
          const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          return {
            rows,
            columns,
            rowsAffected: 0,
            lastInsertRowid: undefined,
          };
        }

        // DML branch. For RETURNING DML, single `.all()` call executes the
        // DML once AND returns the rows. `.run()` + `.all()` re-execution
        // would double-write — a critical bug.
        if (/\breturning\b/i.test(trimmed)) {
          const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          return {
            rows,
            columns,
            rowsAffected: rows.length,
            lastInsertRowid: undefined,
          };
        }

        const runResult = query.run(...(args as Parameters<typeof query.run>));
        return {
          rows: [],
          columns: [],
          rowsAffected: Number(runResult.changes),
          lastInsertRowid:
            runResult.lastInsertRowid !== undefined && runResult.lastInsertRowid !== null
              ? BigInt(runResult.lastInsertRowid as number | bigint)
              : undefined,
        };
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        db.run('COMMIT');
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        db.run('ROLLBACK');
      },
    });
  }

  async close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/**
 * `@libsql/client`-backed implementation of `IDatabaseClient`. Used when
 * `CLAUDE_MEM_DB_BACKEND=libsql`. Defaults to a local file (`file:` URL of
 * `DB_PATH`); honors `TURSO_DATABASE_URL` for remote/embedded-replica
 * connections and `TURSO_AUTH_TOKEN` for signed-JWT auth.
 *
 * Migration: this constructor does NOT run migrations. Phase 1B Step 3 will
 * port `MigrationRunner` to async; until then, instantiating this class
 * against a fresh empty libSQL DB will leave it schemaless. Step 1's smoke
 * test creates its own throwaway tables to exercise the wrapper without
 * depending on the migration runner.
 */
export class LibSqlDatabase implements IDatabaseClient {
  public client: LibSqlClient;

  constructor(opts?: { url?: string; authToken?: string }) {
    const url = opts?.url ?? resolveLibSqlUrl();
    const authToken = opts?.authToken ?? process.env.TURSO_AUTH_TOKEN ?? undefined;
    this.client = createClient(authToken ? { url, authToken } : { url });
  }

  async execute(stmt: DatabaseStatement): Promise<DatabaseExecuteResult> {
    const args = stmt.args ?? [];
    // `@libsql/client` accepts the same bind shape we expose — pass through.
    // Cite: https://github.com/tursodatabase/libsql-client-ts#client.execute
    const result = await this.client.execute({ sql: stmt.sql, args });
    return {
      // libSQL rows are array-like objects with column names too; spread to
      // plain `Record<string, unknown>` so the surface matches the shim.
      rows: result.rows.map((row) => ({ ...row })) as Array<Record<string, unknown>>,
      columns: [...result.columns],
      rowsAffected: result.rowsAffected,
      // `lastInsertRowid` is BigInt | undefined per the SDK types. Pass
      // through as-is; consumers must `Number(...)`-cast at every use site
      // per gotcha #4 in PHASE_1_HANDOFF.md §5.
      lastInsertRowid: result.lastInsertRowid ?? undefined,
    };
  }

  async executeMultiple(sql: string): Promise<void> {
    // `executeMultiple` accepts a single string with `;`-separated DDL.
    // Right primitive for migrations / CREATE TABLE blocks.
    await this.client.executeMultiple(sql);
  }

  async transaction(mode: DatabaseTransactionMode = 'write'): Promise<DatabaseTransaction> {
    const tx: LibSqlTransaction = await this.client.transaction(mode);
    let settled = false;
    return {
      execute: async (stmt) => {
        const args = stmt.args ?? [];
        const result = await tx.execute({ sql: stmt.sql, args });
        return {
          rows: result.rows.map((row) => ({ ...row })) as Array<Record<string, unknown>>,
          columns: [...result.columns],
          rowsAffected: result.rowsAffected,
          lastInsertRowid: result.lastInsertRowid ?? undefined,
        };
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        await tx.commit();
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        await tx.rollback();
      },
    };
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private libSqlClient: IDatabaseClient | null = null;
  private backend: DatabaseBackend | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Initialize the active backend. Reads `CLAUDE_MEM_DB_BACKEND` exactly
   * once per process; subsequent flag changes are ignored. Returns the
   * underlying `bun:sqlite` `Database` for backward compatibility — the
   * `bun-sqlite` branch behaves as it always has. The `libsql` branch
   * still returns a `Database` *for type compatibility* but it's a
   * placeholder; libSQL consumers must use `getClient()` instead and
   * existing sync consumers will fail loudly if they attempt to run
   * SQL against the bun:sqlite handle in libSQL mode.
   *
   * Step 4+ migrate the consumers that currently use `getConnection()` to
   * use `getClient()`; Step 6 removes the bun:sqlite path entirely.
   */
  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    this.backend = resolveDatabaseBackend();
    logger.info('DB', `Initializing database backend: ${this.backend}`);

    if (this.backend === 'libsql') {
      // Phase 1B Step 1 only stands up the libSQL client; migrations,
      // schema-version tracking, and consumer call sites still target the
      // bun:sqlite path. Steps 3-5 cut consumers over.
      this.libSqlClient = new LibSqlDatabase();

      // We also stand up an in-memory bun:sqlite handle so legacy callers of
      // `getConnection()` don't NPE. Real conversion in later steps. This
      // handle is NOT used for application data when `backend === 'libsql'`.
      ensureDir(DATA_DIR);
      this.db = new Database(':memory:', { create: true, readwrite: true });
      dbInstance = this.db;
      return this.db;
    }

    // bun-sqlite path — unchanged from before Phase 1B.
    ensureDir(DATA_DIR);

    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    this.initializeSchemaVersions();

    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Return the active async client. Available on both backends:
   * - On `bun-sqlite`, returns a `ClaudeMemDatabase`-style wrapper around the
   *   existing `bun:sqlite` handle so consumers can migrate to `await
   *   client.execute(...)` without an env-flag check.
   * - On `libsql`, returns the `LibSqlDatabase` instance built in
   *   `initialize()`.
   *
   * NOTE: This is the API consumers should target during Phase 1B
   * Steps 2-5. `getConnection()` will be removed in Step 6.
   */
  getClient(): IDatabaseClient {
    if (this.backend === null) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    if (this.backend === 'libsql') {
      if (!this.libSqlClient) {
        throw new Error('libSQL client not initialized.');
      }
      return this.libSqlClient;
    }
    if (!this.db) {
      throw new Error('bun:sqlite database not initialized.');
    }
    // Adapt the existing bun:sqlite handle to the IDatabaseClient surface.
    // We construct a thin wrapper that reuses the already-open handle —
    // we do NOT instantiate a new ClaudeMemDatabase here (that would re-run
    // migrations against the same file).
    return new BunSqliteHandleWrapper(this.db);
  }

  getBackend(): DatabaseBackend {
    if (this.backend === null) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.backend;
  }

  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  close(): void {
    if (this.libSqlClient) {
      // Fire-and-forget close; libSQL's `client.close()` is sync under the
      // hood (sets a closed flag and tears down sockets).
      void this.libSqlClient.close();
      this.libSqlClient = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
    this.backend = null;
  }

  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

/**
 * Adapt an already-open `bun:sqlite` `Database` handle to the
 * `IDatabaseClient` surface. Used by `DatabaseManager.getClient()` on the
 * `bun-sqlite` branch so callers can opt into the async surface without
 * re-running migrations.
 *
 * Mirrors the wrapping in `ClaudeMemDatabase`'s `execute` / `transaction`
 * methods — the SQL classification heuristic and BigInt cast for
 * `lastInsertRowid` are identical. Step 6 deletes this class.
 */
class BunSqliteHandleWrapper implements IDatabaseClient {
  constructor(private readonly db: Database) {}

  async execute(stmt: DatabaseStatement): Promise<DatabaseExecuteResult> {
    const args: DatabaseBindArgs = stmt.args ?? [];
    const trimmed = stmt.sql.trimStart();
    const isSelect = /^(select|with|pragma|explain)\b/i.test(trimmed);
    const query = this.db.query(stmt.sql);

    if (isSelect) {
      const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        rows,
        columns,
        rowsAffected: 0,
        lastInsertRowid: undefined,
      };
    }

    // DML branch. RETURNING DML uses `.all()` (single execution).
    // `.run()` + `.all()` would double-write.
    if (/\breturning\b/i.test(trimmed)) {
      const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        rows,
        columns,
        rowsAffected: rows.length,
        lastInsertRowid: undefined,
      };
    }

    const runResult = query.run(...(args as Parameters<typeof query.run>));
    return {
      rows: [],
      columns: [],
      rowsAffected: Number(runResult.changes),
      lastInsertRowid:
        runResult.lastInsertRowid !== undefined && runResult.lastInsertRowid !== null
          ? BigInt(runResult.lastInsertRowid as number | bigint)
          : undefined,
    };
  }

  async executeMultiple(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction(_mode: DatabaseTransactionMode = 'write'): Promise<DatabaseTransaction> {
    this.db.run('BEGIN');
    let settled = false;
    const db = this.db;
    return {
      execute: async (stmt) => {
        const args = stmt.args ?? [];
        const trimmed = stmt.sql.trimStart();
        const isSelect = /^(select|with|pragma|explain)\b/i.test(trimmed);
        const query = db.query(stmt.sql);

        if (isSelect) {
          const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          return {
            rows,
            columns,
            rowsAffected: 0,
            lastInsertRowid: undefined,
          };
        }

        // DML branch. RETURNING DML uses `.all()` (single execution).
        if (/\breturning\b/i.test(trimmed)) {
          const rows = query.all(...(args as Parameters<typeof query.all>)) as Array<Record<string, unknown>>;
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          return {
            rows,
            columns,
            rowsAffected: rows.length,
            lastInsertRowid: undefined,
          };
        }

        const runResult = query.run(...(args as Parameters<typeof query.run>));
        return {
          rows: [],
          columns: [],
          rowsAffected: Number(runResult.changes),
          lastInsertRowid:
            runResult.lastInsertRowid !== undefined && runResult.lastInsertRowid !== null
              ? BigInt(runResult.lastInsertRowid as number | bigint)
              : undefined,
        };
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        db.run('COMMIT');
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        db.run('ROLLBACK');
      },
    };
  }

  // No-op on the wrapper — the underlying handle is owned by DatabaseManager.
  // Closing it here would tear down the singleton.
  async close(): Promise<void> {
    /* intentionally empty */
  }
}

export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

export { Database };

export { MigrationRunner } from './migrations/runner.js';

export type {
  IDatabaseClient,
  DatabaseStatement,
  DatabaseExecuteResult,
  DatabaseTransaction,
  DatabaseTransactionMode,
  DatabaseBindArgs,
  DatabaseBindValue,
} from './database-client.js';

export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';
