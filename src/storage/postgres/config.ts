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

const DEFAULT_POOL_MAX = 10;
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
    max: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_POOL_MAX, DEFAULT_POOL_MAX),
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
