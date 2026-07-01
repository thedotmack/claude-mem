// SPDX-License-Identifier: Apache-2.0
//
// Shared Postgres test isolation for the SDK integration suite.
//
// Each test runs in its own schema. The pool pins `search_path` via the
// libpq `options` startup parameter, so EVERY pooled connection lands in
// that schema deterministically — the value is set in the connection
// startup packet before any query runs.
//
// This replaces the previous per-file harness, which set search_path with
// a fire-and-forget `pool.on('connect', c => c.query('SET search_path...'))`
// listener. That listener's query was not awaited, so the SDK's first
// `CREATE TABLE` (during bootstrapServerPostgresSchema) could execute on a
// freshly-acquired connection before the SET landed, intermittently failing
// with `3F000: no schema has been selected to create in`.

import pg from 'pg';

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Create a fresh, uniquely-named schema and return its name. The name is
 * `<prefix>_<uuid-with-underscores>`, i.e. only `[a-z0-9_]`, so it is safe
 * to interpolate into the unquoted `-c search_path=` libpq option below.
 */
export async function createIsolatedSchema(
  connectionString: string,
  prefix: string
): Promise<string> {
  const schemaName = `${prefix}_${crypto.randomUUID().replaceAll('-', '_')}`;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  } finally {
    await client.end();
  }
  return schemaName;
}

/**
 * A pool whose every connection starts with `search_path` pinned to
 * `schemaName`. Deterministic: the search_path is applied in the connection
 * startup packet, so there is no window in which a query runs before it
 * takes effect.
 */
export function poolForSchema(connectionString: string, schemaName: string): pg.Pool {
  return new pg.Pool({ connectionString, options: `-c search_path=${schemaName}` });
}

/** Drop the isolated schema and everything in it. Best-effort. */
export async function dropSchema(
  connectionString: string,
  schemaName: string
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
  } finally {
    await client.end();
  }
}
