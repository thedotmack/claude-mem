import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { ConnectionOptions } from 'node:tls';
import { parsePostgresConfig } from '../../../src/storage/postgres/config.js';
import { createPostgresPool } from '../../../src/storage/postgres/pool.js';

async function driverParameters(url: string, override: string): Promise<{
  ssl: boolean | ConnectionOptions; host: string; database: string; user: string; password: string;
}> {
  const config = parsePostgresConfig({ env: {
    CLAUDE_MEM_SERVER_DATABASE_URL: url, CLAUDE_MEM_POSTGRES_SSL: override,
  } })!;
  const pool = createPostgresPool(config);
  try {
    // Use the real driver's connection parsing, as Pool does when it opens a
    // client. Inspecting config.ssl alone misses the URL's second override.
    const client = new pg.Client((pool as unknown as { options: pg.ClientConfig }).options);
    return (client as unknown as { connectionParameters: Awaited<ReturnType<typeof driverParameters>> }).connectionParameters;
  } finally {
    await pool.end();
  }
}

async function driverSsl(url: string, override: string): Promise<boolean | ConnectionOptions> {
  return (await driverParameters(url, override)).ssl;
}

describe('explicit PostgreSQL TLS policy at the driver boundary', () => {
  it('requires verified TLS even when the connection URL disables it', async () => {
    const ssl = await driverSsl('postgresql://user:password@localhost/db?sslmode=disable', 'verify-full');
    assert.ok(ssl, 'explicit verified TLS must not become plaintext');
    assert.notEqual(typeof ssl === 'object' && ssl.rejectUnauthorized, false);
  });

  for (const conflicting of ['disable', 'no-verify']) {
    it(`enforces verified TLS on a hostless driver URL with sslmode=${conflicting}`, async () => {
      const params = await driverParameters(`postgresql://user:fixture@/db?host=db.example.com&sslmode=${conflicting}`, 'verify-full');
      assert.ok(params.ssl);
      assert.notEqual(typeof params.ssl === 'object' && params.ssl.rejectUnauthorized, false);
      assert.equal(params.host, 'db.example.com');
      assert.equal(params.database, 'db');
      assert.equal(params.user, 'user');
      assert.equal(params.password, 'fixture');
    });
  }

  it('enforces the override on relative connection strings accepted by the driver', async () => {
    const params = await driverParameters('db?host=db.example.com&sslmode=disable', 'verify-full');
    assert.ok(params.ssl);
    assert.notEqual(typeof params.ssl === 'object' && params.ssl.rejectUnauthorized, false);
    assert.equal(params.host, 'db.example.com');
    assert.equal(params.database, 'db');
  });

  it('honors disable and encryption-only overrides on hostless URLs too', async () => {
    const url = 'postgresql://user@/db?host=db.example.com&sslmode=verify-full&uselibpqcompat=true';
    assert.equal(await driverSsl(url, 'disable'), false);
    assert.equal((await driverSsl(url, 'require') as ConnectionOptions).rejectUnauthorized, false);
  });

  it('replaces duplicate modes and SSL aliases without parsing fragment text as a query', async () => {
    const url = 'postgresql://user@/db?host=db.example.com&sslmode=disable&sslmode=no-verify&ssl=0#sslmode=disable';
    const ssl = await driverSsl(url, 'verify-full');
    assert.ok(ssl);
    assert.notEqual(typeof ssl === 'object' && ssl.rejectUnauthorized, false);
    const config = parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: url, CLAUDE_MEM_POSTGRES_SSL: 'verify-full' } })!;
    assert.equal(config.connectionString.endsWith('#sslmode=disable'), true);
  });

  it('removes the alternate SSL setting from socket URLs without changing their identity', async () => {
    const params = await driverParameters('socket:/var/run/postgresql?db=memory&ssl=no-verify', 'verify-full');
    assert.equal(params.host, '/var/run/postgresql');
    assert.equal(params.database, 'memory');
    assert.ok(params.ssl);
    assert.notEqual(typeof params.ssl === 'object' && params.ssl.rejectUnauthorized, false);
  });

  it('preserves the driver\'s Unix socket shorthand and applies its separate SSL option', async () => {
    const url = '/var/run/postgresql memory';
    const config = parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: url, CLAUDE_MEM_POSTGRES_SSL: 'disable' } })!;
    assert.equal(config.connectionString, url);
    const params = await driverParameters(url, 'disable');
    assert.equal(params.host, '/var/run/postgresql');
    assert.equal(params.database, 'memory');
    assert.equal(params.ssl, false);
  });

  it('honors an explicit disable over a URL TLS mode', async () => {
    const ssl = await driverSsl('postgresql://localhost/db?sslmode=verify-full', 'disable');
    assert.equal(ssl, false);
  });

  it('honors the configured encryption-only policy despite URL verification settings', async () => {
    const ssl = await driverSsl('postgresql://localhost/db?sslmode=verify-full&uselibpqcompat=true', 'require');
    assert.equal(typeof ssl, 'object');
    assert.equal((ssl as ConnectionOptions).rejectUnauthorized, false);
  });

  it('retains URL certificate material while replacing the conflicting mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-pg-tls-'));
    try {
      const url = new URL('postgresql://localhost/db?sslmode=disable&application_name=memory');
      for (const [parameter, content] of [['sslcert', 'client certificate'], ['sslkey', 'client key'], ['sslrootcert', 'trusted CA']]) {
        const path = join(dir, parameter);
        writeFileSync(path, content);
        url.searchParams.set(parameter, path);
      }
      const ssl = await driverSsl(url.toString(), 'verify-full') as ConnectionOptions;
      assert.equal(ssl.cert, 'client certificate');
      assert.equal(ssl.key, 'client key');
      assert.equal(ssl.ca, 'trusted CA');
      assert.notEqual(ssl.rejectUnauthorized, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const unrecognized of ['true', '1', 'verify_full']) {
    it(`keeps the URL's verified TLS when the override "${unrecognized}" is not a recognized mode`, async () => {
      const url = 'postgresql://localhost/db?sslmode=verify-full';
      const ssl = await driverSsl(url, unrecognized);
      assert.ok(ssl, 'an unrecognized override must not downgrade the URL to plaintext');
      assert.notEqual(typeof ssl === 'object' && ssl.rejectUnauthorized, false);
      assert.equal(parsePostgresConfig({ env: {
        CLAUDE_MEM_SERVER_DATABASE_URL: url, CLAUDE_MEM_POSTGRES_SSL: unrecognized,
      } })!.connectionString, url);
    });
  }

  it('preserves the original driver URL when no explicit override is configured', () => {
    const url = 'postgresql://localhost/db?sslmode=verify-full&application_name=memory';
    assert.equal(parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: url } })!.connectionString, url);
  });
});
