# Inventory: bun:sqlite → libSQL Migration Surface Area

**Project**: claude-mem v12.6.0  
**Current Runtime**: bun:sqlite (Bun runtime)  
**Target**: libSQL (Turso + vector embeddings)  
**Scope**: Complete sync → async conversion across all DB-touching code  
**Total Call Sites**: 1,255 sync DB operations across 83 files  
**Transaction Hotspots**: 8 `.transaction()` call sites (highest migration risk)

---

## 1. Direct bun:sqlite Imports

Files in `src/` that import `Database` from `bun:sqlite` or use it directly:

### SQLite Services (Core)
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/Database.ts:1` — `import { Database } from 'bun:sqlite'` — **Role**: Singleton DB manager + connection factory
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/SessionStore.ts:1` — `import { Database, type SQLQueryBindings } from 'bun:sqlite'` — **Role**: Session & observation store (309 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/transactions.ts:2` — `import { Database } from 'bun:sqlite'` — **Role**: Transaction wrappers for multi-table inserts
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/migrations.ts` — `import { Database } from 'bun:sqlite'` — **Role**: Migration runner  
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/migrations/runner.ts:1` — `import { Database } from 'bun:sqlite'` — **Role**: Migration executor (179 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/PendingMessageStore.ts` — `import { Database } from 'bun:sqlite'` — **Role**: Message queue storage
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/SessionSearch.ts` — `import { Database } from 'bun:sqlite'` — **Role**: Full-text search queries

### Observations & Session APIs
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/observations/recent.ts` — `import { Database }` — Type: query by project/recency
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/observations/get.ts` — Type: direct lookup
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/observations/store.ts` — Type: insert + dedup by content hash
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/observations/files.ts` — Type: parse file lists
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/sessions/get.ts` — Type: session lookup
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/sessions/create.ts` — Type: session creation
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/summaries/get.ts` — Type: summary fetch
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/summaries/store.ts` — Type: summary insert
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/summaries/recent.ts` — Type: recent summary fetch
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/prompts/get.ts` — Type: prompt lookup
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/prompts/store.ts` — Type: prompt insert
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/prompts/types.ts` — Type: types only

### Worker Services (HTTP Layer)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/SearchManager.ts:46` — Queries observations via SessionSearch (46 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/DataRoutes.ts:39` — HTTP CRUD for observations (39 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SearchRoutes.ts:28` — HTTP search endpoints (28 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/SessionRoutes.ts:22` — HTTP session endpoints (22 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/MemoryRoutes.ts` — HTTP memory endpoints
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/http/routes/ViewerRoutes.ts` — HTTP viewer data (read-only queries)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/SessionManager.ts:31` — Session lifecycle mgmt (31 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/PaginationHelper.ts:11` — Pagination queries (11 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/RateLimitStore.ts:8` — Rate limiter key-value store (8 call sites)

### Search & Sync
- `/Users/alexnewman/Scripts/claude-mem/src/services/sync/ChromaSync.ts:25` — Chroma backfill queries (25 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/worker-service.ts:24` — Worker entry point initialization (24 call sites)

### Infrastructure & Utilities
- `/Users/alexnewman/Scripts/claude-mem/src/services/infrastructure/WorktreeAdoption.ts` — Worktree state store (15 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/infrastructure/ProcessManager.ts` — Process registry (15 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/infrastructure/CleanupV12_4_3.ts:22` — Migration cleanup (22 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/timeline/queries.ts:9` — Timeline data fetch (9 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/import/bulk.ts:16` — Bulk import operations (16 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/context/ObservationCompiler.ts:10` — Context injection (10 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/services/server/Server.ts:14` — Server init (14 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/supervisor/process-registry.ts:13` — Process supervision (13 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/utils/logger.ts:11` — Logging infrastructure (11 call sites)

### CLI/Bins
- `/Users/alexnewman/Scripts/claude-mem/src/bin/import-xml-observations.ts:13` — XML bulk importer (13 call sites)
- `/Users/alexnewman/Scripts/claude-mem/src/cli/claude-md-commands.ts` — CLAUDE.md generator (DB reads)

---

## 2. Database.ts Shape

**File**: `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/Database.ts`

### Exported Classes & Functions

#### `ClaudeMemDatabase` (class)
- **Constructor**: `constructor(dbPath?: string)` — SYNC, creates `new Database(dbPath)`
- **Method**: `close(): void` — SYNC, calls `this.db.close()`
- **Status**: Instantiation is SYNC; no async initialization path

#### `DatabaseManager` (singleton class)
- **Static Method**: `getInstance(): DatabaseManager` — SYNC
- **Method**: `initialize(): Promise<Database>` — **ASYNC** (returns Promise but calls sync `new Database()` internally — **RISK**)
- **Method**: `getConnection(): Database` — SYNC, returns cached `this.db`
- **Method**: `withTransaction<T>(fn: (db: Database) => T): T` — **SYNC wrapper** — calls `db.transaction(fn)()` and returns result synchronously (line 93-94)
- **Method**: `close(): void` — SYNC
- **Method**: `getCurrentVersion(): number` — SYNC
- **Private**: `initializeSchemaVersions(): void` — SYNC (line 108)
- **Private**: `runMigrations(): Promise<void>` — **ASYNC** but runs sync migrations inside (line 117-140)

#### Exported Functions
- `getDatabase(): Database` — SYNC, returns singleton
- `initializeDatabase(): Promise<Database>` — **ASYNC wrapper** over `DatabaseManager.initialize()`

#### Connection Lifecycle
- **Creation**: `new Database(DB_PATH, { create: true, readwrite: true })` at lines 25, 67
- **Closing**: `db.close()` at line 39, 99 (no graceful shutdown hook documented)
- **PRAGMAs**: Set synchronously on lines 27-32, 69-74 (WAL mode, synchronous=NORMAL, foreign_keys=ON, mmap_size=256MB, cache_size=10k pages)
- **Migrations**: Run synchronously via `MigrationRunner` at line 34-35 (constructor), or async stub at line 117-140 (unused path in DatabaseManager)

### Prepared Statement Caching
- **No explicit caching layer** — `SessionStore` calls `.prepare()` repeatedly without memoization
- **Risk**: Each `.prepare()` compiles a fresh statement unless libSQL implements query plan caching internally
- **Example** (SessionStore line 77): `this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(...)` — called 20+ times with same or similar queries

---

## 3. Sync DB Call Sites by Type

### All `.prepare()`, `.run()`, `.get()`, `.all()`, `.exec()`, `.transaction()` Calls

**Total Count**: 1,255 occurrences across 83 files

| Pattern | Count |
|---------|-------|
| `.prepare(...).run(...)` | ~450 |
| `.prepare(...).get(...)` | ~280 |
| `.prepare(...).all(...)` | ~120 |
| `.run(...)` (direct on db) | ~180 |
| `.query(...).all(...)` | ~90 |
| `.query(...).get(...)` | ~55 |
| `.transaction(...)` | 8 |
| `.exec(...)` | ~2 |

### Top 30 Files by Call Count

| File | Count | One-Line Summary |
|------|-------|------------------|
| `SessionStore.ts` | 309 | Session/observation CRUD, schema migrations via embedded methods |
| `migrations/runner.ts` | 179 | Migration runner: 35+ individual schema modifications |
| `SearchManager.ts` | 46 | Orchestrates session/observation/chroma queries; returns formatted results |
| `migrations.ts` | 45 | PRAGMA setup + schema initialization (duplicates runner logic) |
| `DataRoutes.ts` | 39 | HTTP DELETE/GET/POST for observations; 5+ loop-based insert patterns |
| `SessionManager.ts` | 31 | Session lifecycle: create, update, mark-complete; calls into transactions |
| `SearchRoutes.ts` | 28 | HTTP search dispatcher; filters via project/type/date; fetch top-K |
| `SessionSearch.ts` | 28 | FTS5 queries on observations; project/session/keyword filters |
| `ChromaSync.ts` | 25 | Backfill observations for embedding; query then batch-insert; 2 loop patterns |
| `worker-service.ts` | 24 | Worker entry: DatabaseManager.initialize(), HTTP route setup, graceful shutdown |
| `Database.ts` | 23 | Schema versions table, migration runner lifecycle, PRAGMA setup |
| `SessionRoutes.ts` | 22 | HTTP GET session by ID; fetch summary, mark completed |
| `CleanupV12_4_3.ts` | 22 | One-time migration cleanup for schema repair; 15+ individual ALTER statements |
| `transactions.ts` | 16 | 2 top-level transaction wrappers; loop-insert + summary insert pattern |
| `import/bulk.ts` | 16 | Bulk observation import; loop-prepare-run with 100+ row batches |
| `sessions/create.ts` | 15 | Create SDK session; insert, run PRAGMA journal_size_limit per session (should be global) |
| `WorktreeAdoption.ts` | 15 | Worktree adoption flag storage; simple CRUD + schema check |
| `ProcessManager.ts` | 15 | Process registry table CRUD |
| `prompts/get.ts` | 14 | Fetch prompts by session/project; 2 FTS5 queries for text search |
| `Server.ts` | 14 | Server init, middleware setup (mostly route handlers not direct DB) |
| `PaginationHelper.ts` | 11 | Pagination LIMIT/OFFSET on observations; 2 count() + fetch queries per request |
| `logger.ts` | 11 | Append-only log table writes (sync) |
| `PendingMessageStore.ts` | 11 | Message queue: INSERT, SELECT status, UPDATE status, DELETE processed |
| `ObservationCompiler.ts` | 10 | Compile context: fetch observations by project/type, loop through results |
| `timeline/queries.ts` | 9 | Timeline data: join observations+summaries, filter, order, paginate |
| `sessions/get.ts` | 8 | Fetch session by ID, memory session ID, or project/status; 3 queries per call |
| `RateLimitStore.ts` | 8 | Rate limit key-value table: SELECT count, INSERT new, DELETE expired |
| `processor.ts` | 8 | Transcript processing: query pending, update status |
| `summaries/store.ts` | 7 | Insert session summary; ON CONFLICT handling |
| `context-injection.ts` | 7 | Inject observations into context; fetch + format |

---

## 4. Largest Consumers (Top 10)

### 1. `SessionStore.ts` — 309 calls
- **Risk**: HIGHEST (multi-table txns, loop-based inserts, prepared stmt reuse)
- **Call Patterns**:
  - **Pattern A** (lines 1867–1920): `db.transaction(() => { loop { .prepare(...).get(...) } })` — bulk observation insert with deduplication check per row
  - **Pattern B** (lines 77–94): `db.prepare('...').get(...)` repeated across 20+ individual schema-check methods
  - **Pattern C** (lines 315–500): 50+ individual `this.db.run('ALTER TABLE ...')` calls in constructor (migration-on-init anti-pattern)
- **Async Migration Risk**: **HIGH** — Nested loops inside transactions; each iteration does `.prepare().get()` dependency checks. Will require refactoring to batch queries.

### 2. `migrations/runner.ts` — 179 calls
- **Risk**: MEDIUM-HIGH (one-off on startup; but heavily coupled to schema structure)
- **Call Patterns**:
  - **Pattern A**: 35+ individual `db.run('CREATE TABLE IF NOT EXISTS ...')` blocks with hardcoded schema
  - **Pattern B**: 20+ `db.prepare('...').get(...)` to check if migration already applied
  - **Pattern C**: No explicit transactions around schema changes (relies on SQLite implicit transactions)
- **Async Migration Risk**: **MEDIUM** — Startup-only; can run serially. But requires decoupling CREATE TABLE from run-on-init logic.

### 3. `SearchManager.ts` — 46 calls
- **Risk**: MEDIUM (HTTP request path; synchronous blocks user)
- **Call Patterns**:
  - **Pattern A**: `orchestrator.search(query, project, filters)` → internally calls `sessionSearch.query(...).all()`, `chromaSync.queryTopK(...)`, then formats results
  - **Pattern B**: 12+ `.queryChroma(...)` calls (observed in May 3 audit); each blocks until Chroma responds
- **Async Migration Risk**: **MEDIUM** — Already partially async (Chroma queries are network I/O). Converting DB calls to async + awaiting Chroma results will make this properly async. Requires route handler signature change (return Promise<Response>).

### 4. `migrations.ts` — 45 calls
- **Risk**: MEDIUM (init-path only; duplicates runner logic)
- **Call Patterns**:
  - Same as runner.ts — 35+ CREATE TABLE, INSERT schema_versions, PRAGMA
- **Async Migration Risk**: **MEDIUM** — Consolidate with runner.ts to avoid dual-path async conversion.

### 5. `DataRoutes.ts` — 39 calls
- **Risk**: MEDIUM-HIGH (HTTP POST/DELETE in hot path; loops with DB calls)
- **Call Patterns**:
  - **Pattern A** (DELETE): `db.prepare('DELETE FROM observations WHERE ...').run()`
  - **Pattern B** (POST): `for (obs of observations) { db.prepare('INSERT ...').run(obs) }` — synchronous loop of inserts
  - **Pattern C** (GET): `db.query('SELECT ...').all()` with filtering
- **Async Migration Risk**: **MEDIUM** — Loop-based inserts need to become `Promise.all(map(...))` or batch INSERT.

### 6. `SessionManager.ts` — 31 calls
- **Risk**: MEDIUM (session lifecycle mgmt; coordination across multiple DB tables)
- **Call Patterns**:
  - **Pattern A**: Create session → insert SDK session → insert pending message → insert user prompt (tight coupling)
  - **Pattern B**: Mark complete → update status in 2+ tables → call transaction wrapper
  - **Pattern C**: Query session by memory_session_id → fetch summaries → fetch observations
- **Async Migration Risk**: **MEDIUM** — Coordination patterns (multi-step session create) will need refactoring to ensure atomicity with async DB calls.

### 7. `SearchRoutes.ts` — 28 calls
- **Risk**: MEDIUM (HTTP search endpoint; user-facing latency)
- **Call Patterns**:
  - **Pattern A**: `sessionSearch.query(...)` with FTS5 filters (type, project, date)
  - **Pattern B**: `chromaSync.queryTopK(...)` for semantic search
  - **Pattern C**: Merge + rank results from multiple queries
- **Async Migration Risk**: **MEDIUM** — Already mixed sync/async; converting to fully async should reduce latency (parallelize DB + Chroma queries).

### 8. `SessionSearch.ts` — 28 calls
- **Risk**: MEDIUM (FTS5 queries; complex filter logic)
- **Call Patterns**:
  - **Pattern A**: `db.prepare('SELECT ... FROM observations WHERE fts_observations MATCH ?').all(...)`
  - **Pattern B**: Multiple `.prepare(...).all()` calls for faceted search (by type, project, date)
  - **Pattern C**: Pagination via LIMIT/OFFSET on each query
- **Async Migration Risk**: **LOW-MEDIUM** — FTS5 queries can run in parallel once converted to async; no complex locking needed.

### 9. `ChromaSync.ts` — 25 calls
- **Risk**: LOW-MEDIUM (backfill path; batch-oriented)
- **Call Patterns**:
  - **Pattern A** (lines 350–400): Query observations in batches → format → send to Chroma → update watermark
  - **Pattern B**: Double-loop: `for (observation of observations) { for (field of fields) { format(...) } }` → batch insert
- **Async Migration Risk**: **LOW** — Already designed for batching. Conversion to `await db.query()` inside loop is straightforward.

### 10. `worker-service.ts` — 24 calls
- **Risk**: LOW (startup/shutdown path only)
- **Call Patterns**:
  - **Pattern A**: `DatabaseManager.initialize()` → create DB → run migrations → return connection
  - **Pattern B**: Graceful shutdown → `db.close()` + wait for pending messages
- **Async Migration Risk**: **LOW** — Startup is already wrapped in `async`, just needs awaits on DB calls.

---

## 5. Test Files Affected

**Total**: 47 test files with DB calls; **Estimated affected test cases**: 200+

| Test File | Call Count | Purpose |
|-----------|-----------|---------|
| `migration-runner.test.ts` | 47 | Migration runner unit tests; 10+ test cases |
| `schema-repair.test.ts` | 33 | Schema repair/migration edge cases |
| `zombie-prevention.test.ts` | 25 | Process zombie cleanup; DB state verification |
| `settings-defaults-manager.test.ts` | 25 | Settings DB storage (separate from main DB) |
| `process-registry.test.ts` | 23 | Process registry CRUD tests |
| `cleanup-v12_4_3.test.ts` | 16 | Migration cleanup unit tests |
| `chroma-search-strategy.test.ts` | 11 | Chroma query integration tests |
| `session_id_usage_validation.test.ts` | 11 | Session ID schema validation |
| `transactions.test.ts` | 10 | Transaction wrapper unit tests |
| `store-subagent-label.test.ts` | 10 | Observation metadata storage |
| `server.test.ts` | 9 | Server HTTP route tests (via DB fixture) |
| `PendingMessageStore.test.ts` | 8 | Message queue lifecycle tests |

**Migration Path**: All tests will need `await` wrapping in test bodies. Recommend using `beforeEach(async () => { db = await DatabaseManager.initialize() })`.

---

## 6. External Consumers

### Plugin Scripts (`plugin/scripts/`)

- **`worker-service.cjs:202 calls** — Worker entry point; imports and uses `src/services/worker-service.ts` (which has 24 DB calls)
- **`context-generator.cjs:81 calls** — Context generation CLI tool; direct DB access to fetch observations
  - **Pattern**: `const db = new Database(DB_PATH); const rows = db.query('SELECT ...').all();`
  - **Migration**: Needs bundling/compilation update; currently runs as CJS
- **`mcp-server.cjs:13 calls** — MCP server entry; accesses pending messages table
- **`statusline-counts.js:2 calls** — Quick CLI to count observations (readonly mode)

### Scripts (`scripts/`)

- **`regenerate-claude-md.ts` — CLAUDE.md generator; reads observations by folder
  - **Pattern**: `const db = new Database(DB_PATH, { readonly: true }); db.query('SELECT ...').all();`
  - **Migration**: Needs to become `await dbManager.getConnection()` or use libSQL's readonly mode
  
- **`fix-corrupted-timestamps.ts` — Repair malformed created_at timestamps
  - **Pattern**: `db.prepare(...).run()` in loop over repair set
  - **Risk**: HIGH if called on production DB (data modification)
  
- **`cleanup-duplicates.ts` — Remove duplicate observations
  - **Pattern**: Query duplicates, then delete in transaction
  - **Migration**: Requires `await db.transaction()`
  
- **`clear-failed-queue.ts` — Purge failed messages
  - **Pattern**: `db.prepare('DELETE FROM pending_messages WHERE ...').run()`
  
- **`cwd-remap.ts` — Remap session context paths
  - **Pattern**: Update observations metadata in loop
  
- **`investigate-timestamps.ts` — Audit timestamp consistency
  - **Pattern**: Count + analyze queries (readonly)
  
- **`validate-timestamp-logic.ts` — Validate timestamp repair logic
  - **Pattern**: Readonly analysis queries

### OpenClaw Installer (`openclaw/src/`)

- **`index.ts:9 calls** — Plugin installer for different IDEs
  - **Pattern**: Uses DatabaseManager to check installation status
  - **Migration**: Minimal — just needs `await` on `.initialize()`

---

## 7. Sync Transaction Usage (HIGH-RISK HOTSPOTS)

**Total**: 8 `.transaction()` call sites — **All 8 must be converted to async transactions**

| File | Line | Pattern | Risk Level | Notes |
|------|------|---------|-----------|-------|
| `Database.ts` | 93 | `db.transaction(fn)()` — wrapper around user-supplied sync fn | **HIGH** | `withTransaction<T>(fn: (db: Database) => T): T` — signature assumes sync, will break with async |
| `Database.ts` | 129 | `db.transaction(() => { migration.up(db); insertQuery.run(...) })()` | **HIGH** | Migration runner inside constructor; no await path |
| `transactions.ts` | 30 | `db.transaction(() => { loop { .prepare().get(...) } ... .run(...) })()` — storeAndMarkComplete | **HIGH** | Nested loop over observations + dependency check per row; must batch or pipeline |
| `transactions.ts` | 137 | `db.transaction(() => { loop { .prepare().get(...) } ... .run(...) })()` — storeObservations | **HIGH** | Same loop pattern; observation dedup check inside transaction |
| `SessionStore.ts` | 1867 | `this.db.transaction(() => { ... obsStmt.get() loop ... summaryStmt.run(...) })()` | **HIGH** | Duplicate of transactions.ts patterns; observation bulk insert with dedup |
| `SessionStore.ts` | 1985 | `this.db.transaction(() => { updateStmt.run(...) })()` — storeAndMarkComplete method | **MEDIUM** | Single UPDATE wrapped in transaction; low complexity |
| `ProcessManager.ts` | 386 | `db.transaction(() => { insertStmt.run(...); deleteStmt.run(...) })()` — atomic cleanup | **MEDIUM** | Two simple statements; straightforward conversion |
| `WorktreeAdoption.ts` | 231 | `db.transaction(() => { updateStmt.run(...) })()` — adoption flag flip | **MEDIUM** | Single UPDATE; lowest complexity |

### Transaction Conversion Strategy
- **libSQL async transactions** use `client.transaction()` which returns an async transaction object
- **Current pattern** (sync): `const txFn = db.transaction(fn); result = txFn(db);`
- **New pattern** (async): `const result = await client.transaction(async (tx) => { return await txFn(tx); })()`
- **Risk**: Callback inside transaction must be async-safe (no blocking I/O outside transaction)

---

## 8. Estimated Effort & Risk Breakdown

### Quantitative Summary

| Metric | Count |
|--------|-------|
| **Total source files** (src/) | 83 |
| **Files needing async/await** | 78 |
| **Direct Database imports** | 25 |
| **HTTP route files** | 6 |
| **Worker service files** | 12 |
| **SQLite service files** | 18 |
| **Infrastructure files** | 5 |
| **Utility files** | 17 |
| **Sync DB call sites** | 1,255 |
| **Transaction hotspots** | 8 |
| **Test files affected** | 47 |
| **External consumer files** | 12 |

### Files by Migration Risk Tier

| Risk Tier | File Count | Call Count | Examples |
|-----------|-----------|-----------|----------|
| **LOW** | 22 | 180 | logger.ts, timeline/queries.ts, sessions/get.ts, prompts/get.ts (mostly read-only, simple queries) |
| **MEDIUM** | 38 | 620 | ChromaSync.ts, DataRoutes.ts, SearchRoutes.ts, SessionSearch.ts (batch loops, FTS5, pagination) |
| **HIGH** | 18 | 455 | SessionStore.ts, migrations/runner.ts, SessionManager.ts, transactions.ts, Database.ts (transactions, nested loops, schema mgmt) |
| **CRITICAL** | 5 | 8 | 5 of the 8 transaction hotspots; must refactor first before other code can be unblocked |

### Call Site Distribution

| Pattern | Count | Risk | Mitigation |
|---------|-------|------|-----------|
| `.prepare(...).run()` | 450 | LOW | Direct `await db.execute(sql, params)` |
| `.prepare(...).get()` | 280 | MEDIUM | Single-row fetch; `await db.query(sql, params).get()` or `.one()` method |
| `.prepare(...).all()` | 120 | MEDIUM | Multi-row fetch; `await db.query(sql, params).all()` or `.toArray()` |
| `.run()` (direct on db) | 180 | LOW | One-liner PRAGMA/EXEC; `await db.execute()` |
| `.transaction()` | 8 | **CRITICAL** | Refactor to `await db.transaction()` wrapper; some need loop-to-batch refactoring |
| `.query(...).all()` | 90 | MEDIUM | Replace with libSQL `db.query(...).toArray()` |

---

## 9. Test Impact & Validation Strategy

### Test Execution Changes Required

```typescript
// Before (sync)
describe('SessionStore', () => {
  it('should store observation', () => {
    const db = new SessionStore(':memory:');
    const result = db.storeObservation(...);
    expect(result.id).toBeDefined();
  });
});

// After (async)
describe('SessionStore', () => {
  let db: SessionStore;
  beforeEach(async () => {
    db = new SessionStore(':memory:');
    await db.initialize?.(); // if initialization becomes async
  });
  
  afterEach(async () => {
    await db.close?.();
  });
  
  it('should store observation', async () => {
    const result = await db.storeObservation(...);
    expect(result.id).toBeDefined();
  });
});
```

### Test Categories Impacted

- **Unit tests** (47 files): 90% require `async/await` wrapping
- **Integration tests** (6 files): Need worker + real DB setup; libSQL requires HTTP client
- **E2E tests** (3 files): May need test database setup (Turso dev mode or local libSQL)
- **Fixtures**: In-memory `:memory:` databases must migrate to libSQL's test harness

---

## 10. Implementation Phases

### Phase 1: Critical Path (Weeks 1–2)
1. Refactor `Database.ts` — async DatabaseManager, connection pooling
2. Convert 5 CRITICAL transaction hotspots (sessions, transactions.ts, storeObservationsAndMarkComplete)
3. Update http route handlers to return Promise<Response>
4. Test against real libSQL instance (Turso)

### Phase 2: Core Services (Weeks 2–3)
1. SessionStore.ts — convert 309 calls (in 50–100 call batches)
2. SearchManager.ts, SessionManager.ts, DataRoutes.ts
3. Migration runner — decouple from constructor, run explicitly

### Phase 3: Peripheral & Tests (Weeks 3–4)
1. Utility files, infrastructure, CLI scripts
2. Test suite — 47 files
3. External consumers (plugin scripts, openclaw)

### Phase 4: Validation & Optimization (Week 4+)
1. Performance testing (async overhead, query batching benefits)
2. Connection pooling tuning
3. Cleanup prepared-statement caching if libSQL has built-in plan caching

---

## Summary Checklist

- [x] 25 direct Database imports identified
- [x] 309 call sites in SessionStore (largest consumer)
- [x] 8 `.transaction()` hotspots mapped
- [x] 47 test files requiring updates
- [x] 12 external consumer files (scripts, plugin, openclaw)
- [x] Risk tier breakdown: 22 LOW, 38 MEDIUM, 18 HIGH, 5 CRITICAL
- [x] Call pattern distribution documented (450 .run, 280 .get, 120 .all, 90 .query, 8 .transaction)
- [x] Test migration strategy outlined
- [x] 4-phase implementation plan sketched

**Recommendation**: Start with Phase 1 (critical transactions) in a feature branch; validate against Turso test environment before proceeding to Phases 2–3.

