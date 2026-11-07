// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../utils/logger.js';
import type { PostgresQueryable } from './utils.js';

export const SERVER_POSTGRES_SCHEMA_VERSION = 1;

// Phase 1b (cmem-sdk rename): the TS constant is renamed but the table-name
// strings remain on `server_beta_*` since they are persisted DDL identifiers.
// Plan §1d will migrate the table names in a coordinated DDL change.
export const SERVER_POSTGRES_TABLES = [
  'server_beta_schema_migrations',
  'teams',
  'projects',
  'team_members',
  'api_keys',
  'audit_log',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
  'usage_events',
  'rate_limit_counters'
] as const;

/**
 * 'on' creates the vector table where pgvector is installable and 'off' leaves
 * it out. 'auto' creates it on a new database and keeps one already there, so
 * a deployment from before search by meaning stays keyword-only.
 */
export type VectorSchemaMode = 'on' | 'off' | 'auto';

export async function bootstrapServerPostgresSchema(
  client: PostgresQueryable,
  vectors: VectorSchemaMode = 'on',
  // all-MiniLM-L6-v2's width, the default model's (services/vector/models.ts).
  embeddingDims = 384,
): Promise<void> {
  if (isPostgresPool(client)) {
    const poolClient = await client.connect();
    try {
      await bootstrapServerPostgresSchema(poolClient, vectors, embeddingDims);
      bm25InUse.set(client, usesBm25Index(poolClient));
    } finally {
      poolClient.release();
    }
    return;
  }

  await client.query('BEGIN');
  try {
    const createVectors = vectors === 'on' || (vectors === 'auto' && await isNewOrVectorDatabase(client));
    await applyPhase1Migration(client);
    await applyBm25Index(client);
    if (createVectors) await applyVectorSchema(client, embeddingDims);
    await client.query('COMMIT');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('SYSTEM', 'postgres schema bootstrap failed, rolling back', {}, err);
    await client.query('ROLLBACK');
    throw error;
  }
}

// Checked before the migration runs: no migrations table means a new database.
// Looked up in the schema the tables are created in, not the whole search_path.
async function isNewOrVectorDatabase(client: PostgresQueryable): Promise<boolean> {
  const result = await client.query<{ create: boolean }>(
    `SELECT to_regclass(format('%I.server_beta_schema_migrations', current_schema())) IS NULL
         OR to_regclass(format('%I.observation_embeddings', current_schema())) IS NOT NULL AS create`
  );
  return result.rows[0]?.create === true;
}

// #2541 — the api_keys upgrade DDL, shared by the full phase-1 bootstrap and
// the standalone ensureApiKeySchema() below. Both statements are idempotent:
// fresh installs get key_prefix from CREATE TABLE, existing databases add it
// here, and the index keeps the prefix lookup from scanning every hosted
// team's keys.
export const API_KEY_SCHEMA_SQL = `
ALTER TABLE IF EXISTS api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
`;

/**
 * #2541 — apply the api_keys upgrade without running the full server
 * bootstrap. The standalone key commands (`server api-key create`,
 * `server keys rotate`, `keys rotate` in the npx CLI) may run against an
 * existing database before any new server process has started, and they
 * query/write `key_prefix`. Called at each of those entry points so the
 * column and its index exist first. A no-op on a database where api_keys
 * has not been created yet — a fresh database gets the full schema from
 * the server's normal bootstrap.
 */
