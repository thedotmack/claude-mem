// SPDX-License-Identifier: Apache-2.0

import pg, { type Pool as PgPool, type PoolClient as PgPoolClient } from 'pg';
import { parsePostgresConfig, type PostgresConfig } from './config.js';

const { Pool } = pg;

export type PostgresPool = PgPool;
export type PostgresPoolClient = PgPoolClient;

let sharedPool: PostgresPool | null = null;

export function createPostgresPool(config: PostgresConfig): PostgresPool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    ssl: config.ssl
  });
}

export function getSharedPostgresPool(options: { requireDatabaseUrl?: boolean } = {}): PostgresPool {
  if (sharedPool) {
    return sharedPool;
  }
  const config = parsePostgresConfig({ requireDatabaseUrl: options.requireDatabaseUrl ?? true });
  if (!config) {
    throw new Error('Postgres requires CLAUDE_MEM_SERVER_DATABASE_URL');
  }
  sharedPool = createPostgresPool(config);
  return sharedPool;
}

export async function checkPostgresHealth(pool: PostgresPool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function withPostgresTransaction<T>(
  pool: PostgresPool,
  fn: (client: PostgresPoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePostgresPool(pool: PostgresPool): Promise<void> {
  if (pool === sharedPool) {
    sharedPool = null;
  }
  await pool.end();
}
