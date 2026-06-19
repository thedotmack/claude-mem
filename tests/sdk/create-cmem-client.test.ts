// SPDX-License-Identifier: Apache-2.0
//
// Phase 8 SDK contract test — schema bootstrap idempotency + sdk-tenant.json
// persistence. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §3.
//
// Skip-if-no-db: matches existing convention in tests/storage/postgres/* and
// tests/server/generation/*. The same harness env var (CLAUDE_MEM_TEST_POSTGRES_URL)
// drives every Postgres integration test in the repo; CLAUDE_MEM_SERVER_DATABASE_URL
// is the SDK-public name we expose to consumer apps.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type pg from 'pg';
import { createCmemClient } from '../../src/sdk/index.js';
import { createIsolatedSchema, poolForSchema, dropSchema } from './pg-isolation.js';

const testDatabaseUrl =
  process.env.CLAUDE_MEM_TEST_POSTGRES_URL ?? process.env.CLAUDE_MEM_SERVER_DATABASE_URL;

describe('createCmemClient — schema bootstrap idempotency', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL or CLAUDE_MEM_SERVER_DATABASE_URL', () => {});
    return;
  }

  // Each test gets its own pg schema (test isolation) AND its own data dir
  // (so sdk-tenant.json from a previous test or the host's real run never
  // bleeds in). Override DATA_DIR before each test so resolveSdkDataDir()
  // points into the temp directory.
  let dataDir: string;
  let schemaName: string;
  let adminPool: pg.Pool;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `cmem-sdk-bootstrap-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;

    // Each test gets its own schema; the pool pins search_path in the
    // connection startup packet so every pooled connection (including the
    // SDK's) is deterministically scoped and writes never collide with the
    // host's data — with no race against a fire-and-forget SET. See
    // pg-isolation.ts.
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_sdk_boot');
    adminPool = poolForSchema(testDatabaseUrl, schemaName);
  });

  afterEach(async () => {
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

  it('is idempotent and persists sdk-tenant.json across runs', async () => {
    // Use a consumer-supplied pool so the SDK does not open its own — that
    // way we keep our search_path-aware adminPool as the single connection
    // surface for both the schema bootstrap and tenancy writes.
    const client1 = await createCmemClient({ pool: adminPool });
    const tenantFile = path.join(dataDir, 'sdk-tenant.json');
    expect(fs.existsSync(tenantFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(tenantFile, 'utf8')) as {
      teamId: string;
      projectId: string;
    };
    expect(persisted.teamId).toBe(client1.teamId);
    expect(persisted.projectId).toBe(client1.projectId);

    // Closing client1 (pool is consumer-supplied so it stays open) and
    // re-running createCmemClient must reuse the same teamId+projectId
    // and must NOT create duplicate teams/projects.
    await client1.close();

    const teamsBefore = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM teams'
    );
    const projectsBefore = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM projects'
    );

    const client2 = await createCmemClient({ pool: adminPool });
    expect(client2.teamId).toBe(client1.teamId);
    expect(client2.projectId).toBe(client1.projectId);

    const teamsAfter = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM teams'
    );
    const projectsAfter = await adminPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM projects'
    );
    expect(teamsAfter.rows[0]!.count).toBe(teamsBefore.rows[0]!.count);
    expect(projectsAfter.rows[0]!.count).toBe(projectsBefore.rows[0]!.count);

    await client2.close();
  });
});
