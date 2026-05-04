#!/usr/bin/env bun
/**
 * Phase 1A bootstrap — copy bun:sqlite production DB into a libSQL primary.
 *
 * Purpose:
 *   One-time idempotent migration of every row in ~/.claude-mem/claude-mem.db
 *   (bun:sqlite, the live worker DB) into a self-hosted sqld primary so that a
 *   freshly-deployed embedded replica on another machine can `db.sync()` and
 *   pick up the existing 77k+ observations.
 *
 *   This script implements §5 task 6 of `.scratch/sync-container-plan.md`.
 *   Spike report (read first): `.scratch/spike-libsql-sdk.md`.
 *
 * When to run:
 *   At the kickoff of Phase 2 deployment, after the Railway `libsql` service is
 *   up and reachable but before the first embedded-replica client is started on
 *   any device. Re-running is safe (idempotent — see below).
 *
 * Idempotency:
 *   Uses INSERT OR IGNORE on every row. If a table has a UNIQUE constraint
 *   (PRIMARY KEY counts), duplicate rows from a re-run are silently dropped on
 *   the target. Tables WITHOUT a UNIQUE constraint will accumulate duplicates
 *   on re-run — that limitation is documented per-table at runtime via a WARN
 *   log line. Caller must be aware before re-running.
 *
 * Wire model (informational — embedded replica sidecars are NOT this script's
 * problem, but documenting because the spike surfaced them):
 *   `@libsql/client` embedded replicas write `<path>`, `<path>-info`,
 *   `<path>-wal`, `<path>-shm`, `<path>-client_wal_index` next to the main file.
 *   This script connects to the *remote primary* directly (no `syncUrl` / no
 *   local file URL), so no sidecars are written by us. The script's only
 *   sidecar concern is the *source* DB: bun:sqlite WAL/SHM live alongside
 *   `claude-mem.db` and we read the source readonly so we don't churn them.
 *
 * libSQL SDK reference:
 *   https://github.com/tursodatabase/libsql-client-ts
 *   https://docs.turso.tech/sdk/ts/quickstart
 *   The SDK exposes `await db.execute({sql, args})` (single statement) and
 *   `await db.batch(stmts, "write")` (multiple statements). There is NO
 *   `.prepare()` API — one `execute()` covers run/get/all from better-sqlite3.
 *   `lastInsertRowid` is BigInt; never compare with `===` to a Number.
 *
 * CLI:
 *   bun scripts/migrate-bun-sqlite-to-libsql.ts \
 *     --source ~/.claude-mem/claude-mem.db \
 *     --target-url http://localhost:8080 \
 *     --target-token "$TURSO_AUTH_TOKEN" \
 *     [--dry-run] [--batch-size 500] [--tables observations,session_summaries] \
 *     [--force]
 *
 * Exit codes:
 *   0  Done, source/target row counts match (or --dry-run completed).
 *   1  Operational error (bad CLI args, source unreadable, connection refused,
 *      mid-batch failure, post-migration row-count mismatch).
 *   2  WAL safety rail tripped — refuse to run while a worker may be writing.
 *      Pass --force to override.
 */

import { Database as BunSqliteDatabase } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createClient, type Client, type InStatement } from "@libsql/client";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  source: string;
  targetUrl: string;
  targetToken?: string;
  dryRun: boolean;
  batchSize: number;
  tablesFilter: string[] | null; // null = all user tables
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    dryRun: false,
    batchSize: 500,
    tablesFilter: null,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return v;
    };

    switch (arg) {
      case "--source":
        args.source = next();
        break;
      case "--target-url":
        args.targetUrl = next();
        break;
      case "--target-token":
        args.targetToken = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--batch-size": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--batch-size must be a positive integer, got ${n}`);
        }
        args.batchSize = n;
        break;
      }
      case "--tables": {
        const csv = next();
        args.tablesFilter = csv
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (args.tablesFilter.length === 0) {
          throw new Error("--tables requires at least one table name");
        }
        break;
      }
      case "--force":
        args.force = true;
        break;
      case "-h":
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.source) throw new Error("--source is required");
  if (!args.targetUrl) throw new Error("--target-url is required");

  return args as CliArgs;
}

function printUsageAndExit(code: number): never {
  const usage = `Usage: bun scripts/migrate-bun-sqlite-to-libsql.ts [options]

Required:
  --source <path>            Path to bun:sqlite source DB (e.g. ~/.claude-mem/claude-mem.db)
  --target-url <url>         libSQL primary URL (e.g. http://localhost:8080)

Optional:
  --target-token <token>     Auth bearer token for the target (sqld can run without auth in dev)
  --dry-run                  Print row counts; do not write to the target
  --batch-size <n>           Rows per libSQL batch (default 500)
  --tables a,b,c             Restrict to comma-separated tables (default: all user tables)
  --force                    Bypass the WAL-size safety rail
  -h, --help                 Show this help and exit
`;
  console.log(usage);
  process.exit(code);
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.replace(/^~\/?/, ""));
  }
  return resolve(p);
}

