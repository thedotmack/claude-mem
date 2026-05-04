#!/usr/bin/env node
// Spike test for the libSQL SDK choice (Phase 1, task 1).
//
// Exercises both @libsql/client (embedded replica) and @tursodatabase/sync (push/pull)
// against a local self-hosted sqld at http://localhost:8080.
//
// Run from .scratch/spike-libsql/ (where node_modules lives), e.g.:
//   cd .scratch/spike-libsql && node ../spike-test.mjs
// or use the colocated copy: .scratch/spike-libsql/spike-test.mjs
//
// Prereq: docker container `spike-sqld` running on :8080
//   docker run -d --name spike-sqld -p 8080:8080 \
//     -v $PWD/sqld-data:/var/lib/sqld \
//     -e SQLD_NODE=primary -e SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080 \
//     ghcr.io/tursodatabase/libsql-server:v0.24.8

import { createClient } from "@libsql/client";
import { connect as connectSync } from "@tursodatabase/sync";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const SQLD_URL = process.env.TURSO_DATABASE_URL ?? "http://localhost:8080";
const SECTION = (s) => console.log(`\n========== ${s} ==========`);

async function cleanFiles(prefix) {
  for (const suffix of ["", "-info", "-wal", "-shm", "-client_wal_index"]) {
    const p = `${prefix}${suffix}`;
    if (existsSync(p)) await rm(p, { force: true });
  }
}

// --- Section A: @libsql/client embedded replica ---
SECTION("A. @libsql/client embedded replica");
const replicaPath = "./replica.db";
await cleanFiles(replicaPath);

const libsqlClient = createClient({
  url: `file:${replicaPath}`,
  syncUrl: SQLD_URL,
  syncInterval: 0,
});

await libsqlClient.execute(
  "CREATE TABLE IF NOT EXISTS spike (id INTEGER PRIMARY KEY, msg TEXT, ts INTEGER)"
);
const insertRes = await libsqlClient.execute({
  sql: "INSERT INTO spike (msg, ts) VALUES (?, ?)",
  args: ["hello-from-libsql-client", Date.now()],
});
console.log("[libsql/client] insert rowsAffected:", insertRes.rowsAffected,
  "lastInsertRowid:", String(insertRes.lastInsertRowid));

const readRes = await libsqlClient.execute("SELECT id, msg, ts FROM spike ORDER BY id");
console.log("[libsql/client] rows:",
  readRes.rows.map((r) => ({ id: Number(r.id), msg: r.msg, ts: Number(r.ts) })));

console.log("[libsql/client] calling sync()...");
const syncRes = await libsqlClient.sync();
console.log("[libsql/client] sync() returned:", syncRes);

// --- Section B: @tursodatabase/sync ---
SECTION("B. @tursodatabase/sync");
const syncPath = "./sync.db";
await cleanFiles(syncPath);

try {
  const syncDb = await connectSync({
    path: syncPath,
    url: SQLD_URL,
    clientName: "spike-test",
  });
  console.log("[tursodatabase/sync] connect ok");

  await syncDb.exec(
    "CREATE TABLE IF NOT EXISTS spike2 (id INTEGER PRIMARY KEY, msg TEXT, ts INTEGER)"
  );
  const stmt = syncDb.prepare("INSERT INTO spike2 (msg, ts) VALUES (?, ?)");
  const r = await stmt.run("hello-from-tursodatabase-sync", Date.now());
  console.log("[tursodatabase/sync] insert run result:", r);

  const rows = await syncDb.prepare("SELECT id, msg, ts FROM spike2 ORDER BY id").all();
  console.log("[tursodatabase/sync] rows:", rows);

  console.log("[tursodatabase/sync] calling push()...");
  try { await syncDb.push(); console.log("[tursodatabase/sync] push() OK"); }
  catch (err) { console.log("[tursodatabase/sync] push() FAILED:", err?.message ?? err); }

  console.log("[tursodatabase/sync] calling pull()...");
  try { console.log("[tursodatabase/sync] pull() ->", await syncDb.pull()); }
  catch (err) { console.log("[tursodatabase/sync] pull() FAILED:", err?.message ?? err); }

  await syncDb.close();
} catch (err) {
  console.log("[tursodatabase/sync] connect() FAILED:", err?.message ?? err);
  console.log("[tursodatabase/sync] (connect() does an implicit pull, which 404s on sqld)");
}

SECTION("DONE");
