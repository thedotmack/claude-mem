// SPDX-License-Identifier: Apache-2.0

import pg, { type Pool as PgPool, type PoolClient as PgPoolClient } from 'pg';
import { parsePostgresConfig, type PostgresConfig } from './config.js';
import { logger } from '../../utils/logger.js';

const { Pool } = pg;

export type PostgresPool = PgPool;
export type PostgresPoolClient = PgPoolClient;

let sharedPool: PostgresPool | null = null;

export function createPostgresPool(config: PostgresConfig): PostgresPool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    ssl: config.ssl
  });
  // pg-pool evicts the idle client before emitting this event. Without an
  // error listener a database restart can bring down the whole Node process.
  pool.on('error', (error: Error) => logger.warn('DB', 'Idle Postgres connection lost', {}, error));
  return pool;
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

export async function withPostgresTransaction<T>(
  pool: PostgresPool,
  fn: (client: PostgresPoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      await client.query('ROLLBACK');
      logger.warn('DB', 'Postgres transaction rolled back', {}, err);
    } catch (rollbackError) {
      discard = true;
      logger.warn('DB', 'Postgres rollback failed; discarding connection', {},
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function closePostgresPool(pool: PostgresPool): Promise<void> {
  if (pool === sharedPool) {
    sharedPool = null;
  }
  await pool.end();
}