// ---------------------------------------------------------------------------
// Logging helpers — one-shot script, plain stdout/stderr is fine.
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}
function warn(msg: string): void {
  console.error(`WARN: ${msg}`);
}
function err(msg: string): void {
  console.error(`ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Source-side discovery (bun:sqlite, readonly)
// ---------------------------------------------------------------------------

interface SchemaObject {
  name: string;
  type: "table" | "index";
  sql: string | null; // nullable: auto-generated indexes (e.g. sqlite_autoindex_*) have NULL sql
  tbl_name: string;
}

interface TableInfo {
  name: string;
  createSql: string;
  indexes: SchemaObject[];
  columns: string[];
}

function quoteIdent(name: string): string {
  // SQLite identifier quoting via doubled double-quotes. Used for table/column names.
  return `"${name.replace(/"/g, '""')}"`;
}

function discoverSchema(
  src: BunSqliteDatabase,
  filter: string[] | null,
): TableInfo[] {
  // SQLite schema lives in sqlite_master. Skip:
  //   - sqlite_* (engine internals)
  //   - libsql_wasm_func_table (libSQL internal, won't apply on bun:sqlite reads
  //     but documented for future-proofing)
  // The plan's task 6 says "skip sqlite_* and schema_versions duplicates" —
  // schema_versions is a real claude-mem migrations table though, not a
  // duplicate to skip. Treat it like any other user table; INSERT OR IGNORE
  // dedupes if both source and target ran migrations.
  const rows = src
    .query<
      SchemaObject,
      []
    >(`SELECT name, type, sql, tbl_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY name`)
    .all();

  const allIndexes = src
    .query<
      SchemaObject,
      []
    >(`SELECT name, type, sql, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY name`)
    .all();

  const filterSet = filter ? new Set(filter) : null;

  const tables: TableInfo[] = [];
  for (const row of rows) {
    if (filterSet && !filterSet.has(row.name)) continue;
    if (!row.sql) {
      warn(`Skipping table ${row.name}: no CREATE TABLE statement (engine-internal?)`);
      continue;
    }

    // pragma_table_info gives column list in declaration order. We need
    // declaration order so generated INSERT column lists match the row keys.
    const cols = src
      .query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(row.name)})`)
      .all()
      .map((c) => c.name);

    if (cols.length === 0) {
      warn(`Skipping table ${row.name}: table_info returned no columns`);
      continue;
    }

    tables.push({
      name: row.name,
      createSql: row.sql,
      indexes: allIndexes.filter((idx) => idx.tbl_name === row.name && idx.sql !== null),
      columns: cols,
    });
  }

  if (filterSet) {
    const got = new Set(tables.map((t) => t.name));
    const missing = [...filterSet].filter((t) => !got.has(t));
    if (missing.length > 0) {
      throw new Error(
        `--tables filter requested unknown tables: ${missing.join(", ")}`,
      );
    }
  }

  return tables;
}

function detectUniqueConstraint(table: TableInfo): boolean {
  // INSERT OR IGNORE only deduplicates against UNIQUE constraints. PRIMARY KEY
  // counts as UNIQUE in SQLite. Ask pragma_index_list / pragma_table_info via
  // a heuristic: scan the CREATE TABLE SQL for UNIQUE / PRIMARY KEY tokens.
  // This is informational only — re-run idempotency depends on it.
  const sql = table.createSql.toLowerCase();
  return /\b(primary\s+key|unique)\b/.test(sql);
}

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

const WAL_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB

function assertWalSafe(sourcePath: string, force: boolean): void {
  const walPath = `${sourcePath}-wal`;
  if (!existsSync(walPath)) return;
  const walSize = statSync(walPath).size;
  if (walSize <= WAL_LIMIT_BYTES) return;

  warn(
    `WAL is large (${(walSize / 1024 / 1024).toFixed(1)} MB > ${WAL_LIMIT_BYTES / 1024 / 1024} MB) — stop the worker before running. Re-run with --force to override.`,
  );
  if (!force) {
    process.exit(2);
  }
  warn("--force passed; proceeding despite large WAL.");
}

// ---------------------------------------------------------------------------
// Target-side schema replication
// ---------------------------------------------------------------------------

async function ensureTargetSchema(
  target: Client,
  table: TableInfo,
): Promise<void> {
  // Hard-coded "no schema mutation" — never DROP, never ALTER. Only CREATE IF
  // NOT EXISTS. If the target already has the table with a different schema,
  // the inserts below will fail loudly and the script will exit non-zero.
  // That is intentional per "Fail Fast" — silently ignoring schema drift would
  // hide real data corruption.

  // Rewrite "CREATE TABLE x" -> "CREATE TABLE IF NOT EXISTS x" without
  // touching the rest of the SQL. Same for indexes.
  const createSql = rewriteCreateAsIfNotExists(table.createSql);
  await target.execute(createSql);

  for (const idx of table.indexes) {
    if (!idx.sql) continue;
    const indexSql = rewriteCreateAsIfNotExists(idx.sql);
    await target.execute(indexSql);
  }
}

function rewriteCreateAsIfNotExists(sql: string): string {
  // Replace "CREATE TABLE foo" or "CREATE UNIQUE INDEX foo" with their
  // "IF NOT EXISTS" variants. Case-insensitive on the keyword, leave the rest
  // of the statement intact (column types, constraints, etc.).
  return sql.replace(
    /^(\s*CREATE\s+(?:UNIQUE\s+|VIRTUAL\s+|TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX))\s+(?!IF\s+NOT\s+EXISTS\b)/i,
    "$1 IF NOT EXISTS ",
  );
}

// ---------------------------------------------------------------------------
// Row copy
// ---------------------------------------------------------------------------

interface CopyStats {
  table: string;
  sourceCount: number;
  targetCountAfter: number;
  hasUnique: boolean;
}

function bunValueToLibsql(v: unknown): null | string | number | bigint | ArrayBuffer {
  // bun:sqlite returns:
  //   null, number (for INTEGER/REAL within JS-safe range), string (for TEXT),
  //   Uint8Array (for BLOB), bigint (for INTEGER outside Number.MAX_SAFE_INTEGER
  //   when configured — in default mode bun returns plain Numbers).
  // libSQL `args` accepts: null | string | number | bigint | ArrayBuffer | Uint8Array.
  // Pass through; convert Uint8Array buffer to ArrayBuffer for explicit typing.
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
    return v;
  }
  if (v instanceof Uint8Array) {
    // libSQL accepts Uint8Array directly per the SDK type defs, but spike
    // confirmed ArrayBuffer is safer across versions.
    const buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return buf as ArrayBuffer;
  }
  if (typeof v === "boolean") {
    // SQLite has no native bool — bun:sqlite normally gives 0/1 as numbers, so
    // this branch is defensive only.
    return v ? 1 : 0;
  }
  // Anything else (Date, object) shouldn't appear from raw SELECT *. If it
  // does, fail loud rather than corrupt data.
  throw new Error(`Unsupported source value type ${typeof v}: ${String(v)}`);
}

async function copyTable(
  src: BunSqliteDatabase,
  target: Client,
  table: TableInfo,
  batchSize: number,
  dryRun: boolean,
): Promise<CopyStats> {
  const totalRow = src
    .query<
      { c: number },
      []
    >(`SELECT COUNT(*) AS c FROM ${quoteIdent(table.name)}`)
    .get();
  const total = totalRow?.c ?? 0;
  const totalBatches = total === 0 ? 0 : Math.ceil(total / batchSize);
  const hasUnique = detectUniqueConstraint(table);

  log(`[${table.name}] source rows: ${total} (batches: ${totalBatches}, unique constraint: ${hasUnique ? "yes" : "NO — re-run not idempotent"})`);

  if (!hasUnique && !dryRun && total > 0) {
    warn(
      `Table ${table.name} has no PRIMARY KEY or UNIQUE constraint visible in CREATE TABLE; re-running this script will duplicate its rows on the target.`,
    );
  }

  if (dryRun || total === 0) {
    return {
      table: table.name,
      sourceCount: total,
      targetCountAfter: total === 0 ? 0 : -1, // -1 = "not measured"
      hasUnique,
    };
  }

  const colList = table.columns.map(quoteIdent).join(", ");
  const placeholders = table.columns.map(() => "?").join(", ");
  // INSERT OR IGNORE makes per-row idempotent against UNIQUE conflicts.
  // https://www.sqlite.org/lang_conflict.html
  const insertSql = `INSERT OR IGNORE INTO ${quoteIdent(table.name)} (${colList}) VALUES (${placeholders})`;

  let copied = 0;
  for (let offset = 0, batchN = 0; offset < total; offset += batchSize, batchN++) {
    // Order by rowid for deterministic streaming. rowid exists on every
    // non-WITHOUT-ROWID table; WITHOUT-ROWID tables would need a different
    // strategy, but claude-mem's schema doesn't use them.
    const rows = src
      .query<
        Record<string, unknown>,
        [number, number]
      >(`SELECT ${colList} FROM ${quoteIdent(table.name)} ORDER BY rowid LIMIT ? OFFSET ?`)
      .all(batchSize, offset);

    const stmts: InStatement[] = rows.map((row) => ({
      sql: insertSql,
      args: table.columns.map((c) => bunValueToLibsql(row[c])),
    }));

    try {
      // Cite: https://github.com/tursodatabase/libsql-client-ts#client.batch
      await target.batch(stmts, "write");
    } catch (e) {
      err(
        `Failed batch ${batchN + 1}/${totalBatches} for table ${table.name} at offset ${offset}: ${(e as Error).message}`,
      );
      throw e; // propagate — kills the script per Fail Fast
    }

    copied += rows.length;
    log(
      `[${table.name}] ${copied}/${total} rows (${batchN + 1}/${totalBatches} batches)`,
    );
  }

  // Sanity probe: count target rows after.
  const targetCountResult = await target.execute(
    `SELECT COUNT(*) AS c FROM ${quoteIdent(table.name)}`,
  );
  const cVal = targetCountResult.rows[0]?.c;
  const targetCount = typeof cVal === "bigint" ? Number(cVal) : Number(cVal ?? 0);

  return {
    table: table.name,
    sourceCount: total,
    targetCountAfter: targetCount,
    hasUnique,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  const sourcePath = expandHome(cli.source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Source DB not found: ${sourcePath}`);
  }

  log(`Source:    ${sourcePath}`);
  log(`Target:    ${cli.targetUrl}${cli.targetToken ? " (auth: token)" : " (auth: none)"}`);
  log(`Mode:      ${cli.dryRun ? "DRY RUN (no writes)" : "WRITE"}`);
  log(`Batch:     ${cli.batchSize}`);
  log(`Tables:    ${cli.tablesFilter ? cli.tablesFilter.join(", ") : "all user tables"}`);
  log("");

  assertWalSafe(sourcePath, cli.force);

  // bun:sqlite readonly. Cite: https://bun.sh/docs/api/sqlite#options
  const src = new BunSqliteDatabase(sourcePath, { readonly: true });

  // libSQL remote-only client (no syncUrl, no embedded replica). Cite:
  // https://docs.turso.tech/sdk/ts/quickstart#connect-to-remote-database
  // https://github.com/tursodatabase/libsql-client-ts#createclient
  const target: Client = createClient({
    url: cli.targetUrl,
    ...(cli.targetToken ? { authToken: cli.targetToken } : {}),
  });

  const tables = discoverSchema(src, cli.tablesFilter);
  if (tables.length === 0) {
    log("No tables to migrate.");
    src.close();
    target.close();
    return;
  }

  log(`Discovered ${tables.length} table(s): ${tables.map((t) => t.name).join(", ")}`);
  log("");

  // Replicate schema first (no-op if target already has it).
  if (!cli.dryRun) {
    for (const t of tables) {
      try {
        await ensureTargetSchema(target, t);
      } catch (e) {
        err(`Schema replication failed for ${t.name}: ${(e as Error).message}`);
        throw e;
      }
    }
    log("Schema replication complete.");
    log("");
  } else {
    log("DRY RUN: skipping schema replication.");
    log("");
  }

  const stats: CopyStats[] = [];
  for (const t of tables) {
    const s = await copyTable(src, target, t, cli.batchSize, cli.dryRun);
    stats.push(s);
  }

  log("");
  log("=== Summary ===");
  let mismatch = false;
  let totalSource = 0;
  let totalTarget = 0;
  for (const s of stats) {
    totalSource += s.sourceCount;
    if (s.targetCountAfter >= 0) totalTarget += s.targetCountAfter;

    if (cli.dryRun) {
      log(`  ${s.table}: ${s.sourceCount} rows (dry run, target untouched)`);
    } else {
      const ok = s.targetCountAfter >= s.sourceCount;
      // Target can have MORE rows than source (pre-existing data on target);
      // it must NEVER have fewer — that's the failure mode we care about.
      if (!ok) mismatch = true;
      log(
        `  ${s.table}: source=${s.sourceCount} target=${s.targetCountAfter}${ok ? "" : " <-- MISMATCH"}`,
      );
    }
  }
  log("");

  if (cli.dryRun) {
    log(`Done (DRY RUN). Source rows: ${totalSource} Target rows: not written.`);
  } else {
    log(`Done. Source rows: ${totalSource} Target rows: ${totalTarget}`);
    if (mismatch) {
      err("Row count mismatch on at least one table. See lines marked MISMATCH above.");
      src.close();
      target.close();
      process.exit(1);
    }
  }

  src.close();
  target.close();
}

main().catch((e) => {
  err(`Bootstrap failed: ${(e as Error).message}`);
  if ((e as Error).stack) console.error((e as Error).stack);
  process.exit(1);
});
