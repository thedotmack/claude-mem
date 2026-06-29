# cmem-sdk: Embeddable claude-mem I/O on the Server (Postgres) Runtime + `server-beta` → `server` Rename

Status: implementation plan
Date: 2026-05-25
Release target: claude-mem 13.x — `claude-mem/sdk` export
Relationship to prior plans:

- Builds on `plans/2026-05-07-server-beta-independent-bullmq-observation-runtime.md` and `plans/2026-05-07-claude-mem-server-apache-bullmq-team-auth.md` (the Postgres "server" runtime).
- Completes the deferred SDK export slot added in commit `ae454cfc` ("feat: add SDK exports for consumer app integration") — that commit added `exports["."]` and `exports["./sdk"]` to `package.json` but never added `src/index.ts`, never added `src/sdk/index.ts`, and never added a build step that emits them.
- Removes the "beta" tag from the server runtime because the literal string `server-beta` is the source of silent runtime regressions (see Phase 1).

## Executive Decision

The cmem-sdk is **not a new system**. It is the existing in-process **server** runtime (`src/server/*` + `src/storage/postgres/*` + the existing `src/services/sync/*` Chroma engine) **exposed as an importable library with the HTTP/daemon/Redis shell removed**. Everything the SDK needs already exists and is already daemon-free at its core; the SDK is composition + packaging, plus one careful rename.

```
consumer app
  └─ import { createCmemClient } from 'claude-mem/sdk'
       ├─ Postgres (pg)         ← system of record (capture, observations, sessions, jobs)  [src/storage/postgres/*]
       ├─ in-process generation ← provider.generate() (fetch) → parseAgentXml → processGeneratedResponse  [src/server/generation/*]
       ├─ Chroma (REQUIRED)     ← semantic index over the SAME observations, via uvx chroma-mcp subprocess  [src/services/sync/*]
       └─ search                ← Chroma semantic (primary). Postgres FTS exists only as a runtime safety net when Chroma transiently fails — it is NOT a feature toggle.  [src/storage/postgres/observations.ts]
```

**Chroma is not optional.** claude-mem without semantic search is broken — observations are unsearchable in the way users actually search them. The SDK MUST initialize and verify Chroma at construction; if `uvx chroma-mcp` cannot start, `createCmemClient(...)` rejects. The Postgres FTS path is preserved only to mirror `SearchManager.ts:255`'s runtime resilience pattern (transient Chroma death mid-session); it is logged loudly when used and is not exposed as a user-configurable mode.

What the SDK **must not** pull in: Express, BullMQ, ioredis/Redis, better-auth, the HTTP routes, the daemon/pidfile lifecycle, the worker's `bun:sqlite` storage, or the Claude Code subprocess generation path. All of these are the *shell* around the reusable core.

The wiring hub to study is `createServerBetaService()` (`src/server/runtime/create-server-beta-service.ts:156`). It already builds exactly the object graph the SDK wants (pool → schema bootstrap → repositories), then attaches the parts the SDK drops (HTTP service, queue manager, generation worker). The SDK reproduces the *graph*, not the *service*.

## Terminology Decision (inherited, enforced)

- The domain object is an **observation**, never "memory". Keep `observations`, `observation_sources`, `PostgresObservationRepository`, `/v1/observations`. `/v1/memories` and `memory_*` MCP tools are aliases only.
- The runtime is **`server`** (this plan), never "server-beta". `worker` remains the legacy SQLite runtime.
- The public client is **`CmemClient`**, constructed by **`createCmemClient(...)`**, imported from **`claude-mem/sdk`**.

---

## Phase 0: Documentation Discovery

### Local sources read (with what each established)

