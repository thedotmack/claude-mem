# Claude-Mem 13 Server Beta: Independent BullMQ Observation Runtime

Status: implementation plan  
Date: 2026-05-07  
Release target: claude-mem 13 Server (beta)  
Relationship to prior plans:

- Extends `plans/2026-05-07-claude-mem-server-apache-bullmq-team-auth.md`.
- Supersedes the worker-parity parts of `plans/2026-05-07-claude-mem-13-server-beta-full-worker-parity.md` where that plan allowed Server beta to wrap/copy `WorkerService`.
- Keeps the existing worker in place, but makes Server beta a fully independent runtime, not a facade over worker internals.

## Executive Decision

Server beta must own its runtime end to end:

```text
REST/MCP/hooks -> Server beta HTTP/API layer -> BullMQ observation jobs -> provider generation -> server storage/search
```

The worker remains the stable legacy runtime, but Server beta must not depend on `WorkerService`, worker HTTP routes, worker queue consumers, or worker process lifecycle to generate observations.

Server beta should use BullMQ/Valkey as its canonical queue and Postgres as its canonical observation store. SQLite remains the legacy worker/local compatibility store only. Redis/Valkey is runtime infrastructure for jobs, retries, concurrency, and observability, not the source of truth for observations.

## Terminology Decision

Claude-mem's domain object is an **observation**. Server beta must preserve that wording in user-facing APIs, docs, jobs, storage names, tests, logs, and implementation plans.

Use "memory" only for legacy compatibility names that already exist in worker-era code or for external library/API concepts that cannot be renamed cleanly. New Server beta/Postgres concepts should be named around observations:

- `observations`, not `memory_items`
- `observation_sources`, not `memory_sources`
- `ObservationRepository`, not `MemoryItemsRepository`
- `GenerateObservationsForEventJob`, not generic memory generation
- `/v1/observations` and observation-focused MCP tools as the canonical surface

If any compatibility endpoint still uses `/v1/memories`, it should be treated as an alias over observations, not the canonical Server beta model.

## Phase 0: Documentation Discovery

### Local Sources Read

- `plans/2026-05-07-claude-mem-server-apache-bullmq-team-auth.md`
- `plans/2026-05-07-claude-mem-13-server-beta-full-worker-parity.md`
- `/Users/alexnewman/Downloads/claude-mem-handoff-docs/claude-mem-server-plan.md`
- `src/server/routes/v1/ServerV1Routes.ts`
- `src/server/queue/BullMqObservationQueueEngine.ts`
- `src/server/queue/ObservationQueueEngine.ts`
- `src/services/worker-service.ts`
- `src/services/worker/SessionManager.ts`
- `src/services/worker/agents/ResponseProcessor.ts`
- `src/services/worker/ClaudeProvider.ts`
- `src/services/worker/GeminiProvider.ts`
- `src/services/worker/OpenRouterProvider.ts`
- `src/services/worker/http/shared.ts`
- `src/storage/sqlite/agent-events.ts`
- `src/storage/sqlite/memory-items.ts`
- `src/core/schemas/agent-event.ts`
- `src/core/schemas/memory-item.ts`
- `scripts/e2e-server-beta-docker.sh`
- `docker/e2e/server-beta-e2e.mjs`

### External Docs Read

- BullMQ Workers: https://docs.bullmq.io/guide/workers
- BullMQ Worker Concurrency: https://docs.bullmq.io/guide/workers/concurrency
- BullMQ Stalled Jobs: https://docs.bullmq.io/guide/jobs/stalled
- Better Auth Express integration: https://better-auth.com/docs/integrations/express

### Concrete Findings

- The current `/v1` server route stores supplied events and direct observation records under legacy "memory" route/repository names:
  - `src/server/routes/v1/ServerV1Routes.ts` registers `POST /v1/events`, `POST /v1/events/batch`, and `POST /v1/memories`.
  - Those routes call `AgentEventsRepository.create(...)` and `MemoryItemsRepository.create(...)`.
  - They do not currently enqueue a provider generation job.
- The current AI observation generation path is worker-owned:
  - `src/services/worker/SessionManager.ts` consumes queued messages through `getMessageIterator(...)`.
  - `src/services/worker-service.ts` starts provider sessions through `startSessionProcessor(...)`.
  - `src/services/worker/agents/ResponseProcessor.ts` parses provider XML with `parseAgentXml(...)` and writes observations through `sessionStore.storeObservations(...)`.
- The existing v2 parity plan names `Claude/Gemini/OpenRouter providers`, session ingest routes, queue semantics, and hook routing as parity requirements, but it does not explicitly require `/v1/events` to generate observations.
- BullMQ official docs establish the primitives Server beta should use directly:
  - `Worker` processes jobs and moves successful jobs to completed or thrown jobs to failed.
  - BullMQ workers should attach an `error` listener.
  - Workers support `autorun: false`.
  - Workers support concurrency via the worker options object.
  - Multiple workers are the recommended way to improve availability.
  - Active jobs can stall and be retried when workers stop renewing locks.
- Better Auth Express docs require the auth handler to mount before `express.json()` and use `/api/auth/*splat` for Express 5.

### Allowed APIs And Patterns

