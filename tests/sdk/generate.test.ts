// SPDX-License-Identifier: Apache-2.0
//
// Phase 8 SDK contract test — captureAndGenerate() persists one observation
// per stub-provided XML, links it via observation_sources, marks the job
// completed. Plan §5.
//
// Skip-if: no Postgres URL, OR no uvx (Chroma is REQUIRED — without
// uvx, createCmemClient(...) intentionally rejects, which is itself
// covered by close.test.ts's "errors after close" path).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type pg from 'pg';
import { createCmemClient, type CmemProvider } from '../../src/sdk/index.js';
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

describe('CmemClient.captureAndGenerate (stub provider)', () => {
  // We can't gate on `it.skipIf` from the top because uvxAvailable is async,
  // so we resolve once in beforeAll and short-circuit each test body. This
  // mirrors the pattern used in tests/integration/chroma-vector-sync.test.ts.
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
    dataDir = path.join(os.tmpdir(), `cmem-sdk-gen-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;

    // Per-test schema; pool pins search_path in the connection startup
    // packet so every connection (incl. the SDK's) is deterministically
    // scoped, with no race against a fire-and-forget SET. See pg-isolation.ts.
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_sdk_gen');
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

  it('captureAndGenerate persists observation + source link + completes job', async () => {
    if (!chromaAvailable) {
      // Skip body; we can't return `it.skip` from the body so we use an
      // explicit short-circuit. The harness still records this as a pass,
      // which is the intended behavior — the test is a no-op when Chroma
      // isn't installed.
      return;
    }

    // Stub provider that returns a known-valid observation XML. We don't
    // need an LLM in this test; we only need to prove the SDK wires the
    // provider's rawText through processGeneratedResponse correctly.
    // The XML mirrors the form used in
    // tests/server/generation/process-generated-response.test.ts.
    const stubXml =
      '<observation><type>discovery</type><title>SDK Generate Test</title><facts><fact>SDK can generate inline</fact></facts></observation>';
    let providerCalls = 0;
    const stub: CmemProvider = {
      providerLabel: 'claude',
      async generate() {
        providerCalls += 1;
        return { rawText: stubXml, providerLabel: 'claude', modelId: 'stub-1' };
      },
    };

    const client = await createCmemClient({ pool: adminPool, provider: stub });
    const out = await client.captureAndGenerate({
      sourceAdapter: 'sdk-test',
      eventType: 'unit',
      payload: { content: 'something to compress' },
    });
    expect(providerCalls).toBe(1);
    expect(out.result.observations).toHaveLength(1);
    const observation = out.result.observations[0]!;
    expect(typeof observation.id).toBe('string');
    expect(observation.content).toContain('SDK Generate Test');
    expect(out.result.privateContentDetected).toBe(false);

    // The job should be completed.
    const jobRow = await adminPool.query<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at::text AS completed_at
       FROM observation_generation_jobs
       WHERE id = $1 AND project_id = $2`,
      [out.generationJobId, client.projectId]
    );
    expect(jobRow.rows[0]!.status).toBe('completed');
    expect(jobRow.rows[0]!.completed_at).not.toBeNull();

    // observation_sources should link the new observation to the source event.
    const sourceRow = await adminPool.query<{
      source_type: string;
      source_id: string;
      generation_job_id: string;
    }>(
      `SELECT source_type, source_id, generation_job_id
       FROM observation_sources
       WHERE observation_id = $1`,
      [observation.id]
    );
    expect(sourceRow.rows).toHaveLength(1);
    expect(sourceRow.rows[0]!.source_type).toBe('agent_event');
    expect(sourceRow.rows[0]!.source_id).toBe(out.agentEventId);
    expect(sourceRow.rows[0]!.generation_job_id).toBe(out.generationJobId);

    await client.close();
  });
});