| Source | Established |
|---|---|
| `src/server/runtime/create-server-beta-service.ts` | The wiring hub. Graph = pool + `bootstrapServerBetaPostgresSchema` + `createPostgresStorageRepositories`; queue manager **disabled** unless `CLAUDE_MEM_QUEUE_ENGINE=bullmq` (`:255-263`); generation worker **disabled** unless queue active + provider configured (`:195-216`). Env-driven provider build at `:218-247`. |
| `src/storage/postgres/index.ts` | `createPostgresStorageRepositories(client: PostgresQueryable)` `:39` returns all repos. |
| `src/storage/postgres/pool.ts` | `createPostgresPool(config)` `:13`, `getSharedPostgresPool({requireDatabaseUrl})` `:24`, `withPostgresTransaction(pool, fn)` `:45`. |
| `src/storage/postgres/config.ts` | `parsePostgresConfig()` `:26`, reads `CLAUDE_MEM_SERVER_DATABASE_URL` (the only connection var) + pool/SSL tuning. |
| `src/storage/postgres/schema.ts` | `bootstrapServerBetaPostgresSchema(client)` `:22` — idempotent in-process migration runner, no extensions, no pgvector. `observations` table DDL `:212-227`: `content TEXT`, `content_search TSVECTOR GENERATED ALWAYS`, `embedding JSONB` (nullable, **unused**), GIN index `:274`. |
| `src/storage/postgres/observations.ts` | `create(...)` `:72`, `search({projectId, teamId, query, limit})` `:153` (FTS via `websearch_to_tsquery` + `ts_rank`), `getByIdForScope` `:120`, `listByProject` `:133`. **No vector search.** `embedding` is written-only-if-passed, never read. |
| `src/storage/postgres/agent-events.ts` | `PostgresAgentEventsRepository.create(input)` `:63`, `CreatePostgresAgentEventInput` `:31`. |
| `src/storage/postgres/generation-jobs.ts` | `create(...)` `:101`, `transitionStatus({status})` `:164` (legal transitions only — `queued→processing→completed`; **`queued→completed` is illegal**, `:390`). |
| `src/storage/postgres/server-sessions.ts` / `projects.ts` / `teams.ts` | Session/project/team repos. Projects have `create({teamId,name})` `:27` + `getByIdForTeam(id,teamId)` `:46` — **no lookup-by-name** (tenancy bootstrap implication, see Phase 3). |
| `src/server/services/IngestEventsService.ts` | `ingestOne(input,{generate})` `:96` writes agent_event + generation_job outbox in one tx; `resolveEventQueue: () => null` (`IngestEventsServiceOptions` `:64`) makes BullMQ enqueue a no-op (`enqueueState='queued_only'`). |
| `src/server/generation/providers/shared/types.ts` | `ServerGenerationProvider.generate(context, signal?)` `:30`; `ServerGenerationContext` `:9` = `{job, events, project:{projectId,teamId,serverSessionId,projectName}}`; `ServerGenerationResult` `:23` = `{rawText, modelId?, providerLabel, tokensUsed?}`. |
| `src/server/generation/providers/ClaudeObservationProvider.ts` | `constructor({apiKey, model?, maxOutputTokens?, fetchImpl?})` `:32`; plain `fetch` to `https://api.anthropic.com/v1/messages` `:69`. **No `@anthropic-ai/claude-agent-sdk`, no subprocess.** Default model `claude-3-5-sonnet-latest` `:17`. (Gemini/OpenRouter siblings: same shape.) |
| `src/server/generation/processGeneratedResponse.ts` | `processGeneratedResponse({pool, job, rawText, modelId, providerLabel, ...})` `:62` and `processSessionSummaryResponse` `:332` — wrap `withPostgresTransaction`, parse via `parseAgentXml`, write `observations` + `observation_sources`, complete the job. **Never writes `embedding`.** |
| `src/server/generation/ProviderObservationGenerator.ts` | The reusable inline core is `:196-254` (load events → load project → `provider.generate` → `processGeneratedResponse`); `:72-194` is BullMQ ceremony to **skip**. |
| `src/sdk/parser.ts` | `parseAgentXml(raw, correlationId?)` `:41`. **Calls `ModeManager.getInstance().getActiveMode()` at `:105` with no fallback** — SDK must initialize a mode. |
| `src/sdk/prompts.ts` | `buildObservationPrompt`/`buildSummaryPrompt`/`buildInitPrompt`/`buildContinuationPrompt` (mode-driven). |
| `src/server/generation/providers/shared/prompt-builder.ts` | `buildServerGenerationPrompt(context)` `:42` — has `loadActiveModeOrFallback()` `:46` (graceful), unlike `parser.ts`. |
| `src/services/sync/ChromaSync.ts` | `constructor(project)` `:69`, collection `cm__<project>` `:74`; document layer `addDocuments(ChromaDocument[])` `:234` (id/document/metadata → `chroma_add_documents`) is **storage-agnostic**; `syncObservation(observationId:number, …, obs:ParsedObservation, …)` `:306` is **SQLite-shaped** (integer id, `StoredObservation`); `queryChroma(...)` `:855`; `close()` `:1096`. |
| `src/services/sync/ChromaMcpManager.ts` | Singleton `getInstance()` `:56`; spawns `uvx chroma-mcp` subprocess; `callTool(name, args)`. Local all-MiniLM embeddings, **no API key**. |
| `src/services/worker/DatabaseManager.ts` | Reference composition: `new ChromaSync('claude-mem')` `:26`. The worker reads a `CLAUDE_MEM_CHROMA_ENABLED !== 'false'` env gate; **the SDK deliberately does NOT honor that gate** — Chroma is required (see Executive Decision). The gate is the worker's footgun and should not propagate. |
| `src/services/worker/SearchManager.ts` | Reference search semantics: `search()` `:140` does Chroma semantic with **FTS fallback on Chroma failure** (`:255`). The SDK mirrors this branch logic against Postgres. |
| `src/services/hooks/runtime-selector.ts` | **Regression source.** `selectRuntime()` `:35` requires `CLAUDE_MEM_RUNTIME === 'server-beta'` exactly; else silent worker fallback (`:71-78`). Settings keys `CLAUDE_MEM_SERVER_BETA_{URL,API_KEY,PROJECT_ID}` `:41-43`. |
| `src/shared/SettingsDefaultsManager.ts` | Keys `CLAUDE_MEM_SERVER_BETA_*` `:76-78`, defaults `:151-154`; `CLAUDE_MEM_RUNTIME` default `'worker'` `:151`. |
| `src/services/worker-service.ts` | Dispatch `runServerBetaServiceCli` `:850`, looks for `server-beta-service.cjs` `:851`; `server <cmd>` subcommand `:1040`. |
| `scripts/build-hooks.js` | Build target `name:'server-beta-service'` `:16`; emits `dist/npx-cli` + `dist/opencode-plugin` only — **never emits `dist/index.js` or `dist/sdk/`**. Has a `bun:sqlite` import guard precedent at `:262`. |
| `package.json` | `exports["."]` → `dist/index.js` and `exports["./sdk"]` → `dist/sdk/index.js` (both currently resolve to nonexistent files). `pg` is a prod dep and is pure-Node. |

