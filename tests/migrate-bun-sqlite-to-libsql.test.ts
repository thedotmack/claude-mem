/**
 * Tests for `scripts/migrate-bun-sqlite-to-libsql.ts`.
 *
 * Strategy:
 *   The script's CLI accepts `--target-url` which we point at a libSQL local
 *   in-memory URL (`:memory:`) for these tests. libSQL supports the `:memory:`
 *   form natively (verified locally; same code path as remote — `createClient`
 *   just dispatches based on URL scheme).
 *
 *   Why not real sqld inside the test? Spinning up `ghcr.io/tursodatabase/libsql-server`
 *   inside CI would require Docker availability that's not guaranteed. The
 *   spike (`.scratch/spike-libsql-sdk.md` §3) already verified end-to-end
 *   replication against a real sqld primary. These tests cover correctness of
 *   the bootstrap script itself (schema discovery, batching, idempotency,
 *   dry-run, --tables filter, index preservation), not libSQL transport.
 *
 *   Caveat: a `:memory:` libSQL client lives only inside one process. The
 *   script under test is a separate process (we spawn it with `bun`), so we
 *   can't share an in-process libSQL client between the test runner and the
 *   script. Solution: spawn the script with `--target-url file:<tempdir>/lib.db`
 *   pointing at a libSQL *local file* DB, then open that file with our own
 *   libSQL client to verify. Same SDK code path as `:memory:` for
 *   non-replicated local writes.
 *
 * libSQL SDK reference:
 *   https://github.com/tursodatabase/libsql-client-ts
 *   https://docs.turso.tech/sdk/ts/quickstart
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database as BunSqliteDatabase } from "bun:sqlite";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "scripts",
  "migrate-bun-sqlite-to-libsql.ts",
);

interface TestEnv {
  workDir: string;
  sourcePath: string;
  targetPath: string;
  targetUrl: string;
}

function makeEnv(): TestEnv {
  const workDir = mkdtempSync(join(tmpdir(), "bun-libsql-migrate-test-"));
  const sourcePath = join(workDir, "source.db");
  const targetPath = join(workDir, "target.db");
  return {
    workDir,
    sourcePath,
    targetPath,
    targetUrl: `file:${targetPath}`,
  };
}

function teardownEnv(env: TestEnv): void {
  rmSync(env.workDir, { recursive: true, force: true });
}

function seedSourceDb(
  sourcePath: string,
  spec: {
    withIndex?: boolean;
    rowsObservations?: number;
    rowsSummaries?: number;
    rowsLooseTable?: number; // table without UNIQUE constraint
  } = {},
): void {
  const {
    withIndex = false,
    rowsObservations = 0,
    rowsSummaries = 0,
    rowsLooseTable = 0,
  } = spec;

  const db = new BunSqliteDatabase(sourcePath, { create: true });
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      title TEXT,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(session_id, title)
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      request TEXT
    );
    CREATE TABLE loose_table (
      a TEXT,
      b INTEGER
    );
  `);
  if (withIndex) {
    db.exec("CREATE INDEX idx_observations_session ON observations(session_id);");
  }

  const insObs = db.prepare(
    "INSERT INTO observations (session_id, title, created_at_epoch) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < rowsObservations; i++) {
    insObs.run(`session-${i}`, `title-${i}`, 1700000000000 + i);
  }

  const insSum = db.prepare(
    "INSERT INTO session_summaries (session_id, request) VALUES (?, ?)",
  );
  for (let i = 0; i < rowsSummaries; i++) {
    insSum.run(`session-${i}`, `request-${i}`);
  }

  const insLoose = db.prepare("INSERT INTO loose_table (a, b) VALUES (?, ?)");
  for (let i = 0; i < rowsLooseTable; i++) {
    insLoose.run(`a-${i}`, i);
  }

  db.close();
}

function runMigrate(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "bun",
    [SCRIPT_PATH, ...args],
    { encoding: "utf8" },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function openTarget(env: TestEnv): Promise<Client> {
  // Open the target file with our own libSQL client to verify writes.
  // Same SDK as the script uses; just pointed at the same file.
  return createClient({ url: env.targetUrl });
}

async function countTarget(env: TestEnv, table: string): Promise<number> {
  const c = await openTarget(env);
  try {
    const r = await c.execute(`SELECT COUNT(*) AS c FROM "${table}"`);
    const v = r.rows[0]?.c;
    return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
  } finally {
    c.close();
  }
}

async function targetHasObject(
  env: TestEnv,
  type: "table" | "index",
  name: string,
): Promise<boolean> {
  const c = await openTarget(env);
  try {
    const r = await c.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type=? AND name=?",
      args: [type, name],
    });
    return r.rows.length > 0;
  } finally {
    c.close();
  }
}

describe("migrate-bun-sqlite-to-libsql", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    teardownEnv(env);
  });

  describe("round-trip", () => {
    it("copies all rows from 3 tables (50+ rows total) to a fresh target", async () => {
      seedSourceDb(env.sourcePath, {
        rowsObservations: 30,
        rowsSummaries: 20,
        rowsLooseTable: 10,
      });

      const result = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--batch-size", "7", // odd batch size to exercise partial last batch
      ]);

      if (result.status !== 0) {
        console.error("STDOUT:\n" + result.stdout);
        console.error("STDERR:\n" + result.stderr);
      }
      expect(result.status).toBe(0);

      expect(await countTarget(env, "observations")).toBe(30);
      expect(await countTarget(env, "session_summaries")).toBe(20);
      expect(await countTarget(env, "loose_table")).toBe(10);
    });
  });

  describe("idempotency", () => {
    it("re-running on a populated target keeps row counts stable for tables with UNIQUE constraints", async () => {
      seedSourceDb(env.sourcePath, {
        rowsObservations: 25,
        rowsSummaries: 15,
      });

      // First run
      const r1 = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--tables", "observations,session_summaries", // skip loose_table for this case
      ]);
      expect(r1.status).toBe(0);

      const obsAfter1 = await countTarget(env, "observations");
      const sumAfter1 = await countTarget(env, "session_summaries");
      expect(obsAfter1).toBe(25);
      expect(sumAfter1).toBe(15);

      // Second run — must not error and must not duplicate.
      const r2 = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--tables", "observations,session_summaries",
      ]);
      expect(r2.status).toBe(0);

      expect(await countTarget(env, "observations")).toBe(obsAfter1);
      expect(await countTarget(env, "session_summaries")).toBe(sumAfter1);
    });
  });

  describe("dry-run", () => {
    it("does not create the target DB or any tables", async () => {
      seedSourceDb(env.sourcePath, { rowsObservations: 5 });

      const result = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--dry-run",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("DRY RUN");

      // libSQL with file: URL eagerly creates the file on first connect, so
      // we can't assert non-existence of the file. Instead, assert no tables
      // got created on it. (If the script writes nothing, the file is either
      // absent or empty / has no user tables.)
      if (existsSync(env.targetPath)) {
        const c = await openTarget(env);
        try {
          const r = await c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          );
          expect(r.rows.length).toBe(0);
        } finally {
          c.close();
        }
      }
    });
  });

  describe("--tables filter", () => {
    it("copies only the named table; other tables are absent on target", async () => {
      seedSourceDb(env.sourcePath, {
        rowsObservations: 8,
        rowsSummaries: 8,
        rowsLooseTable: 8,
      });

      const result = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--tables", "observations",
      ]);
      expect(result.status).toBe(0);

      expect(await countTarget(env, "observations")).toBe(8);
      expect(await targetHasObject(env, "table", "session_summaries")).toBe(false);
      expect(await targetHasObject(env, "table", "loose_table")).toBe(false);
    });

    it("rejects unknown table names with non-zero exit", async () => {
      seedSourceDb(env.sourcePath, { rowsObservations: 1 });

      const result = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--tables", "nonexistent_table",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("nonexistent_table");
    });
  });

  describe("BLOB round-trip", () => {
    it("preserves byte-for-byte equality for BLOB payloads of varying lengths", async () => {
      const payload1 = new Uint8Array([0x42]);
      const payload256 = new Uint8Array(256);
      for (let i = 0; i < 256; i++) payload256[i] = i & 0xff;
      const payload4096 = new Uint8Array(4096);
      for (let i = 0; i < 4096; i++) payload4096[i] = (i * 31 + 7) & 0xff;

      const db = new BunSqliteDatabase(env.sourcePath, { create: true });
      db.exec(`
        CREATE TABLE binaries (
          id INTEGER PRIMARY KEY,
          payload BLOB NOT NULL
        );
      `);
      const ins = db.prepare("INSERT INTO binaries (id, payload) VALUES (?, ?)");
      ins.run(1, payload1);
      ins.run(2, payload256);
      ins.run(3, payload4096);
      db.close();

      const result = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--tables", "binaries",
      ]);

      if (result.status !== 0) {
        console.error("STDOUT:\n" + result.stdout);
        console.error("STDERR:\n" + result.stderr);
      }
      expect(result.status).toBe(0);

      const c = await openTarget(env);
      try {
        const r = await c.execute("SELECT id, payload FROM binaries ORDER BY id");
        expect(r.rows.length).toBe(3);

        const expected: Record<number, Uint8Array> = {
          1: payload1,
          2: payload256,
          3: payload4096,
        };

        for (const row of r.rows) {
          const id = Number(row.id);
          const raw = row.payload;
          // @libsql/client returns BLOBs as ArrayBuffer.
          expect(raw instanceof ArrayBuffer).toBe(true);
          const got = new Uint8Array(raw as ArrayBuffer);
          const want = expected[id];
          expect(got.byteLength).toBe(want.byteLength);
          expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
        }
      } finally {
        c.close();
      }
    });
  });

  describe("schema preservation", () => {
    it("mirrors a CREATE INDEX from source onto target", async () => {
      seedSourceDb(env.sourcePath, {
        withIndex: true,
        rowsObservations: 3,
      });

      const result = runMigrate([
        "--source", env.sourcePath,
        "--target-url", env.targetUrl,
        "--tables", "observations",
      ]);
      expect(result.status).toBe(0);

      expect(await targetHasObject(env, "index", "idx_observations_session")).toBe(true);
    });
  });

  describe("CLI validation", () => {
    it("exits non-zero when --source is missing", () => {
      const result = runMigrate([
        "--target-url", env.targetUrl,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--source");
    });

    it("exits non-zero when --target-url is missing", () => {
      seedSourceDb(env.sourcePath, { rowsObservations: 1 });
      const result = runMigrate([
        "--source", env.sourcePath,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--target-url");
    });

    it("exits non-zero on unknown source path", () => {
      const result = runMigrate([
        "--source", "/nonexistent/path/to/db",
        "--target-url", env.targetUrl,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not found");
    });
  });
});