- Copy Express pre-body route mounting from `src/services/server/Server.ts` plus Better Auth docs.
- Copy API-key auth from `src/server/middleware/auth.ts` and `src/server/auth/api-key-service.ts`.
- Copy repository behavior where useful, but implement Server beta repositories against Postgres; do not reuse worker legacy `SessionStore` as the server observation model.
- Copy provider request construction from `src/services/worker/ClaudeProvider.ts`, `GeminiProvider.ts`, and `OpenRouterProvider.ts`, then move shared logic into `src/server/generation` or `src/core/generation`.
- Copy XML parsing from `src/sdk/parser.ts` and current post-processing rules from `src/services/worker/agents/ResponseProcessor.ts`.
- Use BullMQ `Queue`, `Worker`, and `QueueEvents` directly for Server beta generation queues.
- Keep Valkey/Redis health checks from `src/server/queue/redis-config.ts` and existing Docker E2E setup.

### Anti-Pattern Guards

- Do not make Server beta call `new WorkerService()`.
- Do not make Server beta depend on worker HTTP route classes for generation.
- Do not make `/v1` a write-only event archive while claiming Server beta generates observations.
- Do not use the legacy SQLite pending-message queue for Server beta generation.
- Do not store canonical observation records in Redis.
- Do not remove or destabilize the existing worker.
- Do not silently fall back from explicit Server beta BullMQ mode to SQLite.
- Do not mount Better Auth after `express.json()`.

## Target Architecture

### Runtime Separation

```text
src/services/worker-service.ts
  Legacy worker runtime. Stable compatibility path. May import shared core pieces later.

src/server/runtime/ServerBetaService.ts
  Independent server runtime. Owns HTTP server, BullMQ queues, provider generation workers,
  server storage repositories, auth, health, and Docker deployment.
```

### Server Beta Flow

```text
POST /v1/events
POST /v1/events/batch
Claude Code hook routed to Server beta
MCP observation_record_* tool
        |
        v
AgentEventsRepository transaction
        |
        v
ObservationGenerationJobRepository outbox row
        |
        v
BullMQ Queue.add(...)
        |
        v
BullMQ Worker processor
        |
        v
ProviderObservationGenerator
        |
        v
parseAgentXml / structured parser
        |
        v
ObservationRepository.create(...) + ObservationSourcesRepository.addSource(...)
        |
        v
QueueEvents/SSE/audit/search index update
```

## Phase 1: Postgres Observation Storage Foundation

### What To Implement

- Add Server beta Postgres configuration:
  - add package dependencies `pg` and `@types/pg` to the Node/Bun TypeScript package manifest used by this repo;
  - centralize Postgres storage code under:
    - `src/storage/postgres/config.ts` for environment parsing, pool sizing, timeouts, and SSL settings;
    - `src/storage/postgres/pool.ts` for the shared `pg.Pool` factory, health check, transactions, and graceful shutdown;
    - `src/storage/postgres/schema.ts` for migration/bootstrap SQL and schema version constants;
    - `src/storage/postgres/index.ts` for exports used by Server beta runtime wiring;
  - `CLAUDE_MEM_SERVER_DATABASE_URL`;
  - connection pool size and timeout settings;
  - startup validation that fails Server beta when Postgres is required but unavailable;
  - graceful shutdown that drains and closes the Postgres pool.
- Add a migration/bootstrap helper for Server beta storage:
  - creates required schemas/tables/indexes;
  - records applied migration versions;
  - is safe to run repeatedly on startup and in tests.
- Define canonical Postgres tables:
  - `teams`;
  - `projects`;
  - `team_members`;
  - `api_keys`;
  - `audit_log`;
  - `server_sessions`;
  - `agent_events`;
  - `observations`;
  - `observation_sources`;
  - `observation_generation_jobs`;
  - `observation_generation_job_events`.
- Implement the initial schema contract explicitly in Phase 1 migrations. Column names can be refined only if all repository contracts and tests are updated in the same phase:

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, team_id)
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_id TEXT,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE SET NULL
);

CREATE TABLE server_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  external_session_id TEXT,
  content_session_id TEXT,
  agent_id TEXT,
  agent_type TEXT,
  platform_source TEXT,
  generation_status TEXT NOT NULL DEFAULT 'idle',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  last_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_session_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE agent_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  source_adapter TEXT NOT NULL,
  source_event_id TEXT,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  UNIQUE (id, project_id, team_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE observation_generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex')),
  source_id TEXT NOT NULL,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  bullmq_job_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_error JSONB,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, project_id, source_type, source_id, job_type),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type = 'session_summary' AND agent_event_id IS NULL AND server_session_id IS NOT NULL AND source_id = server_session_id)
    OR
    (source_type = 'observation_reindex' AND agent_event_id IS NULL)
  ),
  FOREIGN KEY (agent_event_id, project_id, team_id) REFERENCES agent_events(id, project_id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'observation',
  content TEXT NOT NULL,
  content_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  generation_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding JSONB,
  created_by_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, project_id, generation_key),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE observation_sources (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  generation_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex', 'manual')),
  source_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (observation_id, source_type, source_id),
  UNIQUE (source_type, source_id, generation_job_id, observation_id),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type <> 'agent_event' AND agent_event_id IS NULL)
  )
);