### Allowed APIs (verbatim signatures — do NOT invent or extend)

**Connection / boot**
- `parsePostgresConfig(options?): PostgresConfig | null` — `config.ts:26`
- `createPostgresPool(config: PostgresConfig): PostgresPool` — `pool.ts:13`
- `getSharedPostgresPool(options?: { requireDatabaseUrl?: boolean }): PostgresPool` — `pool.ts:24`
- `bootstrapServerBetaPostgresSchema(client: PostgresQueryable): Promise<void>` — `schema.ts:22` (renamed in Phase 1 → `bootstrapServerPostgresSchema`)
- `createPostgresStorageRepositories(client: PostgresQueryable): PostgresStorageRepositories` — `index.ts:39`
- `withPostgresTransaction<T>(pool, fn): Promise<T>` — `pool.ts:45`
- `PostgresQueryable = { query(text, values?) }` — `utils.ts:9` (a `pg.Pool` or `pg.PoolClient` satisfies it)

**Capture**
- `new IngestEventsService({ pool, resolveEventQueue: () => null })` then `ingestOne(input, { generate })` — `IngestEventsService.ts:93,96`
- `PostgresAgentEventsRepository.create(input: CreatePostgresAgentEventInput)` — `agent-events.ts:63`

**Generation (inline, no BullMQ)**
- `new ClaudeObservationProvider({ apiKey, model? })` (or Gemini/OpenRouter) — `ClaudeObservationProvider.ts:32`
- `PostgresObservationGenerationJobRepository.transitionStatus({ id, projectId, teamId, status:'processing', lockedBy })` — `generation-jobs.ts:164`
- `provider.generate({ job, events, project }, signal?)` — `providers/shared/types.ts:30`
- `processGeneratedResponse({ pool, job, rawText, modelId, providerLabel, ... })` — `processGeneratedResponse.ts:62`
- `processSessionSummaryResponse({ ... })` — `processGeneratedResponse.ts:332`
- `parseAgentXml(raw, correlationId?)` — `parser.ts:41` (requires an active `ModeManager` mode)

**Search**
- `PostgresObservationRepository.search({ projectId, teamId, query, limit? })` — `observations.ts:153`
- `PostgresObservationRepository.getByIdForScope({ id, projectId, teamId })` / `listByProject(...)` — `observations.ts:120,133`

