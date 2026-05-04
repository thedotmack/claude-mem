# Phase 1B Handoff — claude-mem libSQL DB-Layer Cutover

**Authored:** 2026-05-04
**Branch at handoff:** `feat/libsql-migration`
**Phase:** 1A foundation merged; 1B consumer cutover deferred to a follow-up.
**Audience:** the next contributor / next session that picks up the libSQL DB-layer migration after Phase 1A lands.

This document is intentionally self-contained. If you read nothing else, read sections 1, 2, and 4 in full and skim the rest. Sections 5 and 6 exist so you don't relearn things the spike already paid for.

---

## 1. Status as of this PR (Phase 1A)

Phase 1A is the **foundation only**. It ships everything needed to start 1B without unblocking any consumer code. Nothing in `src/` was touched. The `bun:sqlite` runtime path is still the only one in use.

| Item | State | Path |
|---|---|---|
| `@libsql/client@0.17.3` added to dependencies | shipped 1A | `package.json` |
| Bootstrap data-migration tool (one-time copy of existing `~/.claude-mem/claude-mem.db` into a libSQL primary) | shipped 1A | `scripts/migrate-bun-sqlite-to-libsql.ts` |
| Local sqld dev harness (docker-compose) | shipped 1A | `containers/sync-host/dev-sqld/` |
| `scripts/claude-mem-sync` deprecation banner | shipped 1A | `scripts/claude-mem-sync` (lines 4-9 of the diff) |
| `.scratch/sync-container-plan.md` updated with Phase 1 split + spike corrections (v4) | shipped 1A | `.scratch/sync-container-plan.md` |
| SDK choice spike report | shipped 1A | `.scratch/spike-libsql-sdk.md` |
| Migration surface inventory (1,255 sync call sites, 8 tx hotspots, 47 test files) | shipped 1A | `.scratch/inventory-better-sqlite3.md` |
| Async-shim adapter (`LibSqlDatabase` parallel to `ClaudeMemDatabase`) | **deferred to 1B** | `src/services/sqlite/Database.ts` |
| `transactions.ts` async conversion (5 critical hotspots) | **deferred to 1B** | `src/services/sqlite/transactions.ts` |
| Migration runner async conversion (35+ CREATE TABLEs) | **deferred to 1B** | `src/services/sqlite/migrations/runner.ts` |
| `SessionStore.ts` async conversion (309 sync call sites) | **deferred to 1B** | `src/services/sqlite/SessionStore.ts` |
| Worker HTTP routes (DataRoutes, SearchRoutes, SessionRoutes, MemoryRoutes, ViewerRoutes) | **deferred to 1B** | `src/services/worker/http/routes/` |
| Search layer (SearchManager, SessionSearch) | **deferred to 1B** | `src/services/worker/SearchManager.ts`, `src/services/sqlite/SessionSearch.ts` |
| Tests (47 files) updated to async | **deferred to 1B** | `src/**/*.test.ts` |
| External scripts (`scripts/regenerate-claude-md.ts`, etc., openclaw, plugin/scripts) | **deferred to 1B** | `scripts/`, `openclaw/`, `plugin/scripts/` |
| Removal of `bun:sqlite` import path entirely | **deferred to 1B Step 6** | `src/services/sqlite/Database.ts` |

**1A commit SHA:** `<TO_BE_FILLED_BY_ORCHESTRATOR>`
**1A PR URL:** `<TO_BE_FILLED_BY_ORCHESTRATOR>`

### Why 1A/1B was split

Plan §5 originally estimated Phase 1 at "1-2 days of focused refactoring." The spike (`.scratch/spike-libsql-sdk.md`) plus the inventory (`.scratch/inventory-better-sqlite3.md`) corrected that to **~4 weeks** for a serial conversion of 1,255 call sites. 1A was carved off so the foundation (SDK pinned, sqld harness running, deprecation banner posted, plan updated) lands immediately and 1B can be sliced into reviewable per-file PRs without holding up the rest of the work in this branch.

### Pre-validated facts you can lean on

- libSQL opens the existing production `~/.claude-mem/claude-mem.db` (310 MB, 36 tables, 77,188 observations) cleanly. File-format compatibility verified 2026-05-04 (`step1-open-asis.mjs` in the prior libSQL vector experiment). The "will libSQL accept the prod DB" question is closed: yes.
- `@libsql/client@0.17.3` works against self-hosted sqld v0.24.8 — verified live. Two-replica round-trip via the same primary verified live (`replication-test.mjs`). Bun smoke verified (`bun-test.mjs`).
- `@tursodatabase/sync` (the newer offline-first SDK) **does not** work against self-hosted sqld in v0.24.x. Its engine calls `POST /pull-updates`, a Turso-Cloud-only route sqld returns 404 for. Don't waste a session retrying it; revisit only when the SDK adds sqld support.

