// SPDX-License-Identifier: Apache-2.0
//
// Phase 8 SDK contract test — search() returns hydrated observations from
// Chroma's happy path, and falls back to Postgres FTS with `degraded: true`
// when Chroma throws at runtime. context() joins the same observations'
// content with `\n\n`. Plan §6.
//
// Skip-if: no Postgres URL, OR no uvx. The degraded path is exercised by
// monkey-patching the singleton ChromaMcpManager.callTool to throw — this
// is the cheapest way to reach the catch branch without killing the live
// subprocess between tests.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type pg from 'pg';
import { createCmemClient } from '../../src/sdk/index.js';
import { ChromaMcpManager } from '../../src/services/sync/ChromaMcpManager.js';
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

describe('CmemClient.search / context', () => {
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
    dataDir = path.join(os.tmpdir(), `cmem-sdk-search-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;

    // Per-test schema; pool pins search_path in the connection startup
    // packet so every connection (incl. the SDK's) is deterministically
    // scoped, with no race against a fire-and-forget SET. See pg-isolation.ts.
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_sdk_search');
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

  it('empty-query path returns most-recent observations via Postgres listByProject', async () => {
    if (!chromaAvailable) return;
    const client = await createCmemClient({ pool: adminPool });

    // Seed observations directly via the public repos surface so we don't
    // need a live LLM.
    await client.repos.observations.create({
      projectId: client.projectId,
      teamId: client.teamId,
      content: 'OAuth flow with PKCE — captured directly.',
    });
    await client.repos.observations.create({
      projectId: client.projectId,
      teamId: client.teamId,
      content: 'Second observation about JWT validation.',
    });

    // Empty query is the "listByProject" path; Chroma isn't queried, and
    // the response is marked `chroma: true, degraded: false`.
    const result = await client.search({ query: '', limit: 10 });
    expect(result.degraded).toBe(false);
    expect(result.chroma).toBe(true);
    expect(result.observations.length).toBeGreaterThanOrEqual(2);

    await client.close();
  });

  it('degrades to Postgres FTS with degraded: true when Chroma callTool throws', async () => {
    if (!chromaAvailable) return;
    const client = await createCmemClient({ pool: adminPool });

    // Seed an observation with content that Postgres FTS can match.
    await client.repos.observations.create({
      projectId: client.projectId,
      teamId: client.teamId,
      content: 'OAuth flow with PKCE — captured directly for FTS.',
    });

    // Monkey-patch the singleton ChromaMcpManager.callTool to throw, so
    // the SDK's chroma_query_documents path hits its catch branch. Reset
    // it after the test.
    const mgr = ChromaMcpManager.getInstance();
    const originalCallTool = mgr.callTool.bind(mgr);
    (mgr as unknown as { callTool: (name: string, args: unknown) => Promise<unknown> }).callTool =
      async (name: string, _args: unknown) => {
        if (name === 'chroma_query_documents') {
          throw new Error('chroma-mcp transient failure (synthetic)');
        }
        return originalCallTool(name, _args);
      };

    try {
      const result = await client.search({ query: 'OAuth' });
      expect(result.degraded).toBe(true);
      expect(result.chroma).toBe(false);
      expect(result.error?.message).toBeTruthy();
      // FTS should still find the observation by content.
      const found = result.observations.find((o) => o.content.includes('OAuth'));
      expect(found).toBeTruthy();

      // context() must propagate the degraded flag.
      const ctx = await client.context({ query: 'OAuth' });
      expect(ctx.degraded).toBe(true);
      expect(typeof ctx.context).toBe('string');
      expect(ctx.context).toContain('OAuth');
    } finally {
      (mgr as unknown as { callTool: (name: string, args: unknown) => Promise<unknown> }).callTool =
        originalCallTool;
    }

    await client.close();
  });

  it('context() returns {observations, context, degraded} shape', async () => {
    if (!chromaAvailable) return;
    const client = await createCmemClient({ pool: adminPool });
    await client.repos.observations.create({
      projectId: client.projectId,
      teamId: client.teamId,
      content: 'A first context piece.',
    });
    await client.repos.observations.create({
      projectId: client.projectId,
      teamId: client.teamId,
      content: 'A second context piece.',
    });

    const result = await client.context({ query: '' });
    expect(Array.isArray(result.observations)).toBe(true);
    expect(typeof result.context).toBe('string');
    expect(typeof result.degraded).toBe('boolean');
    // Empty-query path joins all listed observations.
    expect(result.context).toContain('first');
    expect(result.context).toContain('second');

    await client.close();
  });
});