**Chroma (REQUIRED semantic; reuse, don't fork)**
- `ChromaMcpManager.getInstance()` + `callTool('chroma_add_documents' | 'chroma_query_documents' | 'chroma_create_collection' | 'chroma_delete_documents', args)` — `ChromaMcpManager.ts:56`
- `new ChromaSync(project)` + `queryChroma(...)` `:855` + `close()` `:1096`; the `ChromaDocument { id, document, metadata }` + `addDocuments` `:234` layer is the reusable, storage-agnostic seam.

### Anti-patterns to guard against (this plan exists because these already bit us)

1. **Do not "build a hybrid", "adapt", "migrate", or "fork" anything.** Every engine exists. The SDK is glue + packaging. If a task description contains "new system" or "reimplement", it is wrong.
2. **Do not add pgvector / a `vector` column / an embeddings API call.** Postgres semantic search does not exist and is out of scope — semantic search is delivered by the existing Chroma engine (per explicit direction). FTS is the Postgres-side search.
3. **Do not pull Express, BullMQ, ioredis, better-auth, React, or `bun:sqlite` into the SDK bundle.** The server generation providers use plain `fetch` (no `@anthropic-ai/claude-agent-sdk`). Enforce with a build-time import guard (Phase 2/9).
4. **Do not call `transitionStatus(queued → completed)`** — it throws (`generation-jobs.ts:390`). You must transition `queued → processing` first (mirror `lockOutbox`).
5. **Do not call `parseAgentXml` without an active mode** — `parser.ts:105` throws otherwise. Initialize `ModeManager` (or use the `prompt-builder` fallback semantics) in Phase 5.
6. **Do not blind string-replace the rename.** Persisted values (DB table `server_beta_schema_migrations`, `job_type`/`source_type` enum strings, users' settings.json keys, the `CLAUDE_MEM_RUNTIME` value) need backward-compat. Only code identifiers rename freely.
7. **Do not re-run grep-only subagents and synthesize across fragments.** Read the wiring hub and the composition root as wholes.

---

## Phase 1: Rename `server-beta` → `server` (foundation + regression fix)

**Why first:** the SDK is built on the server runtime; ship it with clean naming. Independently shippable — fixes the silent-fallback regressions on its own.

### 1a. Fix the regression (highest-value, smallest change)

What to implement:
- `src/services/hooks/runtime-selector.ts:34-37`: accept **`'server'`** as the canonical runtime value, and **also still accept `'server-beta'`** for back-compat. Update `SelectedRuntime`/`ServerBetaRuntimeContext` types (`:17,19`) to `'server'`.
- `src/server/runtime/create-server-beta-service.ts:94-98,148`: `validateServerBetaEnv` must accept `'server'` (and `'server-beta'`) and stop emitting/refusing on the old literal.
- `src/shared/SettingsDefaultsManager.ts:76-78,151-154`: add `CLAUDE_MEM_SERVER_{URL,API_KEY,PROJECT_ID}` keys; **read new-key-then-old-key** so existing `settings.json` files keep working. `runtime-selector.ts:41-43` reads new keys with old-key fallback.

Verification:
- With `CLAUDE_MEM_RUNTIME=server` + `CLAUDE_MEM_SERVER_DATABASE_URL` set, hooks resolve to the server runtime (not worker). Add a unit test asserting `selectRuntime()==='server'` for both `'server'` and `'server-beta'`.
- `rg -n "=== 'server-beta'"` returns no equality checks that exclude `'server'`.

Anti-pattern guard: do **not** drop `'server-beta'` acceptance — that would re-break currently-working installs.

### 1b. Rename code identifiers (safe, mechanical)

What to implement: rename the ~80 `ServerBeta*` / `serverBeta*` / `SERVER_BETA_*` **code symbols** (classes, types, interfaces, vars, non-persisted constants) → `Server*` / `server*` / `SERVER_*`. Examples: `ServerBetaService→ServerService`, `createServerBetaService→createServerService`, `ServerBetaClient→ServerClient`, `ActiveServerBetaQueueManager→ActiveServerQueueManager`, `ServerBetaServiceGraph→ServerServiceGraph`, `bootstrapServerBetaPostgresSchema→bootstrapServerPostgresSchema`, `SERVER_BETA_POSTGRES_SCHEMA_VERSION→SERVER_POSTGRES_SCHEMA_VERSION`. Use the enumerated list from `rg -io 'server[_-]?beta[a-z0-9_]*'` (saved during discovery; ~80 distinct forms).

Doc references: the full surface is ~40 files; top density `ServerBetaService.ts`, `create-server-beta-service.ts`, `server-beta-client.ts`, `mcp-server.ts`, `runtime/types.ts`.

Verification: `npm run typecheck` passes; `rg -i 'serverbeta'` returns 0 in code identifiers.

Anti-pattern guard: **exclude persisted literals** (1d) from this pass.

### 1c. Rename files + build/dispatch target

What to implement:
- Rename source files: `create-server-beta-service.ts→create-server-service.ts`, `ServerBetaService.ts→ServerService.ts`, `server-beta-client.ts→server-client.ts`, `server-beta-bootstrap.ts→server-bootstrap.ts`, `ActiveServerBeta*.ts→ActiveServer*.ts`, `scripts/e2e-server-beta-docker.sh→scripts/e2e-server-docker.sh`, docs `docs/server-beta-*.md→docs/server-*.md`. Update all imports.
- `scripts/build-hooks.js:16`: build target `server-beta-service` → `server-service` (emits `plugin/scripts/server-service.cjs`). Update log lines `:207,448`.
- `src/services/worker-service.ts:850-854,1040`: `runServerBetaServiceCli` → `runServerServiceCli`, look for `server-service.cjs`. Keep the `server <cmd>` subcommand name (already correct).

Verification: `npm run build` succeeds and emits `plugin/scripts/server-service.cjs`; `claude-mem server status` dispatches correctly.

Anti-pattern guard: keep a fallback that still finds `server-beta-service.cjs` if present in an already-installed plugin cache, to avoid breaking mid-upgrade installs (or document a forced rebuild).

### 1d. Persisted values — backward-compat (the hazard)

What to implement (decide per item; recommended defaults below):
- **Schema migrations table `server_beta_schema_migrations`** (`schema.ts`, referenced `create-server-service.ts:274`): add an idempotent, guarded `ALTER TABLE IF EXISTS server_beta_schema_migrations RENAME TO server_schema_migrations;` at the top of `bootstrapServerPostgresSchema`, then create `server_schema_migrations IF NOT EXISTS`. Update the `SELECT ... FROM server_schema_migrations` read. (Zero-risk alternative: keep the physical table name, rename only the TS constant.)
- **Job `job_type`/`source_type` enum strings** (`server_beta_generate_event`, `server_beta_generate_summary`, `server_beta_generate_event_batch`, `server_beta_reindex`, `server_beta_observation_request`): on **write** emit `server_*`; on **read/match** accept both `server_*` and legacy `server_beta_*`. Add a tiny normalize helper. (Zero-risk alternative: keep the persisted literals, rename only the TS constant names that hold them.)
- **Settings keys / runtime value**: handled in 1a (read new-then-old). Installer writes new keys + `CLAUDE_MEM_RUNTIME=server` going forward.

Verification: open an existing pre-rename Postgres DB → bootstrap runs clean, the migrations row is preserved/renamed, no duplicate tables; an existing `settings.json` with old keys still resolves the server runtime; a queued legacy `server_beta_generate_event` job still processes.

Anti-pattern guard: never `DROP` or recreate a populated table; never rename a column that holds historical enum values without dual-accept.

---

## Phase 2: SDK package skeleton + build + export wiring

What to implement:
- Create `src/sdk/index.ts` as the public entry (re-exports `createCmemClient`, `CmemClient`, and the public types). Leave existing `src/sdk/parser.ts`/`prompts.ts` in place (reused internally).
- Create `src/index.ts` (the `.` export) re-exporting the SDK surface (so both `claude-mem` and `claude-mem/sdk` resolve). Keep `.` minimal.
- Add a real build that emits **both JS and `.d.ts`** for the SDK targets, since `npm run build` does not today:
  - `tsconfig.sdk.json` (extends root, `rootDir: src`, `outDir: dist`, `declaration: true`, `emitDeclarationOnly: false`, `types: ["node"]` — drop `"bun"`), include only the SDK's transitive sources; **or** add `tsup` (devDep) with entries `src/index.ts` + `src/sdk/index.ts`, `format: esm`, `dts: true`, `platform: node`.
  - Add `"build:sdk"` script; chain it into `build` and `prepublishOnly`.
- Confirm `package.json` `exports` map already matches (`.` → `dist/index.js`, `./sdk` → `dist/sdk/index.js`); ensure `files` ships `dist`.

Doc references: broken-export evidence — `package.json` exports vs missing `src/index.ts`/`src/sdk/index.ts`; `scripts/build-hooks.js` emits only `dist/npx-cli` + `dist/opencode-plugin`; `bun:sqlite` guard precedent `build-hooks.js:262`.

Verification checklist:
- `npm run build` produces `dist/sdk/index.js` **and** `dist/sdk/index.d.ts`.
- From a scratch `node` project: `import { createCmemClient } from 'claude-mem/sdk'` resolves and types load.
- **Import guard**: a build/test step greps the SDK bundle (or its resolved import graph) and fails if it references `express`, `bullmq`, `ioredis`, `better-auth`, `react`, or `bun:sqlite`.

Anti-pattern guards: do not `tsc`-emit the whole repo (drags in worker/`bun:sqlite`); scope the SDK build to its own entrypoints. Do not add `@anthropic-ai/claude-agent-sdk` as an SDK dep — the server providers use `fetch`.

## Phase 3: SDK core — connection, schema bootstrap, repositories, tenancy

What to implement (copy the graph from `create-server-service.ts:156-186`, minus the service/queue/worker):
- `createCmemClient(options)` where `options = { databaseUrl?, pool?, teamId?, projectId?, provider?, chroma?: ChromaOptions }`. **`chroma` is for tuning Chroma (collection prefix, MCP path, etc.), not for disabling it.** There is no `enabled: false` toggle.
  - Pool: `options.pool ?? createPostgresPool(parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: options.databaseUrl ?? process.env... } })!)` (or `getSharedPostgresPool`).
  - `await bootstrapServerPostgresSchema(pool)` (idempotent).
  - `repos = createPostgresStorageRepositories(pool)`.
  - **Chroma required:** `chromaSync = new ChromaSync(projectId)`; `await chromaSync.ensureReady()` (or first `addDocuments`/`queryChroma` call). If the `uvx chroma-mcp` subprocess fails to start, `createCmemClient` REJECTS with a clear error — the SDK does not return a half-working client.
- **Tenancy bootstrap**: Postgres requires `teamId` + `projectId` on every call, and `ProjectsRepository` has **no lookup-by-name** (`projects.ts:46` is `getByIdForTeam`). So:
  - If `options.teamId`/`projectId` provided → use them.
  - Else → `ensureDefaults()`: create a default team (`teams.create({name:'default'})`) + project (`projects.create({teamId, name: options.projectName ?? 'default'})`) **once**, and persist the IDs to the SDK's local state file (e.g. `$CLAUDE_MEM_DATA_DIR/sdk-tenant.json`) so subsequent runs reuse them. Document that production consumers should pass explicit IDs.

Doc references: `create-server-service.ts:162-186`; `pool.ts:13,24`; `config.ts:26`; `index.ts:39`; `teams.ts:45`; `projects.ts:27,46`.

Verification: `createCmemClient({ databaseUrl })` connects, bootstraps schema idempotently (run twice → no error), exposes `client.repos`, and resolves a stable `{teamId, projectId}`.

Anti-pattern guard: do not require Redis/bullmq env (`validateServerEnv` Docker checks are for the HTTP container, not the SDK — the SDK never calls it). Do not invent a `getProjectByName` on the repo; persist IDs instead.

## Phase 4: SDK capture API

What to implement:
- `client.capture(event)` / `client.captureBatch(events)` wrapping `new IngestEventsService({ pool, resolveEventQueue: () => null }).ingestOne(input, { generate: false })` — writes the `agent_event` + a `queued` generation-job outbox row, **no Redis**.
- Map the SDK's friendly event shape → `CreatePostgresAgentEventInput` (`agent-events.ts:31`): `{ projectId, teamId, serverSessionId?, sourceAdapter, sourceEventId?, eventType, payload, occurredAt }`.
- Optionally expose `client.startSession()/endSession()` via `PostgresServerSessionsRepository` for grouping.

Doc references: `IngestEventsService.ts:96` (`ingestOne`), `:64` (`resolveEventQueue` returning `null` ⇒ `queued_only`); `agent-events.ts:31,63`; `server-sessions.ts`.

Verification: after `capture(...)`, exactly one `agent_events` row and one `observation_generation_jobs` row (status `queued`) exist for the tenant; no Redis connection attempted.

Anti-pattern guard: do not enqueue to BullMQ; `resolveEventQueue` must return `null`.

## Phase 5: SDK generation/compression API (inline, no worker)

What to implement (reproduce `ProviderObservationGenerator.ts:196-254`; skip `:72-194`):
- Provider: `options.provider` → instantiate `ClaudeObservationProvider({apiKey, model?})` (or Gemini/OpenRouter), or reuse the env-driven `buildServerGenerationProviderFromEnv()` logic (`create-server-service.ts:218-247`).
- Ensure an active mode for `parseAgentXml` (`parser.ts:105`): initialize `ModeManager` with the default mode at client construction (or wrap parse with the `prompt-builder.ts:46` fallback).
- `client.generate(jobOrEventId)`:
  1. `job = transitionStatus({ id, projectId, teamId, status:'processing', lockedBy:'sdk' })` (mandatory `queued→processing`).
  2. load events (`agentEvents.getByIdForScope`/`listByProject`) + project (`projects.getByIdForTeam`).
  3. `result = await provider.generate({ job, events, project:{ projectId, teamId, serverSessionId, projectName } })`.
  4. `await processGeneratedResponse({ pool, job, rawText: result.rawText, modelId: result.modelId, providerLabel: result.providerLabel, sourceAdapter:'sdk' })`.
- Convenience: `client.captureAndGenerate(event)` = Phase 4 + 5 in sequence.

Doc references: `ProviderObservationGenerator.ts:196-254`; `providers/shared/types.ts:9,23,30`; `ClaudeObservationProvider.ts:32,69`; `processGeneratedResponse.ts:62,332`; `generation-jobs.ts:164,390`; `parser.ts:105`; `prompt-builder.ts:46`.

Verification: `captureAndGenerate(...)` yields one `observations` row whose `metadata` carries `{title,subtitle,facts,narrative,concepts,files_*}`, the job ends `completed`, and `observation_sources` links it to the source `agent_event`.

Anti-pattern guards: no `@anthropic-ai/claude-agent-sdk`, no subprocess, no `queued→completed`, no BullMQ payload validation/locking ceremony (`:85,109-156`).

## Phase 6: SDK search — Chroma semantic (primary) + FTS runtime safety net + context

**Chroma is required (not optional).** See "Executive Decision" above. The plain-FTS branch below exists only to mirror `SearchManager.ts:255`'s catch-and-degrade-once behavior for transient Chroma death — it is NOT a feature toggle, NOT a config-disabled path, and emits a loud `logger.error` so the broken state is visible.

What to implement:
- `client.search({ query, limit })` mirroring `SearchManager.search`'s branch logic (`SearchManager.ts:140,255`) against Postgres:
  - Default path → `queryChroma(query, limit, whereFilter)` → ranked observation **UUIDs** → hydrate via `observations.getByIdForScope` / batch.
  - Empty-query path → `PostgresObservationRepository.listByProject(...)` (no semantic intent to express).
  - **On Chroma runtime failure (and ONLY runtime failure — not config):** fall back to `PostgresObservationRepository.search({projectId, teamId, query, limit})` (FTS), log `logger.error('CHROMA', 'semantic search failed; returning degraded FTS results — investigate uvx chroma-mcp', err)`, and surface `{ degraded: true }` in the response so callers can decide whether to retry or fail their own request.
- `client.context({ query, limit })` = run `search`, then `results.map(o => o.content).join('\n\n')` (copy `ServerV1PostgresRoutes.ts:886-895`).
- **Chroma↔Postgres glue (the only genuinely-new code, kept minimal):** reuse the storage-agnostic document layer, do **not** reuse SQLite-shaped `syncObservation`:
  - On observation persist (Phase 5), index it: build a `ChromaDocument { id: observation.id /*UUID string*/, document: observation.content, metadata: { projectId, teamId, kind, serverSessionId } }` and call the existing `chroma_add_documents` path (via `ChromaMcpManager.callTool` or a thin `ChromaSync` method that takes pre-built `ChromaDocument`s — refactor `addDocuments` from `private` to a reusable seam if needed, `ChromaSync.ts:234`).
  - Use a per-tenant collection name (e.g. `cm__<projectId>`), reusing `ChromaSync`'s `cm__` convention (`:74`).
  - Sync-on-write means **no SQLite backfill/watermark path** is involved (`ChromaSyncState`/integer IDs stay SQLite-only).

Doc references: `observations.ts:153,120,133`; `ServerV1PostgresRoutes.ts:886-895`; `ChromaSync.ts:69,74,234,855`; `ChromaMcpManager.ts:56`; `SearchManager.ts:140,255`; `DatabaseManager.ts:26` (enable gate `CLAUDE_MEM_CHROMA_ENABLED`).

Verification:
- **Chroma is required at construction:** with `uvx`/chroma-mcp deliberately unavailable, `createCmemClient(...)` REJECTS. (No silent-FTS-only mode.)
- Chroma happy path: `createCmemClient` + `captureAndGenerate` + `search('semantic query')` returns hydrated Postgres observations ranked by semantic distance.
- Chroma runtime-failure path: kill chroma-mcp after a successful `search`, run another `search`; results return with `{ degraded: true }`, a `logger.error('CHROMA', …)` is emitted, and a subsequent `createCmemClient` (cold start) REJECTS.
- `context(...)` returns `{ observations, context }` with `\n\n`-joined content, and surfaces `{ degraded: true }` if its underlying `search` degraded.

Anti-pattern guards: do **not** add pgvector; do **not** reuse `syncObservation(observationId:number, …)` (SQLite-shaped) for Postgres UUIDs; do **not** require an embeddings API key (Chroma embeds locally); do **not** add a `chroma.enabled = false` option (would re-introduce the silently-broken state the user explicitly rejected).

## Phase 7: SDK public facade + types

What to implement:
- `CmemClient` ties it together: `capture`, `captureBatch`, `generate`, `captureAndGenerate`, `search`, `context`, `startSession`, `endSession`, `close()` (closes pool + Chroma).
- Public types: re-export `PostgresObservation`, the capture input type, search result/context types, and the relevant `src/core/schemas` Zod types. Keep the surface small and stable.
- `close()` must `await chromaSync?.close()` (`ChromaSync.ts:1096`) and close/clean the pool (`closePostgresPool`, `pool.ts:63`) only if the SDK created it.

Verification: a single end-to-end test exercises `createCmemClient → captureAndGenerate → search → context → close` against a Postgres test DB.

Anti-pattern guard: no HTTP server, no pidfile, no `process.exit`, no daemon.

## Phase 8: Tests + worker-free example app + docs

What to implement:
- Unit/integration tests against a Postgres test DB (reuse the docker harness from the renamed `scripts/e2e-server-docker.sh`). Cover: schema bootstrap idempotency, capture, inline generation, FTS search, Chroma fallback, tenancy bootstrap.
- `examples/sdk-node/` — a plain **Node** (not Bun) script that imports `claude-mem/sdk`, points at `CLAUDE_MEM_SERVER_DATABASE_URL`, and runs capture→generate→search **with no worker/daemon running**. This is the proof of the headline requirement.
- Docs: `docs/public/` page "Using claude-mem in your app (SDK)" + update `docs.json` nav.

Verification: `npm test` green; the example runs under `node` (no Bun) and prints generated observations + search hits with no worker process alive.

Anti-pattern guard: the example must not start a worker or require Redis.

## Phase 9: Final verification

1. **Rename complete & safe:** `rg -i 'server[-_]?beta'` returns only intentionally-kept persisted literals (documented in 1d) and changelog/historical plan files; `npm run typecheck` + `npm test` green; `CLAUDE_MEM_RUNTIME=server` reaches Postgres (regression test from 1a).
2. **No forbidden deps in SDK:** automated guard confirms the `claude-mem/sdk` import graph excludes `express`, `bullmq`, `ioredis`, `better-auth`, `react`, `bun:sqlite`, `@anthropic-ai/claude-agent-sdk`.
3. **Exports real:** `dist/index.js`, `dist/index.d.ts`, `dist/sdk/index.js`, `dist/sdk/index.d.ts` all exist after `npm run build`; resolve from an external project.
4. **No invented APIs:** grep the SDK for `pgvector`/`vector(`/`embedding` writes (should be none); confirm generation uses `fetch` providers, not the agent SDK; confirm `parseAgentXml` is always called with an active mode.
5. **Headline requirement met:** the Phase 8 example demonstrates full capture → compression → semantic+FTS search **in plain Node, in-process, with no HTTP worker running.**

---

## Open questions / decisions deferred to execution

- **tsup vs tsconfig.sdk.json** for the SDK build (Phase 2) — pick during execution; tsup gives JS+dts in one step, tsconfig avoids a new devDep.
- **Chroma `addDocuments` exposure** (Phase 6) — refactor the `private addDocuments` into a reusable seam vs. call `ChromaMcpManager.callTool('chroma_add_documents')` directly from the SDK. Prefer the smallest change that keeps one code path for the chroma-mcp protocol.

## Correction log
- **2026-05-29** — Plan originally framed Chroma as "optional" (lines 21, 105, Phase 3 options, Phase 6 branches, Phase 6 verification). This was wrong: claude-mem without semantic search is broken. Updated:
  - Architecture diagram + Executive Decision now mark Chroma REQUIRED.
  - `createCmemClient` options dropped the boolean disable; `ChromaOptions` is for tuning only.
  - Phase 6 default path is Chroma; FTS is a runtime safety net for transient failure that surfaces `{ degraded: true }` and `logger.error`, not a feature toggle.
  - Phase 6 verification adds: `createCmemClient` MUST REJECT when Chroma is unavailable at construction.
  - Phase 6 anti-patterns add: no `chroma.enabled = false` option.
- **Tenancy persistence** (Phase 3) — confirm where to store the default `{teamId, projectId}` (SDK state file vs. require explicit IDs in production).
