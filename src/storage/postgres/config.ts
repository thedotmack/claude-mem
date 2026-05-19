// SPDX-License-Identifier: Apache-2.0

export interface PostgresConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  ssl: boolean | { rejectUnauthorized: boolean };
}

export interface ParsePostgresConfigOptions {
  env?: NodeJS.ProcessEnv;
  requireDatabaseUrl?: boolean;
}

// fix — default Postgres pool size now depends on container mode so
// the SUM of connections across workers + server stays under Postgres's
// default `max_connections = 100`. Connection budget per container mode:
//   server  -> CLAUDE_MEM_CONTAINER_MODE=server  -> default max = 10
//   worker  -> CLAUDE_MEM_CONTAINER_MODE=worker  -> default max = 5
//   other   -> CLI tools / tests / unspecified  -> default max = 10
// Sizing rule of thumb: N workers × 5 + 1 server × 10 < Postgres max_connections.
// Operators override per-container via CLAUDE_MEM_POSTGRES_POOL_MAX.
const DEFAULT_POOL_MAX_SERVER = 10;
const DEFAULT_POOL_MAX_WORKER = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export function getPostgresDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CLAUDE_MEM_SERVER_DATABASE_URL || null;
}

export function parsePostgresConfig(options: ParsePostgresConfigOptions = {}): PostgresConfig | null {
  const env = options.env ?? process.env;
  const connectionString = getPostgresDatabaseUrl(env);
  if (!connectionString) {
    if (options.requireDatabaseUrl) {
      throw new Error('Postgres requires CLAUDE_MEM_SERVER_DATABASE_URL');
    }
    return null;
  }

  return {
    connectionString,
    max: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_POOL_MAX, defaultPoolMaxForMode(env.CLAUDE_MEM_CONTAINER_MODE)),
    idleTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS),
    statementTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS),
    ssl: parseSsl(connectionString, env)
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// helper — pick the pool default by container role. Anything other
// than 'worker' falls through to the server default so CLI tools / tests get
// the safer larger pool unless explicitly overridden.
function defaultPoolMaxForMode(mode: string | undefined): number {
  if ((mode ?? '').trim().toLowerCase() === 'worker') {
    return DEFAULT_POOL_MAX_WORKER;
  }
  return DEFAULT_POOL_MAX_SERVER;
}

function parseSsl(connectionString: string, env: NodeJS.ProcessEnv): boolean | { rejectUnauthorized: boolean } {
  if (env.CLAUDE_MEM_POSTGRES_SSL === 'disable' || env.PGSSLMODE === 'disable') {
    return false;
  }
  if (env.CLAUDE_MEM_POSTGRES_SSL === 'require' || env.PGSSLMODE === 'require') {
    return { rejectUnauthorized: false };
  }

  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'require') {
      return { rejectUnauthorized: false };
    }
  } catch {
    return false;
  }

  return false;
}
