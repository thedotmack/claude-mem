// SPDX-License-Identifier: Apache-2.0
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import type { PostgresPool } from '../../../src/storage/postgres/pool.js';
import { createPostgresPool, withPostgresTransaction } from '../../../src/storage/postgres/pool.js';

test('an idle database connection error is handled by the pool', async () => {
  const pool = createPostgresPool({
    connectionString: 'postgres://localhost/unused', max: 1, idleTimeoutMillis: 100,
    connectionTimeoutMillis: 100, statementTimeoutMillis: 100, ssl: false,
  });
  try {
    assert.doesNotThrow(() => pool.emit('error', new Error('connection terminated')));
  } finally {
    await pool.end();
  }
});

test('a failed rollback preserves the primary error and discards the client', async () => {
  const original = new Error('business write failed');
  const released: (Error | boolean | undefined)[] = [];
  const pool = { connect: async () => ({
    query: async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connection closed');
    },
    release: (destroy?: Error | boolean) => { released.push(destroy); },
  }) } as unknown as PostgresPool;
  await assert.rejects(withPostgresTransaction(pool, async () => { throw original; }),
    (error: unknown) => error === original);
  assert.deepEqual(released, [true]);
});