---

## 2. Recommended execution order for Phase 1B

Six steps, ordered to keep the build green at every stop. Each step is intended to be a separate sub-PR.

### Step 1 — Async-shim adapter

**Goal:** Add a parallel `LibSqlDatabase` class behind a feature flag, without disturbing the active `bun:sqlite` path. Both classes expose the same async surface so consumer files can be migrated one at a time without forking call sites.

**Files touched:**
- `src/services/sqlite/Database.ts` — add `LibSqlDatabase` class; teach `DatabaseManager.initialize()` to read `CLAUDE_MEM_DB_BACKEND` and instantiate the matching class. Wrap every existing `ClaudeMemDatabase` method in `async`/`Promise.resolve(...)` so the surface area is identical.
- `src/services/sqlite/types.ts` (or a new file) — extract a shared interface so consumers depend on the abstraction, not the concrete class.

**Env flag:** `CLAUDE_MEM_DB_BACKEND=libsql|bun-sqlite` (default `bun-sqlite`). The flag is read once at process start in `DatabaseManager.initialize()` — do not check it per-call.

**Why this is an explicit, time-boxed violation of plan anti-pattern #2** (`don't keep both layers`): incremental migration is the only viable path given 1,255 call sites and 8 transactions. The flag forces the parallel period to be short and observable. Step 6 deletes the `bun-sqlite` path entirely and removes the flag.

**Estimated time:** 0.5-1 day. The hard part is getting the shared interface right; the wrapping is mechanical.