export async function ensureApiKeySchema(client: PostgresQueryable): Promise<void> {
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('api_keys') IS NOT NULL AS present`,
  );
  if (table.rows[0]?.present !== true) return;
  await client.query(API_KEY_SCHEMA_SQL);
}

async function applyPhase1Migration(client: PostgresQueryable): Promise<void> {
  await client.query(PHASE_1_SCHEMA_SQL);
  await client.query(
    `
      INSERT INTO server_beta_schema_migrations (version, description)
      VALUES ($1, $2)
      ON CONFLICT (version) DO NOTHING
    `,
    [SERVER_POSTGRES_SCHEMA_VERSION, 'phase 1 postgres observation storage foundation']
  );
}

const BM25_INDEX_NAME = 'idx_observations_content_bm25';

// On the postgres-pgvector-textsearch image, which installs and preloads
// pg_textsearch, keyword search ranks by bm25 through an index over
// observation content, tokenized as content_search is. On other Postgres the
// extension cannot be created or used (not installed, not preloaded, or not a
// superuser), so this fails under a savepoint, the bootstrap goes on, and
// search is unchanged. Recorded per pool or client, so a search runs no query
// to find out.
const bm25InUse = new WeakMap<PostgresQueryable, boolean>();

async function applyBm25Index(client: PostgresQueryable): Promise<void> {
  await client.query('SAVEPOINT bm25_index');
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_textsearch SCHEMA public');
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${BM25_INDEX_NAME} ON observations USING bm25 (content) WITH (text_config = 'english')`
    );
    // search()'s ordering, run once: it fails if the library is not
    // preloaded or the extension is outside public.
    await client.query(`SELECT 1 FROM observations ORDER BY ${bm25Order('$1')} LIMIT 1`, ['probe']);
    await client.query('RELEASE SAVEPOINT bm25_index');
    bm25InUse.set(client, true);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT bm25_index');
    bm25InUse.set(client, false);
    // Expected on Postgres without pg_textsearch; the reason tells that apart
    // from a broken setup on an image that has it.
    logger.info('SYSTEM', 'pg_textsearch bm25 is not in use; keyword search ranks by ts_rank', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** ORDER BY for search() on pg_textsearch: its operator and function in public, given the query's parameter. */
export function bm25Order(queryParam: string): string {
  return `observations.content OPERATOR(public.<@>) public.to_bm25query(${queryParam}, '${BM25_INDEX_NAME}'), observations.id`;
}

export function usesBm25Index(client: PostgresQueryable): boolean {
  return bm25InUse.get(client) === true;
}

// Search by meaning needs the pgvector extension, which stock postgres images
// do not ship. Where it is not installable the table is not created and
// search stays keyword-only, so an existing deployment boots unchanged.
async function applyVectorSchema(client: PostgresQueryable, dims: number): Promise<void> {
  const available = await client.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`
  );
  if (available.rows.length === 0) {
    logger.info('SYSTEM', 'pgvector is not installed in this Postgres; search stays keyword-only');
    return;
  }
  // pgvector is not a trusted extension: only a superuser can create it. It
  // is created only where it is missing, under a savepoint, so a role that
  // may not create it boots keyword-only instead of failing the bootstrap.
  const installed = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
  if (installed.rows.length === 0) {
    await client.query('SAVEPOINT create_vector');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('RELEASE SAVEPOINT create_vector');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT create_vector');
      logger.warn('SYSTEM', 'this role cannot create the pgvector extension; search stays keyword-only until an administrator runs CREATE EXTENSION vector', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }
  // An extension lives in one schema per database. Installed earlier into a
  // schema outside this connection's search_path, its type cannot be named
  // here, so this schema goes without vectors rather than failing to boot.
  const visible = await client.query<{ visible: boolean }>(
    `SELECT to_regtype('vector') IS NOT NULL AS visible`
  );
  if (visible.rows[0]?.visible !== true) {
    logger.warn('SYSTEM', 'pgvector is installed in a schema outside the search_path; search stays keyword-only');
    return;
  }
  // Vector search is filtered to one project, and only HNSW iterative scans
  // (pgvector 0.8.0) keep reading the index until the filter is satisfied;
  // without them a project whose rows are not among the nearest overall
  // would get no semantic matches at all.
  const version = await client.query<{ supported: boolean }>(
    `SELECT string_to_array(extversion, '.')::int[] >= '{0,8,0}' AS supported
     FROM pg_extension WHERE extname = 'vector'`
  );
  if (version.rows[0]?.supported !== true) {
    logger.warn('SYSTEM', 'pgvector is older than 0.8.0; search stays keyword-only');
    return;
  }
  // The column's width is the embedding model's (models.ts). Vectors of
  // another width can be neither indexed with these nor compared to them, so
  // a model of a different width starts from an empty table, which the
  // backfill refills; one of the same width keeps the table and is re-embedded
  // row by row, since rows from another model count as missing.
  const stored = await client.query<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute
     WHERE attrelid = to_regclass('observation_embeddings') AND attname = 'embedding' AND NOT attisdropped`
  );
  const storedDims = stored.rows[0]?.dims;
  if (storedDims !== undefined && storedDims !== dims) {
    logger.warn('SYSTEM', 'embedding model width changed; dropping stored vectors to re-embed them', {
      from: storedDims,
      to: dims,
    });
    await client.query('DROP TABLE observation_embeddings');
  }
  await client.query(vectorSchemaSql(dims));
}

interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

function isPostgresPool(client: PostgresQueryable): client is PostgresPoolLike {
  const candidate = client as {
    connect?: unknown;
    release?: unknown;
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
  };
  return (
    typeof candidate.connect === 'function'
    && typeof candidate.release !== 'function'
    && typeof candidate.totalCount === 'number'
    && typeof candidate.idleCount === 'number'
    && typeof candidate.waitingCount === 'number'
  );
}

