// SPDX-License-Identifier: Apache-2.0
import { logger } from '../../utils/logger.js';

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

  const ssl = parseSsl(connectionString, env);
  return {
    // node-postgres parses the URL again when a pool creates a client, and
    // its URL SSL parameters replace the separate `ssl` option. Carry the
    // explicit application override into that parse too, retaining any URL
    // certificate paths and unrelated connection settings.
    // An unrecognized override (say `true` or a typo) is not a policy: leave
    // the URL alone so its own sslmode still applies, as before this rewrite.
    connectionString: env.CLAUDE_MEM_POSTGRES_SSL && isRecognizedSslMode(env.CLAUDE_MEM_POSTGRES_SSL)
      ? connectionStringWithSslOverride(connectionString, ssl)
      : connectionString,
    max: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_POOL_MAX, DEFAULT_POOL_MAX),
    idleTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS),
    statementTimeoutMillis: parsePositiveInt(env.CLAUDE_MEM_POSTGRES_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS),
    ssl,
  };
}

function connectionStringWithSslOverride(connectionString: string, ssl: PostgresConfig['ssl']): string {
  // pg also accepts hostless user@/ URLs and relative connection strings
  // that new URL(string) rejects. Change only the query, leaving authority,
  // credentials and path interpretation to pg's own parser. Its Unix socket
  // shorthand is not a URL and never overrides the separate ssl option.
  if (connectionString.startsWith('/')) return connectionString;
  const fragmentAt = connectionString.indexOf('#');
  const beforeFragment = fragmentAt < 0 ? connectionString : connectionString.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : connectionString.slice(fragmentAt);
  const queryAt = beforeFragment.indexOf('?');
  const base = queryAt < 0 ? beforeFragment : beforeFragment.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? '' : beforeFragment.slice(queryAt + 1));
  params.set('sslmode', ssl === false
    ? 'disable'
    : typeof ssl === 'object' && ssl.rejectUnauthorized === false ? 'no-verify' : 'verify-full');
  // Remove the driver's alternate SSL setting as well as the libpq branch
  // (which does not recognize no-verify). Certificate paths remain intact.
  params.delete('ssl');
  params.delete('uselibpqcompat');
  return `${base}?${params.toString()}${fragment}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSsl(connectionString: string, env: NodeJS.ProcessEnv): boolean | { rejectUnauthorized: boolean } {
  if (env.CLAUDE_MEM_POSTGRES_SSL) {
    return sslForMode(env.CLAUDE_MEM_POSTGRES_SSL.trim().toLowerCase());
  }

  // An explicit sslmode URL parameter wins over PGSSLMODE, matching libpq
  // precedence; every mode must be honored — a silent fall-through to
  // plaintext would downgrade an operator who asked for verified TLS.
  let urlMode: string | null = null;
  try {
    urlMode = new URL(connectionString).searchParams.get('sslmode');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('DB', 'Failed to parse Postgres connection string for sslmode, defaulting SSL off', {}, err);
    return false;
  }

  const mode = (urlMode ?? env.PGSSLMODE)?.trim().toLowerCase();
  return mode ? sslForMode(mode) : false;
}

const RECOGNIZED_SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

export function isRecognizedSslMode(mode: string): boolean {
  return RECOGNIZED_SSL_MODES.has(mode.trim().toLowerCase());
}

function sslForMode(mode: string): boolean | { rejectUnauthorized: boolean } {
  switch (mode) {
    case 'disable':
      return false;
    // allow/prefer/require all mean "encrypt, don't verify" as far as node-pg
    // is concerned — it has no connect-fallback ladder like libpq.
    case 'allow':
    case 'prefer':
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      logger.warn(
        'DB',
        `Unrecognized Postgres sslmode "${mode}", falling back to plaintext — valid modes are disable, allow, prefer, require, verify-ca, verify-full`
      );
      return false;
  }
}