CREATE TABLE observation_generation_job_events (
  id TEXT PRIMARY KEY,
  generation_job_id TEXT NOT NULL REFERENCES observation_generation_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('queued', 'enqueued', 'processing', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  status_after TEXT NOT NULL CHECK (status_after IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_events_project_session ON agent_events(project_id, server_session_id, occurred_at);
CREATE INDEX idx_projects_team ON projects(team_id, id);
CREATE INDEX idx_agent_events_team_project ON agent_events(team_id, project_id, occurred_at);
CREATE INDEX idx_observations_project_session ON observations(project_id, server_session_id, created_at);
CREATE INDEX idx_observations_team_project ON observations(team_id, project_id, created_at);
CREATE INDEX idx_observations_content_search ON observations USING GIN (content_search);
CREATE INDEX idx_observation_sources_event ON observation_sources(agent_event_id);
CREATE INDEX idx_observation_sources_source ON observation_sources(source_type, source_id);
CREATE INDEX idx_observation_jobs_status_next_attempt ON observation_generation_jobs(status, next_attempt_at, created_at);
CREATE INDEX idx_observation_jobs_team_project ON observation_generation_jobs(team_id, project_id, status, created_at);
CREATE INDEX idx_observation_jobs_event ON observation_generation_jobs(agent_event_id);
CREATE INDEX idx_observation_jobs_source ON observation_generation_jobs(source_type, source_id);
CREATE INDEX idx_observation_job_events_job_created ON observation_generation_job_events(generation_job_id, created_at);
CREATE INDEX idx_audit_log_scope_created ON audit_log(project_id, team_id, created_at);
```

- Define event/outbox relationships:
  - `agent_events` is the canonical Postgres table for raw ingested agent events and their project/session/team ownership;
  - every project is owned by exactly one team through `projects.team_id`; Server beta has no unowned/default project mode in the Postgres canonical store;
  - repositories and routes must resolve project ownership from `projects.team_id`, require the caller's team/API-key scope to match it, and reject any request body or repository write where `team_id` disagrees with the project's owner;
  - project-scoped rows that carry both `project_id` and `team_id` must use FK-backed ownership validation through `FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id)`;
  - `observation_generation_jobs.source_type` and `observation_generation_jobs.source_id` identify the durable source of work for event, summary, and reindex jobs without overloading event-only columns;
  - event generation jobs use `source_type = 'agent_event'`, `source_id = agent_event_id`, and a non-null `agent_event_id` FK to the source `agent_events` row being processed;
  - session summary jobs use `source_type = 'session_summary'`, `source_id = server_session_id`, and `agent_event_id = NULL`;
  - reindex jobs use `source_type = 'observation_reindex'`, `source_id` set to the target observation ID or deterministic reindex scope ID, and `agent_event_id = NULL`;
  - repositories must validate non-event `source_id` ownership before job insert: session summary jobs must load the `server_sessions` row under the same `project_id`/`team_id`, and observation reindex jobs must load the target observation or documented reindex scope under the same `project_id`/`team_id`;
  - `observation_generation_job_events` records durable lifecycle/outbox events for each observation generation job, including enqueue, processing, retry, completion, and failure state changes;
  - `observation_generation_job_events` may reference `agent_events` through its job relationship, but it is not a replacement for `agent_events` and must not store raw event payloads as the canonical event record.
- Define outbox status and idempotency rules:
  - `observation_generation_jobs.status` is constrained to `queued`, `processing`, `completed`, `failed`, or `cancelled`;
  - legal lifecycle is `queued -> processing -> completed`, `queued -> processing -> failed`, `queued -> cancelled`, and retry transitions from stale/failed retryable work back to `queued` only when `attempts < max_attempts`;
  - `attempts` increments only when a worker transitions a job to `processing`;
  - `next_attempt_at` gates retry/reconciliation eligibility;
  - `locked_at` and `locked_by` are set while a worker owns processing and are cleared or superseded on completion, failure, cancellation, or stale-lock recovery;
  - `completed_at`, `failed_at`, and `cancelled_at` are terminal timestamps and exactly one may be non-null for terminal jobs;
  - `agent_events.source_event_id` is optional adapter metadata only and must not be used as the sole idempotency authority;
  - `agent_events.idempotency_key` is required and deterministic: when `source_event_id` is present, derive it from `team_id`, `project_id`, `source_adapter`, and `source_event_id`; when omitted, derive it from `team_id`, `project_id`, `source_adapter`, `server_session_id`, `event_type`, `occurred_at`, and a canonical JSON hash of `payload`;
  - `UNIQUE (idempotency_key)` on `agent_events` suppresses duplicate ingestion for native event IDs, batch imports, and clients with omitted source event IDs;
  - job `idempotency_key` must be deterministic from `team_id`, `project_id`, `source_type`, `source_id`, and `job_type`, and `UNIQUE (idempotency_key)` suppresses duplicate outbox rows;
  - `UNIQUE (team_id, project_id, source_type, source_id, job_type)` guarantees one source/job relationship per generation kind within the owning project/team scope across event, summary, and reindex jobs;
  - `bullmq_job_id` must be deterministic and unique when present so reconciliation can safely re-add or replace terminal BullMQ jobs;
  - `observations.generation_key` is nullable for direct/manual observations and required for provider/generated observations;
  - provider-generated `generation_key` must be deterministic as `generation:v1:{generation_job_id}:{parsed_observation_index}:{canonical_content_fingerprint}` where the content fingerprint is computed after parser normalization and before persistence;
  - `UNIQUE (team_id, project_id, generation_key)` on `observations` is the primary retry idempotency guard within the owning project/team scope: retrying the same job and parsed observation must upsert/reload the existing observation instead of creating a new row;
  - `observations.created_by_job_id` is a nullable foreign key to `observation_generation_jobs(id)`; provider-generated observations must set it to the durable Postgres generation job that created the observation;
  - `observation_sources.generation_job_id` is a nullable foreign key to `observation_generation_jobs(id)`; generated observation source rows must set it when the observation came from a generation job;
  - `observation_sources.source_type` and `observation_sources.source_id` mirror the job source model so generated observations can link to events, session summaries, reindex scopes, or manual/direct sources without ambiguous nullable uniqueness;
  - `UNIQUE (observation_id, source_type, source_id)` guarantees a source cannot be linked to the same observation more than once;
  - generated observation writes must also be idempotent through `observation_sources`: the same `source_type`, `source_id`, `generation_job_id`, and `observation_id` relationship must not be inserted twice;
  - mutation APIs that touch observation sources, generation job status, or generation job lifecycle events must require `project_id` and `team_id` and include them in the mutating SQL predicate before changing rows;
  - `ObservationRepository.search(...)` must use the generated `observations.content_search` `tsvector`, the GIN index on `content_search`, and `websearch_to_tsquery('english', query)` for scoped full-text search;
  - provider retries must reload the Postgres job row and the authoritative source row before side effects; for event jobs that source row is `agent_events`, for summary jobs it is `server_sessions`, and for reindex jobs it is the target observation or documented reindex scope. BullMQ payload data is advisory execution data, not authority.
- Define repository interfaces and Postgres implementations:
  - `ProjectRepository`;
  - `TeamRepository`;
  - `ObservationRepository`;
  - `ObservationSourcesRepository`;
  - `ObservationGenerationJobRepository`;
  - `ObservationGenerationJobEventsRepository` for durable lifecycle/outbox events such as queued, enqueued, processing, retry scheduled, completed, failed, and cancelled;
  - `AgentEventsRepository` backed by the Server beta Postgres connection.
- Keep legacy names as adapters only:
  - existing `memory_items` data can be migrated or viewed as observations;
  - existing `MemoryItemsRepository` remains a current-code compatibility reference, not the Server beta repository contract.
- Add test helpers that skip Postgres-backed integration tests when no test Postgres URL is configured.

### Documentation References

- Copy current repository behavior and field validation from existing storage code, but implement the canonical Server beta storage in Postgres.
- Copy compatible field constraints from `src/core/schemas/memory-item.ts` only to preserve legacy import/alias behavior; new Server beta schemas should be named around observations.
- Copy migration idempotency patterns from existing storage bootstrap code where applicable.
- Use prior SQLite storage decisions as superseded context only where they conflict with Postgres as canonical Server beta storage.

### Verification Checklist

- Unit tests for repository interfaces using fake adapters where useful.
- Postgres integration tests for:
  - migration/bootstrap idempotency;
  - `ProjectRepository.create(...)` requires a valid `team_id`, lookup returns the owning team, and project-scoped repository writes reject mismatched `team_id`/`project_id` pairs;
  - `ObservationRepository.create(...)` and lookup by project/session/team;
  - `ObservationRepository.search(...)` uses the generated `content_search` column with the GIN-backed `websearch_to_tsquery` path and returns only rows for the requested project/team scope;
  - `ObservationSourcesRepository.addSource(...)` idempotency;
  - `ObservationSourcesRepository.addSource(...)` requires project/team scope and rejects wrong-scope observation/source/job relationships without inserting rows;
  - `AgentEventsRepository.create(...)`, batch insert/reload, lookup by project/session/team, deterministic `idempotency_key` generation when `source_event_id` is present, and deterministic `idempotency_key` fallback when `source_event_id` is omitted;
  - ingesting the same event twice with omitted source event IDs must not create duplicate `agent_events` rows and must not duplicate generation jobs;
  - `ObservationGenerationJobRepository` create/status transition/reload and duplicate-job suppression for event, session summary, and reindex jobs using deterministic `source_type`, `source_id`, and `idempotency_key`;
  - `ObservationGenerationJobRepository.transitionStatus(...)` requires project/team scope in both the conditional update and fallback reload and must not mutate rows when called with the wrong scope;
  - generated observation retry idempotency through `observations.generation_key`, including retrying the same job and parsed observation index/content without creating a duplicate observation;
  - `ObservationGenerationJobEventsRepository` lifecycle append/list tests and outbox event linking through `observation_generation_job_events`;
  - `ObservationGenerationJobEventsRepository.append(...)` requires project/team scope and appends only when the referenced job belongs to that project/team.
- Integration tests skip cleanly with an explicit skip reason when no Postgres test URL is configured.
- `rg -n "MemoryItemsRepository" src/server`
  - new Server beta implementation source must not use legacy repository contracts except in explicit compatibility adapters.

### Anti-Pattern Guards

- Do not make SQLite the canonical Server beta observation store.
- Do not add new Server beta tables named `memory_items` or new repositories named `MemoryItemsRepository`.
- Do not let BullMQ or Redis/Valkey be the source of truth for observations or outbox history.
- Do not hide missing Postgres by silently falling back to worker SQLite.

## Phase 2: Define Server Runtime Boundary

### What To Implement

- Add `src/server/runtime/ServerBetaService.ts`.
- Add `src/server/runtime/create-server-beta-service.ts`.
- Add `src/server/runtime/types.ts` for the service graph:
  - Postgres connection pool;
  - initialized Phase 1 storage bootstrap/migration status;
  - auth mode;
  - queue manager boundary as an inert interface with a disabled/no-op adapter;
  - generation worker manager boundary as an inert interface with a disabled/no-op adapter;
  - provider registry boundary as an inert interface with a disabled/no-op adapter;
  - SSE/event broadcaster boundary as an inert interface with a disabled/no-op adapter;
  - server storage repositories.
- Phase 2 creates lifecycle/runtime boundaries only. It must not implement BullMQ queue processing, provider-backed observation generation, generation workers, or SSE broadcasting; actual queue manager implementation starts in Phase 3, provider/generation implementation starts in later generation phases, and the real event broadcaster is wired only when its phase requires it.
- Route `claude-mem server start|stop|restart|status` to `ServerBetaService`, not `WorkerService`.
- Keep worker commands routed to `WorkerService`.
- Add separate runtime state files:
  - `.server-beta.pid`
  - `.server-beta.port`
  - `.server-beta.runtime.json`
- Add `/v1/info.runtime = "server-beta"` and `/api/health.runtime = "server-beta"` in Server beta.

### Documentation References

- Copy the route-handler composition style from `src/services/server/Server.ts`.
- Copy only lifecycle primitives from `src/services/worker-service.ts`; do not copy the full worker class.
- Copy PID-file safety patterns from `src/services/infrastructure/ProcessManager.ts`.
- Use the prior parity plan section "Phase 2: Independent Server Beta Lifecycle" as the baseline, but strengthen it: independent means no `WorkerService` dependency.

### Verification Checklist

- `rg -n "WorkerService|services/worker-service|worker/http" src/server src/npx-cli/commands/server.ts src/npx-cli/commands/worker.ts`
  - Server runtime source must not import or instantiate `WorkerService`.
- `npx claude-mem server status` reports server-beta state independently of worker state.
- Worker `start|stop|status` commands still work.
- Server beta can start while worker is stopped.
- Server beta can stop without touching worker.

### Anti-Pattern Guards

- Do not overload worker PID/port files.
- Do not implement Server beta by booting worker in the background.
- Do not use worker health as the server health source.

## Phase 3: BullMQ-First Server Queue

### What To Implement

- Add `src/server/jobs/types.ts`:
  - `ServerGenerationJob`
  - `GenerateObservationsForEventJob`
  - `GenerateObservationsForEventBatchJob`
  - `GenerateSessionSummaryJob`
  - `ReindexObservationJob`
  - every job type must carry `team_id`, `project_id`, `source_type`, `source_id`, and `generation_job_id`; event jobs additionally carry `agent_event_id`, summary jobs carry `server_session_id`, and reindex jobs carry the target observation ID or deterministic reindex scope ID.
- Add `src/server/jobs/ServerJobQueue.ts` wrapping BullMQ `Queue`, `Worker`, and `QueueEvents`.
- Add `src/server/jobs/job-id.ts` for deterministic, colon-free job IDs.
- Add `src/server/jobs/outbox.ts` using `ObservationGenerationJobRepository`:
  - durable rows live in `observation_generation_jobs`;
  - source identity lives in `source_type`/`source_id`; lifecycle events live in `observation_generation_job_events`;
  - status fields: `queued`, `processing`, `completed`, `failed`, `cancelled`;
  - attempts, last error, timestamps, project/session/team IDs.
- Make the outbox the durable source of "what should be generated"; BullMQ is the execution transport.
- Add startup reconciliation:
  - enqueue outbox rows in `queued` or stale `processing`;
  - do not enqueue rows for already completed jobs;
  - remove or replace terminal BullMQ jobs before deterministic job ID reuse.
- Add queue health to `/v1/info`, `/api/health`, and `claude-mem server status`.

### Documentation References

- BullMQ Workers docs: use `new Worker(queueName, async job => ...)`, attach `worker.on('error', ...)`, and use worker events for completion/failure.
- BullMQ Concurrency docs: use explicit worker `concurrency`, default conservative value `1` per provider/session lane, configurable later.
- BullMQ Stalled Jobs docs: design jobs as idempotent because active jobs may be moved back to waiting.
- Existing `src/server/queue/BullMqObservationQueueEngine.ts` has tested deterministic job IDs and Redis health wiring; copy its safe ID and health patterns, not its worker-iterator compatibility shape.

### Verification Checklist

- Unit tests for:
  - job ID stability;
  - duplicate enqueue suppression;
  - terminal job replacement;
  - outbox restart reconciliation;
  - failed job retained in Postgres and BullMQ;
  - Redis unavailable fails Server beta startup when BullMQ is selected.
- Integration tests with a fake processor:
  - start Server beta queue manager + Postgres + Valkey;
  - create outbox rows directly through `ObservationGenerationJobRepository`;
  - enqueue fake jobs;
  - restart before fake processing completes;
  - assert reconciliation resumes jobs and marks the outbox exactly once.

### Anti-Pattern Guards

- Do not treat BullMQ completed/failed state as canonical history.
- Do not require event route wiring or provider generation for this phase to pass.
- Do not allow duplicate processor side effects on retry; later observation writes must be idempotent by deterministic observation generation key and source/job ID.
- Do not use BullMQ Pro-only groups.
- Do not leave pending work only in Redis.

## Phase 4: Server-Owned Event-To-Generation-Job Pipeline

### What To Implement

- Change `POST /v1/events` and `POST /v1/events/batch` to:
  1. validate auth and project/team scope;
  2. insert events transactionally;
  3. create server outbox generation jobs in the same transaction;
  4. enqueue corresponding BullMQ jobs after commit.
- Add opt-in request control:
  - default: enqueue generation asynchronously;
  - `?generate=false`: store event only;
  - `?wait=true`: if implemented in this phase, wait only for bounded queue acceptance or job status and return queued/accepted/job status. It must not claim observations were generated.
- Add `GET /v1/jobs/:id` for generation status.
- Keep `POST /v1/memories` only as a compatibility alias for manual/direct observation insertion. It must not call the generator.

### Documentation References

- Copy current REST validation/auth style from `src/server/routes/v1/ServerV1Routes.ts`.
- Copy atomic write approach from the existing fixed `/v1/events/batch` transaction.
- Copy JSON serde and repository behavior from current storage implementations while implementing Postgres-backed Server beta repositories.
- Copy Docker E2E style from `docker/e2e/server-beta-e2e.mjs`.

### Verification Checklist

- `POST /v1/events` returns `event` and `generationJob`.
- `POST /v1/events?generate=false` returns no generation job.
- Event insert and outbox generation-job creation are committed transactionally: no event without its required outbox/job row, and no outbox/job row without its event link.
- A successful event request enqueues the corresponding BullMQ job after commit.
- Mixed-project batch pre-validation rejects the request before any event, outbox/job, or BullMQ enqueue side effect occurs.
- `POST /v1/events?wait=true`, if implemented, returns queued/accepted/job status only; it does not return generated observation IDs or imply provider generation completed.
- Project-scoped API key cannot enqueue generation for another project.

### Anti-Pattern Guards

- Do not call worker `/api/sessions/observations`.
- Do not make `/v1/events` depend on Claude Code-specific hook payload shape.
- Do not generate observations inside the HTTP request without queueing first.
- Do not require provider generation, generated observation IDs, or generated observation duplicate checks for Phase 4 verification.

## Phase 5: Extract Provider Generation Without Worker Coupling

### What To Implement

- Add `src/server/generation/ProviderObservationGenerator.ts`.
- Add provider adapters under `src/server/generation/providers/`:
  - `ClaudeObservationProvider`
  - `GeminiObservationProvider`
  - `OpenRouterObservationProvider`
- Extract common prompt construction and provider-call code from worker providers into reusable modules.
- Keep worker providers as compatibility wrappers that can call the shared provider adapters later.
- Add `src/server/generation/processGeneratedResponse.ts`:
  - parse response with `parseAgentXml(...)`;
  - map parsed observations to a new server observation create schema/repository input;
  - store via `ObservationRepository`;
  - link sources to event/job IDs;
  - update outbox status;
  - audit observation generation.
- Add `GET /v1/events/:id/observations` to inspect generated observations for an event.
- Add `observation_sources.sourceType = "agent_event"` support if not already present, or add a server-specific source table mapping event IDs to observation IDs.
- Add a stable server generation prompt:
  - input: list of `AgentEvent` records plus project/session metadata;
  - output: XML or structured JSON accepted by existing parser;
  - include `<private>` skip behavior.

### Documentation References

- Copy parse/store behavior from `src/services/worker/agents/ResponseProcessor.ts`.
- Copy provider-specific auth and request construction from:
  - `src/services/worker/ClaudeProvider.ts`
  - `src/services/worker/GeminiProvider.ts`
  - `src/services/worker/OpenRouterProvider.ts`
- Copy compatible field constraints from the existing legacy observation schema in `src/core/schemas/memory-item.ts`, but expose the Server beta create contract as an observation schema.
- Keep provider error classification semantics from `src/services/worker/provider-errors.ts`.

### Verification Checklist

- Unit tests using fake provider:
  - valid XML yields an observation;
  - skip/private response marks job completed with no observation;
  - malformed response fails job or marks retryable according to policy;
  - generated observation preserves project/session/source metadata.
- `POST /v1/events?wait=true` returns generated observation IDs only after Phase 5 provider generation and persistence are wired and the job finishes within timeout.
- Replaying the same event/job after restart does not duplicate generated observations.
- Provider classification tests still pass.
- Worker response processor tests still pass.
- `rg -n "services/worker/(ClaudeProvider|GeminiProvider|OpenRouterProvider|agents/ResponseProcessor)" src/server`
  - must return no direct imports from Server beta generation.

### Anti-Pattern Guards

- Do not import `WorkerRef`, `ActiveSession`, or legacy worker session types into server generation.
- Do not mutate legacy `SessionStore` tables from Server beta generation.
- Do not make server provider code assume a Claude Code transcript.

## Phase 6: Server Session Semantics Independent Of Worker Sessions

### What To Implement

- Treat `server_sessions` as the canonical Server beta session model.
- Add fields needed for generation:
  - `contentSessionId` or generic external session ID;
  - `agentId`;
  - `agentType`;
  - `platformSource`;
  - `generationStatus`;
  - `lastGeneratedAtEpoch`.
- Add `ServerSessionRuntimeRepository` helpers:
  - get active session;
  - list unprocessed events;
  - mark generation started/completed/failed.
- Add session-level generation policies:
  - generate per event;
  - batch small event bursts by short debounce window;
  - generate summary on `/v1/sessions/:id/end`.
- Make this policy configurable with server settings.

### Documentation References

- Copy server session repository behavior from current storage code while implementing the Server beta session repository against Postgres.
- Copy queue idle/claim semantics from current BullMQ tests only where they serve idempotency and retry behavior.
- Copy current summary behavior from worker providers, but store summaries as observation records with kind/type `"summary"`.

### Verification Checklist

- Starting/ending a server session does not touch legacy worker session rows except through explicit migration/import code.
- Ending a session enqueues a summary generation job.
- Re-ending a session is idempotent.
- Session-scoped API keys remain project-scoped.

### Anti-Pattern Guards

- Do not require a legacy worker session ID to generate Server beta observations.
- Do not use worker `ActiveSession` as the server runtime state object.

## Phase 7: Hook Routing To Server Beta Without Worker Dependency

### What To Implement

- When installer selects Server beta, hooks should call Server beta endpoints directly:
  - SessionStart -> `/v1/sessions/start` or compatibility endpoint;
  - PostToolUse -> `/v1/events`;
  - Stop/Summarize -> `/v1/sessions/:id/end`.
- Keep worker fallback only as fallback:
  - if Server beta is selected but unhealthy, hook can fall back to worker and log a warning;
  - fallback must be observable in hook output/logs.
- Add a server API-key bootstrap for local hooks:
  - install creates a local hook API key scoped to local project/user;
  - key is stored in local settings with correct file permissions;
  - key rotation command exists.
- Keep existing hook JSON outputs unchanged.

### Documentation References

- Copy hook commands and expected outputs from `plugin/hooks/hooks.json`.
- Copy current hook HTTP call patterns from source files that generate the worker-service bundle, not from the generated bundle itself.
- Copy current installer prompt/setting pattern from `src/npx-cli/commands/install.ts`.

### Verification Checklist

- Lifecycle hook tests pass in worker mode.
- Lifecycle hook tests pass in server-beta mode.
- Server-beta mode with server down falls back to worker and logs one warning.
- Server-beta mode with server healthy does not start worker.
- Generated observation appears after a PostToolUse hook using only Server beta.

### Anti-Pattern Guards

- Do not route Server beta hooks through worker `/api/sessions/observations`.
- Do not silently start worker when Server beta is healthy.
- Do not store hook API keys in generated bundles.

## Phase 8: MCP Uses Server Runtime Directly

### What To Implement

- Add MCP tools backed by Server beta APIs/core logic:
  - `observation_add`
  - `observation_record_event`
  - `observation_search`
  - `observation_context`
  - `observation_generation_status`
- Existing `memory_*` MCP names may remain only as compatibility aliases over the observation tools.
- Existing MCP search tools may continue to work with worker, but Server beta mode must not require worker.
- MCP write tools should create events or direct observations through the same service methods as REST.

### Documentation References

- Copy current MCP tool schema style from `src/servers/mcp-server.ts`.
- Copy new REST schemas from `src/core/schemas/*`.
- Copy auth mode rules from Server beta API-key middleware.

### Verification Checklist

- MCP client can record an event and retrieve generated context without worker running.
- MCP client can search generated observations.
- Existing MCP search tests remain green.

### Anti-Pattern Guards

- Do not duplicate generation logic in MCP tools.
- Do not import `WorkerService` into MCP server mode.

## Phase 9: Compatibility Without Coupling

### What To Implement

- Keep compatibility routes only as adapters:
  - `/api/sessions/observations` -> convert legacy payload to `AgentEvent` -> enqueue Server beta generation job.
  - `/api/sessions/summarize` -> convert legacy payload to session-end/summary job.
  - legacy data/search routes -> read from Server beta repositories or explicit migration views.
- Compatibility adapters may live in `src/server/compat/*`.
- They must call Server beta services, not worker route classes.
- Add a parity map documenting each legacy route:
  - native server implementation;
  - adapter implementation;
  - intentionally unsupported in Server beta.

### Documentation References

- Copy payload normalization from `src/services/worker/http/shared.ts`.
- Copy Claude Code mapper style from `src/adapters/claude-code/mapper.ts`.
- Copy route response snapshots from existing worker route tests.

### Verification Checklist

- `rg -n "services/worker/http/routes|WorkerService" src/server/compat src/server/runtime`
  - must return no imports.
- Legacy PostToolUse route on Server beta creates an event and generation job.
- Viewer compatibility routes do not require worker.

### Anti-Pattern Guards

- Do not copy worker route classes wholesale into Server beta.
- Do not let compatibility adapters become the canonical Server API.

## Phase 10: Docker And Deployable Runtime

### What To Implement

- Docker image starts Server beta only:
  - no worker process;
  - no worker PID;
  - no worker health dependency.
- Compose stack includes:
  - Server beta container;
  - Postgres container for canonical observation/job/session storage;
  - Valkey container for BullMQ.
- Add env validation:
  - `CLAUDE_MEM_RUNTIME=server-beta`
  - `CLAUDE_MEM_QUEUE_ENGINE=bullmq`
  - Postgres URL required.
  - Redis/Valkey URL required.
  - API-key auth required by default.
- Add optional separate generation worker process mode:
  - `claude-mem server worker start`
  - same codebase, separate process, same BullMQ queues.

### Documentation References

- Copy current Docker E2E style from `scripts/e2e-server-beta-docker.sh`.
- Copy current Docker image layout from `docker/claude-mem/Dockerfile`.
- Copy Valkey settings from `plans/2026-05-06-redis-dependency-strategy.md`.

### Verification Checklist

- Docker E2E starts no worker.
- `docker compose ps` shows server + Postgres + Valkey.
- `/v1/events?wait=true` creates generated observations.
- Restart server mid-job and verify retry/idempotency.
- Revoke API key and verify write/search denial.

### Anti-Pattern Guards

- Do not install or spawn worker in the Server beta container.
- Do not use local-dev auth in Docker.
- Do not use a process-local queue in Docker.

## Phase 11: Team-Aware Generation

### What To Implement

- Ensure every generation job carries:
  - `team_id`;
  - `project_id`;
  - actor/API-key ID;
  - source adapter.
- Enforce scopes before event insert and before job execution.
- Store generated observations with team/project metadata.
- Audit:
  - event received;
  - job queued;
  - provider generation started;
  - observation generated;
  - observation served.
- Add team-level queue status endpoint:
  - `/v1/teams/:id/jobs`
  - `/v1/projects/:id/jobs`

### Documentation References

- Copy API-key/team storage patterns from `src/storage/sqlite/teams.ts` and `src/storage/sqlite/auth.ts`.
- Copy project-scoping guards from `src/server/routes/v1/ServerV1Routes.ts`.
- Copy audit repository style from current server storage.

### Verification Checklist

- Team-scoped key cannot read/write/generate outside team projects.
- Project-scoped key cannot enqueue generation for another project.
- Generated observation includes correct team/project IDs.
- Audit records include generation job IDs.

### Anti-Pattern Guards

- Do not let BullMQ job data become an auth bypass.
- Do not trust job payload project/team IDs without reloading the outbox row from Postgres.

## Phase 12: Observability And Operations

### What To Implement

- Add `claude-mem server jobs status`.
- Add `claude-mem server jobs retry <id>`.
- Add `claude-mem server jobs cancel <id>`.
- Add `claude-mem server jobs failed`.
- Add queue metrics:
  - waiting;
  - active;
  - completed;
  - failed;
  - delayed;
  - stalled event count.
- Add logs with request ID/job ID correlation.
- Add `/v1/jobs` list endpoint.

### Documentation References

- BullMQ Workers docs for worker `completed`, `failed`, `progress`, and `error` events.
- BullMQ Stalled Jobs docs for stalled event behavior and rare-stall assumption.
- Existing `src/services/worker/http/routes/LogsRoutes.ts` for log tailing style.

### Verification Checklist

- Failed provider response appears in `server jobs failed`.
- Retry moves job back to queued and generates an observation once.
- Cancel prevents later generation.
- Stalled events are logged with job ID.

### Anti-Pattern Guards

- Do not expose full sensitive event payloads in queue status by default.
- Do not retry non-idempotently.

## Phase 13: Final Verification Gate

Phase 13 is not an implementation phase and does not need the implementation-phase template. It is the final release gate for proving the independently implemented Server beta runtime is complete, durable, and still compatible with the legacy worker runtime.

### Required Automated Tests

- Unit:
  - provider generation parser;
  - event-to-job transaction;
  - job ID/idempotency;
  - team/project auth on generation;
  - compatibility route adapters.
- Integration:
  - Server beta starts without worker;
  - `/v1/events` generates observations;
  - hook PostToolUse generates observations through Server beta;
  - MCP event write generates observations through Server beta;
  - restart during active generation retries safely.
- Docker:
  - Server beta + Postgres + Valkey;
  - API-key auth;
  - event generation;
  - restart persistence;
  - revoked-key denial;
  - no worker process.

### Required Greps

```bash
rg -n "new WorkerService|services/worker-service|services/worker/http/routes" src/server
rg -n "PendingMessageStore|SessionQueueProcessor" src/server
rg -n "CLAUDE_MEM_AUTH_MODE=local-dev|ALLOW_LOCAL_DEV_BYPASS" docker docs/server.md
rg -n "POST /v1/events|generationJob|wait=true" docs README.md
```

Expected:

- First two greps return no Server beta runtime imports.
- Docker docs do not recommend local-dev auth.
- Docs mention event generation semantics.

### Manual Verification

1. Start worker, confirm existing worker flow still works.
2. Stop worker.
3. Start Server beta with Valkey.
4. Submit a generic REST event.
5. Confirm observations appear without worker running.
6. Submit a Claude Code PostToolUse payload through Server beta hook routing.
7. Confirm observations appear without worker running.
8. Restart Server beta during a provider call.
9. Confirm the job retries and generates once.

### Exit Criteria

Server beta is independent when all are true:

- Server beta can generate observations while worker is stopped.
- Docker Server beta image does not spawn worker.
- `/v1/events` can enqueue and generate observations.
- Hook routing to Server beta generates observations when healthy.
- BullMQ queue state survives restart and retries safely.
- Postgres server storage is the source of truth for observations and generation job history.
- The worker remains available as a separate stable runtime.