**Verification:**
- `CLAUDE_MEM_DB_BACKEND=bun-sqlite bun run build-and-sync && bun test` — all existing tests still pass.
- `CLAUDE_MEM_DB_BACKEND=libsql bun test src/services/sqlite/Database.test.ts` (a new minimal smoke test covering "open, write a row to a fresh table, read it back, close") passes against `http://localhost:8080` (the sqld dev harness from 1A).
- `grep -n "import { Database } from 'bun:sqlite'" src/ | wc -l` count is unchanged from pre-1B (the flag adds a code path, doesn't replace the existing one).

**Risk:** If the shared interface leaks `bun:sqlite`-specific types (e.g. `SQLQueryBindings`), you'll have to revisit later. Use plain TS types for bind parameters from the start: `Array<string | number | bigint | Uint8Array | null>`.

---

### Step 2 — Convert `transactions.ts` (the 5 critical hotspots)

**Goal:** Convert the `.transaction()` call sites in the cross-cutting helpers, because everything else that touches transactions calls into these.

**Files touched:**
- `src/services/sqlite/transactions.ts` — `storeObservationsAndMarkComplete` (line 16), `storeObservations` (line 124). Both wrap a `db.transaction(() => { ... loop with .prepare().get() per row + .run() ... })()` block.

**Pattern (concrete, not pseudocode):**

Before (current `transactions.ts:30-119`, abridged):
```ts
const storeAndMarkTx = db.transaction(() => {
  const observationIds: number[] = [];
  const obsStmt = db.prepare(`INSERT INTO observations ... ON CONFLICT(...) DO NOTHING RETURNING id`);
  const lookupExistingStmt = db.prepare(`SELECT id FROM observations WHERE ...`);
  for (const observation of observations) {
    const contentHash = computeObservationContentHash(...);
    const inserted = obsStmt.get(memorySessionId, project, ..., contentHash, ...) as { id: number } | null;
    if (inserted) { observationIds.push(inserted.id); continue; }
    const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
    if (!existing) throw new Error(...);
    observationIds.push(existing.id);
  }
  // summaryStmt.run, updateStmt.run ...
  return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
});
return storeAndMarkTx();
```

After (libSQL):
```ts
const tx = await db.transaction("write");
try {
  const observationIds: number[] = [];
  const insertSql = `INSERT INTO observations ... ON CONFLICT(...) DO NOTHING RETURNING id`;
  const lookupSql = `SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?`;

  for (const observation of observations) {
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
    const insertResult = await tx.execute({
      sql: insertSql,
      args: [memorySessionId, project, observation.type, /* ... */ contentHash, timestampIso, timestampEpoch],
    });
    if (insertResult.rows.length > 0) {
      observationIds.push(Number((insertResult.rows[0] as any).id));
      continue;
    }
    const lookupResult = await tx.execute({
      sql: lookupSql,
      args: [memorySessionId, contentHash],
    });
    if (lookupResult.rows.length === 0) {
      throw new Error(`storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${contentHash}`);
    }
    observationIds.push(Number((lookupResult.rows[0] as any).id));
  }

  // summary INSERT, pending_messages UPDATE — same shape: await tx.execute(...).
  // Capture summaryId via Number(result.lastInsertRowid).

  await tx.commit();
  return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
} catch (err) {
  await tx.rollback();
  throw err;
}
```

**Keep the dedup-by-content-hash logic.** It's load-bearing: `computeObservationContentHash` is what makes the `ON CONFLICT` deterministic across replicas. Don't refactor that helper while you're already changing the transaction shape.

**Estimated time:** 0.5 day for both functions + tests. They share 90% of the structure.

**Verification:**
- `bun test src/services/sqlite/transactions.test.ts` passes (rewritten to `async` per §6).
- Insert two observations with identical `(memorySessionId, title, narrative)` tuples — both calls return the same `observationIds[0]` (dedup hit on the second call).
- `grep -n "db\.transaction(" src/services/sqlite/transactions.ts` returns 0 matches.

**Risk:** if the rollback path swallows the original error, you'll lose root-cause info. Re-throw `err` from the `catch`, don't wrap it.

---

### Step 3 — Convert `Database.ts` migrations runner

**Goal:** All 35+ `CREATE TABLE IF NOT EXISTS ...` blocks and the migration version-tracking logic move to libSQL's async API.

**Files touched:**
- `src/services/sqlite/migrations/runner.ts` (179 sync call sites — see inventory §3)
- `src/services/sqlite/migrations.ts` (45 sync call sites — duplicates runner.ts logic; consider consolidating, but only if it's a clean win)
- `src/services/sqlite/Database.ts` — `DatabaseManager.runMigrations()` already returns `Promise<void>` (inventory §2.4); now the body actually awaits.

**Patterns:**
- `db.exec(multiStatementSql)` → `await db.executeMultiple(multiStatementSql)` (handles `;`-separated DDL; this is the right primitive for migrations).
- For migrations that need to be transactional (e.g. add column + backfill data + add index), wrap with the same `await db.transaction("write")` / `await tx.commit()` shape as Step 2.
- Schema-version row writes: `await db.execute({ sql: 'INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)', args: [N, isoNow] })`.

**Estimated time:** 1-1.5 days. Mechanical, but every migration must be re-verified to apply cleanly against an empty libSQL database (which is what fresh users will have).

**Verification:**
- Empty libSQL primary + run the worker → all migrations apply, `SELECT version FROM schema_versions ORDER BY version` matches the `bun:sqlite` baseline.
- `bun test src/services/sqlite/migrations/migration-runner.test.ts` (47 calls per inventory §5) passes.
- `bun test src/services/sqlite/schema-repair.test.ts` (33 calls) passes.

**Risk:** SQLite-isms that libSQL handles slightly differently (e.g. `PRAGMA journal_size_limit`, `PRAGMA mmap_size`). PRAGMAs that don't apply on libSQL servers should be skipped or guarded by `CLAUDE_MEM_DB_BACKEND === 'bun-sqlite'`. The migration audit (`.scratch/migration-audit.md`) flagged WAL-related PRAGMA differences; re-read it before this step.

---

### Step 4 — Cascade through SessionStore, Worker layer, Search layer

**Goal:** Convert the high-volume consumers in roughly descending call-count order (per inventory §3 top-30 table).

**Recommended sub-PR breakdown:**

1. **SessionStore.ts (309 calls).** This is large enough to be its own PR. Break it into 2-3 commits inside that PR, each scoped to a method group (observations, sessions, summaries) so review is tractable. Watch for the `this.db.transaction(...)` at line 1867 (HIGH-risk loop-with-dedup, same shape as Step 2) and line 1985 (single `UPDATE` — straightforward).
2. **Worker HTTP route layer.** One PR per file is fine; they're independent:
   - `src/services/worker/http/routes/DataRoutes.ts` (39 calls — POST loops are the hot path, see inventory §4.5 Pattern B)
   - `src/services/worker/http/routes/SearchRoutes.ts` (28 calls)
   - `src/services/worker/http/routes/SessionRoutes.ts` (22 calls)
   - `src/services/worker/http/routes/MemoryRoutes.ts`
   - `src/services/worker/http/routes/ViewerRoutes.ts`
   - All route handlers must change return type to `Promise<Response>` (inventory §4.7 Pattern C).
3. **Search layer.**
   - `src/services/worker/SearchManager.ts` (46 calls) — already partially async (Chroma queries). Conversion makes it fully async; you can opportunistically `Promise.all` the FTS5 + Chroma calls now that they're both promises (small latency win).
   - `src/services/sqlite/SessionSearch.ts` (28 calls) — pure FTS5 queries, low coordination risk.
4. **Worker support files.**
   - `src/services/worker/SessionManager.ts` (31 calls) — multi-table coordination patterns; re-read inventory §4.6.
   - `src/services/worker/PaginationHelper.ts` (11 calls)
   - `src/services/worker/RateLimitStore.ts` (8 calls)
   - `src/services/worker/worker-service.ts` (24 calls) — startup/shutdown only.

**Estimated time:** 2-2.5 weeks of focused work. SessionStore alone is 3-4 days; the route layer is another 3-4 days; search and worker support are ~3 days combined. Rough math: ~50-100 sync call sites converted per day at sustainable quality, with tests rewritten as you go.

**Verification per sub-PR:**
- `grep -nE "(\.prepare\(|\.run\(|\.get\(|\.all\(|\.query\(|\.exec\()" <file>` returns 0 sync-shaped DB calls in the file.
- The file's dedicated test suite is green.
- An integration smoke (worker boots + serves a search request end-to-end) passes after each sub-PR.

**Risk:** contention between two consumers that hold a `tx` against the same primary. libSQL serializes writes at the primary; long-held write transactions block other writes. The current bun:sqlite code holds a transaction across an entire observation batch (up to N observations). Network round-trips per `tx.execute` mean batches are slower; consider `db.batch([...statements])` for multi-statement no-control-flow paths (inventory §3 mentions `db.batch` is supported).

---

### Step 5 — Remaining utilities, tests, external scripts, plugin scripts

**Goal:** Sweep up everything `src/` outside Steps 2-4, then test files, then external consumers.

**Files touched (per inventory §1, §6):**
- Source utilities: `src/services/sync/ChromaSync.ts` (25 calls), `src/services/infrastructure/{WorktreeAdoption,ProcessManager,CleanupV12_4_3}.ts`, `src/services/sqlite/{timeline/queries.ts,import/bulk.ts,observations/*,sessions/*,summaries/*,prompts/*}`, `src/services/context/ObservationCompiler.ts` (10 calls), `src/services/server/Server.ts` (14 calls), `src/supervisor/process-registry.ts` (13 calls), `src/utils/logger.ts` (11 calls), `src/services/sqlite/PendingMessageStore.ts` (11 calls).
- Tests: 47 files (inventory §5). Each test that does `new Database(':memory:')` must adapt — libSQL `:memory:` is supported by `@libsql/client` via `createClient({ url: 'file::memory:' })` and is the right path for unit tests that don't need replication. Bigger tests that need sync-against-primary should run against the dev harness on `http://localhost:8080`.
- External scripts: `scripts/regenerate-claude-md.ts`, `scripts/fix-corrupted-timestamps.ts`, `scripts/cleanup-duplicates.ts`, `scripts/clear-failed-queue.ts`, `scripts/cwd-remap.ts`, `scripts/investigate-timestamps.ts`, `scripts/validate-timestamp-logic.ts`, `scripts/check-pending-queue.ts`, `scripts/export-memories.ts`, `scripts/import-memories.ts`.
- Plugin scripts (CJS, get bundled): `plugin/scripts/worker-service.cjs`, `plugin/scripts/context-generator.cjs`, `plugin/scripts/mcp-server.cjs`, `plugin/scripts/statusline-counts.js`. These are built artifacts — re-run `npm run build-and-sync` and verify the bundles don't pull in `bun:sqlite`.
- OpenClaw: `openclaw/src/index.ts` (9 calls).

**CI:** add `docker compose -f containers/sync-host/dev-sqld/docker-compose.yml up -d` before `bun test`, and `docker compose ... down -v` after. Health-gate the start with `curl --fail http://localhost:8080/health` in a wait loop (the dev harness from 1A wires this up — see its README).

**Estimated time:** 1-1.5 weeks. The test rewrite is the long pole — 47 files at ~30 minutes each is roughly 3 days plus debugging. External scripts are quick (most are read-only or single-write).

**Verification:**
- `grep -rln "bun:sqlite" src/` returns only `Database.ts` (the bun-sqlite branch is still behind the env flag).
- `grep -rln "bun:sqlite" scripts/ openclaw/ plugin/` returns 0 (CI build artifacts won't ship the old path).
- Full test suite passes against the dev harness in CI.
- A clean `npm run build-and-sync` produces a worker that boots cleanly with `CLAUDE_MEM_DB_BACKEND=libsql` set.

**Risk:** test isolation. Tests that share a libSQL primary across `describe` blocks will see each other's writes. Either use one libSQL `:memory:` instance per test (cheap) or `DROP TABLE` between tests; do not rely on `:memory:` semantics matching `bun:sqlite` exactly.

---

### Step 6 — Remove `bun:sqlite` entirely (final cleanup PR)

**Goal:** Delete the parallel path. The codebase becomes single-backend.

**Files touched:**
- `src/services/sqlite/Database.ts` — delete `ClaudeMemDatabase` class, the `bun:sqlite` import, and the `CLAUDE_MEM_DB_BACKEND` flag. `DatabaseManager` instantiates `LibSqlDatabase` unconditionally (or, if the rename helps clarity, the class becomes just `Database`).
- Any remaining `import { Database } from 'bun:sqlite'` line — drop it.
- `package.json` — `bun:sqlite` is a Bun built-in, not a dependency; nothing to uninstall there. But if any optional/dev dep was installed *for* the bun-sqlite shim, drop it now.
- `CLAUDE.md` and any docs referencing `bun:sqlite` — update.

**Estimated time:** 0.5 day. All risk has already been amortized by the previous five steps; this is dead-code deletion.

**Verification:**
- `grep -rln "bun:sqlite" .` returns 0 outside `.scratch/`, `node_modules/`, and the changelog.
- `grep -rln "CLAUDE_MEM_DB_BACKEND" .` returns 0 outside `.scratch/`, the deleted commit, and changelog. Settings/env tables in docs no longer reference the flag.
- Full test suite green; full e2e smoke green.

**Risk:** an external consumer (a script you forgot, or a downstream Bun-only tool that imports from this package) still expects sync DB. Run `npm pack && tar tf <tarball> | xargs -I{} grep -l 'bun:sqlite' {}` (or equivalent) over the published files before merging.

---

## 3. Pinned values

When implementing 1B, use these exact values. Do not retry alternatives — the spike already paid for the comparison.

| Variable | Value | Source |
|---|---|---|
| SDK | `@libsql/client@0.17.3` | spike §1 |
| sqld image | `ghcr.io/tursodatabase/libsql-server:v0.24.8` | spike §2 |
| Health endpoint | `GET /health` returns 200 | spike §2 |
| Hrana HTTP API root | `GET /v2` returns "Hello, this is HTTP API v2 (Hrana over HTTP)" | spike §2 |
| Default DB filename inside sqld volume | `iku.db` (NOT `data.db`) | spike §5 #2 |
| Sidecar files written by embedded replicas | `.db-info`, `.db-wal`, `.db-shm`, `.db-client_wal_index` | spike §5 #6 |
| BigInt-typed fields | `lastInsertRowid` from `db.execute()`; raw rowid PKs returned via `RETURNING id` | spike §5 #4 |
| `db.execute()` result shape | `{ rows, columns, rowsAffected, lastInsertRowid }` | spike §1 |
| `db.transaction()` arg | `"write"` (or `"read"` / `"deferred"`) | `@libsql/client` types |
| Dev primary URL | `http://localhost:8080` | spike §2 |
| Production primary URL (placeholder) | `http://libsql.railway.internal:8080` (Phase 2) | plan §6 |
| Auth env var | `TURSO_AUTH_TOKEN` (signed JWT bearer) | plan §2 ADR-1 |
| Database URL env var | `TURSO_DATABASE_URL` | plan §5 task 4 |
| New backend flag | `CLAUDE_MEM_DB_BACKEND=libsql\|bun-sqlite` (default `bun-sqlite`) | this doc §2 Step 1 |
| Backend default during 1B | `bun-sqlite` (flag opt-in to libSQL) | this doc §2 Step 1 |
| Backend default after Step 6 | flag removed; libSQL only | this doc §2 Step 6 |
| Base image for containerized claude-mem | `node:20` glibc (NOT alpine/musl) | spike §5 #5 |

---

## 4. Common conversion patterns

Side-by-side mapping. When a method has multiple shapes, the table shows the common case and notes; refer to the spike for edge cases.

| `bun:sqlite` (current) | `@libsql/client` (target) | Notes |
|---|---|---|
| `db.prepare(sql).run(...args)` | `await db.execute({ sql, args })` | Check `result.rowsAffected` if you previously checked `result.changes`. |
| `db.prepare(sql).get(...args)` | `(await db.execute({ sql, args })).rows[0]` | Returns `undefined` if no row (libSQL returns an empty `rows` array — index `[0]` is `undefined`). |
| `db.prepare(sql).all(...args)` | `(await db.execute({ sql, args })).rows` | `rows` is a plain array of plain objects keyed by column name. No `.toArray()` needed. |
| `db.run(sql, ...args)` | `await db.execute({ sql, args })` | Same as `.prepare().run()`. |
| `db.query(sql).all(...args)` | `(await db.execute({ sql, args })).rows` | Bun-only `db.query` collapses to `db.execute`. |
| `db.exec(multiStatementSqlScript)` | `await db.executeMultiple(multiStatementSqlScript)` | Use for migrations / multi-statement DDL. Single statements should use `db.execute`. |
| `db.transaction(fn)` followed by `fn(...)` or `txFn()` call | `const tx = await db.transaction("write"); try { /* await tx.execute(...) */ await tx.commit(); } catch (e) { await tx.rollback(); throw e; }` | Tx methods (`tx.execute`, `tx.commit`, `tx.rollback`) are all async. No nested `db.transaction` returns; you build the body inline. |
| `result.lastInsertRowid` (number) | `Number(result.lastInsertRowid)` (BigInt → number) | `lastInsertRowid` is `BigInt` on libSQL — see gotcha #4 in §5. Cast at every use site. |
| `result.changes` | `result.rowsAffected` | Different field name. |
| `Number(row.id)` (where row came from `RETURNING id`) | `Number((row as any).id)` | The id column is `bigint` in libSQL's row decoding too — narrow with `Number(...)` before equality checks. |
| `:memory:` SQLite for tests | `createClient({ url: 'file::memory:' })` | Note the `file:` URL scheme — bare `:memory:` is bun:sqlite-specific. |
| `db.prepare(sql)` cached/reused across calls | inline the SQL into each `db.execute({ sql, args })` | libSQL plans queries server-side; the client doesn't expose a Statement object you can hold onto. Lifting the SQL string to a `const` outside the function is fine and recommended for readability. |

**Pattern for `RETURNING id` with dedup-by-content-hash:** see Step 2 example above. The `rows.length === 0` check replaces the `inserted === null` check, because `ON CONFLICT ... DO NOTHING RETURNING id` returns an empty row set on conflict, not a null row.

**Pattern for batch insert without per-row control flow:** `await db.batch([{ sql, args }, { sql, args }, ...])`. Faster than a loop of `db.execute` because it's one round-trip. Use this for `import/bulk.ts` and the Chroma backfill loops where conflict handling is uniform.

---

## 5. Gotchas not to relearn

Direct from `.scratch/spike-libsql-sdk.md` §5. Do not re-discover these.

1. **`:latest` GHCR tag is stale.** It points at v0.22.0 (May 2024). Always pin `v0.24.8` (or whatever stable tag is current at execution time — check GHCR).
2. **Default DB filename is `iku.db`, not `data.db`.** Plan §6 step 4 originally listed `SQLD_DB_PATH=/var/lib/sqld/data.db` — that's wrong for v0.24.8. Either set the full absolute path explicitly or accept the default `iku.db`.
3. **`@libsql/client` writes are synchronous gRPC round-trips to the primary.** If the primary is unreachable, writes throw immediately — no offline queueing. SessionEnd hooks must budget for primary-RTT or tolerate transient failures (catch, log to `~/.claude-mem/logs/sync.log`, exit 0). The plan's "create observations even when network is bad" rationale is invalidated by this; revisit only if `@tursodatabase/sync` ever clears self-hosted sqld.
4. **`lastInsertRowid` is `BigInt`.** Anywhere existing claude-mem code does `Number(row.id) === expected` will compare against a BigInt and silently mismatch. Cast at every site: `Number(result.lastInsertRowid)`. Run a typecheck pass after each conversion batch (`bun tsc --noEmit` or whatever the project uses).
5. **No musl prebuild for the `libsql` napi-rs binary.** Stick with glibc base images (`node:20-bullseye`/`-slim`). This matches the existing `docker/claude-mem/Dockerfile` already, so no change is needed; just don't switch to alpine in 1B "to save space."
6. **Embedded replicas write sidecar files.** `.db-info`, `.db-wal`, `.db-shm`, `.db-client_wal_index` next to the main file. The Phase 1A bootstrap script (`scripts/migrate-bun-sqlite-to-libsql.ts`) cleans stale sidecars before opening (see `cleanFiles` helper in `.scratch/spike-libsql/spike-test.mjs`). If you write any new tooling that opens a libSQL file, replicate that cleanup or you'll re-attach to a stale replication state.
7. **sqld v0.24.8 also binds gRPC on port 5001.** The Phase 1A docker-compose only forwards 8080 to the host, which is correct for the dev harness. Don't expose 5001 unless you need to test the gRPC interface (you don't, for 1B). For Railway private DNS in Phase 2, both ports are reachable on `*.railway.internal` and that's fine.

---

## 6. Test strategy for Phase 1B

The goal: keep the test suite green at every step boundary. Run-orders below are written for an actual contributor, not for CI configuration.

**Per-step local loop:**
- `docker compose -f containers/sync-host/dev-sqld/docker-compose.yml up -d`
- `until curl -sf http://localhost:8080/health > /dev/null; do sleep 1; done`
- `CLAUDE_MEM_DB_BACKEND=libsql bun test <file-or-dir-you-just-changed>`
- before pushing: `CLAUDE_MEM_DB_BACKEND=bun-sqlite bun test` (the original path must still pass until Step 6).
- `docker compose -f containers/sync-host/dev-sqld/docker-compose.yml down -v` when you're done (cleans the volume so the next run starts fresh).

**CI changes for 1B:**
- Bring up the dev sqld harness before `bun test`. The dev-sqld README (1A deliverable) has the exact incantation.
- Run the test suite twice during the parallel period: once with `CLAUDE_MEM_DB_BACKEND=bun-sqlite` (smoke that the legacy path still works) and once with `CLAUDE_MEM_DB_BACKEND=libsql` (the new path under test).
- After Step 6 lands, drop the `bun-sqlite` matrix entry and the `up -d` step becomes mandatory.

**Test taxonomy after Step 5:**
- **Unit tests using libSQL `:memory:`** — `createClient({ url: 'file::memory:' })`. Cheapest. Use these for any test that doesn't need primary-side replication semantics (the vast majority of unit tests).
- **Integration tests against the dev harness** — `createClient({ url: 'file:.test-replica.db', syncUrl: 'http://localhost:8080', authToken: '<dev token>' })`. Use these for anything that exercises sync semantics, replication, or the `db.sync()` boundary. Limit to the small handful of tests that genuinely need it.
- **Existing `bun:sqlite :memory:` tests** stay green until Step 6 (final cleanup PR). They get deleted then.

**Anti-patterns to avoid:**
- Don't run integration tests against a shared sqld primary that other dev workflows use — write isolation is hard. Use a per-test-suite primary (the docker harness is cheap to bring up/down).
- Don't extrapolate test perf to production. The `:memory:` libSQL client is fast; the real primary involves gRPC round-trips. Add a couple of explicit latency-budget tests against the harness for the SessionEnd hook path.

---

## 7. References

**In-repo (read these first):**
- `.scratch/sync-container-plan.md` — the full multi-device sync plan, post Phase 1A edits. §5 is Phase 1.
- `.scratch/spike-libsql-sdk.md` — SDK choice, sqld setup, gotchas. §1, §3, §5 are load-bearing for 1B.
- `.scratch/inventory-better-sqlite3.md` — call-site inventory, risk tiers, top-30 file table, transaction hotspots.
- `.scratch/post-mortem-2026-05-04.md` — prior libSQL+Xenova vector experiment failure. Read §6 (trade-offs) and §7 (recommendations) before any work that builds indexes or does bulk writes against libSQL.
- `.scratch/migration-audit.md` — perf audit from the vector experiment; some findings (WAL behavior under bulk-load, `wal_checkpoint(TRUNCATE)` timing) apply to 1B's bootstrap script and any similar bulk paths.

**In-repo (1A deliverables — verify these exist on disk before starting 1B; if any are missing, the orchestrator hasn't merged 1A yet):**
- `package.json` — `@libsql/client@0.17.3` listed under `dependencies`.
- `scripts/migrate-bun-sqlite-to-libsql.ts` — bootstrap data migration tool.
- `containers/sync-host/dev-sqld/docker-compose.yml` — dev harness.
- `containers/sync-host/dev-sqld/README.md` — harness usage.
- `scripts/claude-mem-sync` — deprecation banner present in lines 4-9.

**Relevant existing source (read for context, do not modify in 1A):**
- `src/services/sqlite/Database.ts` — current driver, future home of the async-shim adapter.
- `src/services/sqlite/transactions.ts` — current sync transactions (lines 16, 124 are the targets).
- `src/services/sqlite/SessionStore.ts` — the 309-call beast.
- `src/services/sqlite/migrations/runner.ts` — migration runner.

**External docs:**
- libSQL TS quickstart: https://docs.turso.tech/sdk/ts/quickstart
- Embedded replicas: https://docs.turso.tech/features/embedded-replicas/introduction
- libsql-client-ts repo (issues are useful for surprises): https://github.com/tursodatabase/libsql-client-ts
- sqld server: https://github.com/tursodatabase/libsql/tree/main/libsql-server
- sqld Docker docs: https://github.com/tursodatabase/libsql/blob/main/docs/DOCKER.md

**Plan anti-patterns and risks to re-read before starting 1B:**
- `.scratch/sync-container-plan.md` §4 anti-pattern #2 — "Don't keep `bun:sqlite` *and* `@libsql/client` in parallel." 1B Step 1 violates this **deliberately and time-boxed**, with the env flag forcing a short observable parallel period. Step 6 closes the violation.
- `.scratch/sync-container-plan.md` §10 risk #1 — "libSQL async migration is bigger than estimated." Already realized; 1B's 4-week estimate is the corrected number.
- `.scratch/sync-container-plan.md` §10 risk #3 — sqld WAL growth under sustained writes. 1B's bootstrap path (Step 1A's `scripts/migrate-bun-sqlite-to-libsql.ts`) writes 77k+ observations to a fresh primary; budget for WAL pressure and run `PRAGMA wal_checkpoint(TRUNCATE)` after the bootstrap. See post-mortem §7 recommendation #1.

---

## 8. Sequencing and reviewability summary

The intended PR sequence (one row = one PR):

| Order | Title | Scope | Time |
|---|---|---|---|
| 1B-1 | feat(db): async-shim adapter + `CLAUDE_MEM_DB_BACKEND` flag | `Database.ts`, shared interface, smoke test | 0.5-1 day |
| 1B-2 | feat(db): convert `transactions.ts` hotspots | `transactions.ts`, `transactions.test.ts` | 0.5 day |
| 1B-3 | feat(db): async migrations runner | `migrations/runner.ts`, `migrations.ts`, related tests | 1-1.5 days |
| 1B-4 | feat(db): SessionStore async cutover | `SessionStore.ts` + tests | 3-4 days |
| 1B-5 | feat(db): worker HTTP routes async | 5 route files + tests | 3-4 days |
| 1B-6 | feat(db): search layer async | `SearchManager.ts`, `SessionSearch.ts` + tests | 1-2 days |
| 1B-7 | feat(db): worker support files async | `SessionManager.ts`, `PaginationHelper.ts`, `RateLimitStore.ts`, `worker-service.ts` + tests | 2-3 days |
| 1B-8 | feat(db): utilities + sync layer async | `ChromaSync.ts`, infrastructure files, observation/session/summary helpers | 2-3 days |
| 1B-9 | feat(db): tests, scripts, plugin, openclaw | 47 test files (most updated in earlier PRs as we went; this is the residual sweep), external scripts, plugin/scripts, openclaw | 3-5 days |
| 1B-10 | chore(db): remove `bun:sqlite` path | dead-code deletion, doc updates | 0.5 day |

Total: roughly 4 weeks of focused work, matching the corrected estimate. The PRs after 1B-3 can in principle parallelize across contributors (different files), but they all depend on 1B-1 landing first.

---

**Open the next session with:**

1. Pull `feat/libsql-migration` and verify the 1A deliverables are present (§7 checklist).
2. `docker compose -f containers/sync-host/dev-sqld/docker-compose.yml up -d` and confirm `curl http://localhost:8080/health` returns 200.
3. Read this document §1, §2 Step 1, §4, §5.
4. Start 1B-1.
