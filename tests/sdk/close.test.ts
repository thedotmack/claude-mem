// SPDX-License-Identifier: Apache-2.0
//
// Phase 8 SDK contract test — close() lifecycle.
//   - consumer-supplied pool is NOT closed.
//   - SDK-owned pool IS closed.
//   - All methods reject "cmem-sdk: client is closed" after close().
//   - close() is idempotent.
// Plan §7.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type pg from 'pg';
import { createCmemClient } from '../../src/sdk/index.js';
import { createIsolatedSchema, poolForSchema, dropSchema } from './pg-isolation.js';

const testDatabaseUrl =
  process.env.CLAUDE_MEM_TEST_POSTGRES_URL ?? process.env.CLAUDE_MEM_SERVER_DATABASE_URL;

async function uvxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['uvx', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

describe('CmemClient.close lifecycle', () => {
  let chromaAvailable = false;
  let dataDir: string;
  let schemaName: string;
  let adminPool: pg.Pool;
  let prevDataDir: string | undefined;

  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL or CLAUDE_MEM_SERVER_DATABASE_URL', () => {});
    return;
  }

  beforeAll(async () => {
    chromaAvailable = await uvxAvailable();
  });

  beforeEach(async () => {
    if (!chromaAvailable) return;
    dataDir = path.join(os.tmpdir(), `cmem-sdk-close-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;

    // Per-test schema; pool pins search_path in the connection startup
    // packet so every connection (incl. the SDK's) is deterministically
    // scoped, with no race against a fire-and-forget SET. See pg-isolation.ts.
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_sdk_close');
    adminPool = poolForSchema(testDatabaseUrl, schemaName);
  });

  afterEach(async () => {
    if (!chromaAvailable) return;
    await adminPool.end().catch(() => {});
    await dropSchema(testDatabaseUrl, schemaName).catch(() => {});
    if (prevDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('does NOT close a consumer-supplied pool', async () => {
    if (!chromaAvailable) return;
    const client = await createCmemClient({ pool: adminPool });
    await client.close();
    // adminPool should still be usable.
    const res = await adminPool.query('SELECT 1 AS one');
    expect(res.rows[0]!.one).toBe(1);
  });

  it('DOES close an SDK-owned pool (databaseUrl path)', async () => {
    if (!chromaAvailable) return;
    // databaseUrl path → SDK creates and owns the pool.
    const client = await createCmemClient({ databaseUrl: testDatabaseUrl! });
    // Sanity: pool is usable before close
    const before = await client.pool.query('SELECT 1 AS one');
    expect(before.rows[0]!.one).toBe(1);

    await client.close();

    // Closed pg.Pool rejects further queries.
    await expect(client.pool.query('SELECT 1')).rejects.toThrow();
  });

  it('methods throw "client is closed" after close()', async () => {
    if (!chromaAvailable) return;
    const client = await createCmemClient({ pool: adminPool });
    await client.close();

    await expect(
      client.capture({
        sourceAdapter: 'x',
        eventType: 'y',
        payload: {},
      })
    ).rejects.toThrow(/client is closed/);
    await expect(client.captureBatch([])).rejects.toThrow(/client is closed/);
    await expect(client.generate('whatever')).rejects.toThrow(/client is closed/);
    await expect(client.search({ query: 'x' })).rejects.toThrow(/client is closed/);
    await expect(client.context({ query: 'x' })).rejects.toThrow(/client is closed/);
    await expect(client.startSession()).rejects.toThrow(/client is closed/);
    await expect(client.endSession('any')).rejects.toThrow(/client is closed/);
  });

  it('close() is idempotent', async () => {
    if (!chromaAvailable) return;
    const client = await createCmemClient({ pool: adminPool });
    await client.close();
    await client.close();
    await client.close();
    // No error means idempotent.
    expect(true).toBe(true);
  });
});