const PHASE_1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS server_beta_schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, team_id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  -- Non-secret first-N-chars of the raw key. Salted scrypt hashes are not
  -- deterministic per raw key, so verification narrows candidates by this
  -- prefix (mirrors the SQLite backend's prefix column, #2541).
  key_prefix TEXT,
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

CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE TABLE IF NOT EXISTS server_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  external_session_id TEXT,
  idempotency_key TEXT,
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
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_events (
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

CREATE TABLE IF NOT EXISTS observation_generation_jobs (
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

CREATE TABLE IF NOT EXISTS observations (
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
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observation_sources (
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

CREATE TABLE IF NOT EXISTS observation_generation_job_events (
  id TEXT PRIMARY KEY,
  generation_job_id TEXT NOT NULL REFERENCES observation_generation_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('queued', 'enqueued', 'processing', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  status_after TEXT NOT NULL CHECK (status_after IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_project_session ON agent_events(project_id, server_session_id, occurred_at);
ALTER TABLE server_sessions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE server_sessions DROP CONSTRAINT IF EXISTS server_sessions_project_id_external_session_id_key;
-- #2541 — non-secret key prefix for salted-hash candidate narrowing (the
-- CREATE TABLE above carries it for fresh installs; existing DBs upgrade here),
-- plus the lookup index so auth does not scan the table.
ALTER TABLE IF EXISTS api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
-- #2560 — platform_source on agent_events (consistent with server_sessions and
-- the plan-09 scoping): which platform produced the event (claude-code,
-- opencode, cursor, ...). Idempotent so an existing DB upgrades in place.
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS platform_source TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_events_platform_source
  ON agent_events(team_id, project_id, platform_source, occurred_at)
  WHERE platform_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_sessions_platform_source
  ON server_sessions(team_id, project_id, platform_source, started_at)
  WHERE platform_source IS NOT NULL;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS content_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_generation_key_key;
ALTER TABLE observation_generation_jobs DROP CONSTRAINT IF EXISTS observation_generation_jobs_source_type_source_id_job_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_project_idempotency
  ON server_sessions(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_external_session_legacy
  ON server_sessions(project_id, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_external_session_platform
  ON server_sessions(project_id, platform_source, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NOT NULL;
DROP INDEX IF EXISTS idx_server_sessions_content_session;
-- Supports platform-aware session linkage lookup on the /v1/events ingest path.
CREATE INDEX IF NOT EXISTS idx_server_sessions_content_session_platform
  ON server_sessions(team_id, project_id, platform_source, content_session_id, started_at DESC)
  WHERE content_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_generation_key_scope
  ON observations(team_id, project_id, generation_key)
  WHERE generation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_jobs_source_scope
  ON observation_generation_jobs(team_id, project_id, source_type, source_id, job_type);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_events_team_project ON agent_events(team_id, project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_observations_project_session ON observations(project_id, server_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_team_project ON observations(team_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_content_search ON observations USING GIN (content_search);
CREATE INDEX IF NOT EXISTS idx_observation_sources_event ON observation_sources(agent_event_id);
CREATE INDEX IF NOT EXISTS idx_observation_sources_source ON observation_sources(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_status_next_attempt ON observation_generation_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_team_project ON observation_generation_jobs(team_id, project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_event ON observation_generation_jobs(agent_event_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_source ON observation_generation_jobs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_processing_locked_at ON observation_generation_jobs(locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_observation_job_events_job_created ON observation_generation_job_events(generation_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_scope_created ON audit_log(project_id, team_id, created_at);

-- Usage metering: append-only per-team usage, aggregated for quotas + billing.
-- kind is open-ended ('request', 'tokens_in', 'tokens_out', 'observation', ...).
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_team_created ON usage_events(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_team_kind_created ON usage_events(team_id, kind, created_at);

-- Fixed-window rate-limit counters. subject_id is the api key id (per-key limit).
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  subject_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_start);
`;

// One vector per part of an observation (narrative, legacy text, each fact,
// or each summary field), not per observation: all-MiniLM-L6-v2 reads 256
// word pieces, about 1,000 characters, and observations average more than
// that. Part names match the Chroma document suffixes (obs_<id>_<part>,
// summary_<id>_<part>) so vectors carried over from Chroma line up.
const vectorSchemaSql = (dims: number) => `
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  part TEXT NOT NULL,
  model TEXT NOT NULL,
  embedding vector(${dims}) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (observation_id, part)
);
CREATE INDEX IF NOT EXISTS idx_observation_embeddings_hnsw
  ON observation_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_observation_embeddings_scope
  ON observation_embeddings(team_id, project_id);
`;
