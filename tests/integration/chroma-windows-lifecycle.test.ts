/**
 * Real chroma-mcp lifecycle smoke over the PRODUCTION path (#3610 / plan-22).
 *
 * HONESTY NOTE — read before trusting this file as proof of anything:
 *
 * This suite is EXPECTED TO PASS ON MAIN. It is a regression sentinel, not a
 * fail-on-main gate. ChromaMcpManager.stop() on main already funnels through
 * disposeCurrentSubprocess() -> killProcessTree(), which is `taskkill /T /F`
 * on Windows — so a manager-only create/add/query/stop round trip cannot
 * demonstrate the #3482 bug. The single-PID kill that actually orphans the
 * uvx -> uv -> python chain lives in the WORKER RECYCLE path
 * (ensureWorkerRunning in src/shared/worker-utils.ts), and that is exercised
 * by worker-recycle-windows.test.ts, which IS the fail-on-main gate.
 *
 * What this file is genuinely worth:
 *   - it proves chroma-mcp actually starts, indexes and retrieves on Windows
 *     via the production code path (nothing here mocks the transport);
 *   - it asserts the document comes back BY ID, so a silently-empty result set
 *     fails instead of passing as "no exception thrown";
 *   - the polluted-env variant is a real #3552 gate: with a foreign
 *     VIRTUAL_ENV/PYTHONHOME/PYTHONPATH/CONDA_PREFIX in the environment, an
 *     unsanitized child dies on a numpy ABI clash during chromadb import.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const RUN_CHROMA = process.env.CLAUDE_MEM_TEST_CHROMA === '1';
const RUN_POLLUTED = process.env.CLAUDE_MEM_TEST_CHROMA_POLLUTED_ENV === '1';

// A cold uvx resolve + chromadb build is minutes, not seconds, on a cold CI
// cache. The suite-level bun --timeout in CI must exceed this.
const ROUND_TRIP_TIMEOUT_MS = 600_000;

/**
 * CLAUDE_MEM_DATA_DIR must already be set in the ENVIRONMENT before this
 * process starts — src/shared/paths.ts resolves DATA_DIR into a module-level
 * const at import time, so assigning process.env here would be a no-op that
 * silently pointed the run at the developer's real ~/.claude-mem. CI sets it
 * under runner.temp; locally, export it before invoking bun.
 */
function assertIsolatedDataDir(): void {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      'CLAUDE_MEM_DATA_DIR must be set before starting this process — refusing to run against the default data dir'
    );
  }
  fs.mkdirSync(dataDir, { recursive: true });
}

async function roundTrip(label: string): Promise<{ ids: string[]; documentId: string; rootPid: number | undefined }> {
  const { ChromaMcpManager } = await import('../../src/services/sync/ChromaMcpManager.js');
  const { getSupervisor } = await import('../../src/supervisor/index.js');

  await ChromaMcpManager.reset();
  const manager = ChromaMcpManager.getInstance();
  const collection = `winlifecycle_${label}_${Date.now()}`;
  const documentId = `doc_${label}_${Date.now()}`;

  try {
    // callTool() is the public surface; it drives ensureConnected() -> spawn
    // -> MCP handshake internally. Nothing below reaches into SDK privates.
    await manager.callTool('chroma_create_collection', { collection_name: collection });

    await manager.callTool('chroma_add_documents', {
      collection_name: collection,
      documents: ['claude-mem windows lifecycle probe document'],
      ids: [documentId],
    });

    const queryResult = await manager.callTool('chroma_query_documents', {
      collection_name: collection,
      query_texts: ['windows lifecycle probe'],
      n_results: 1,
    });

    // Read the root pid from the PRODUCTION supervisor registry — the same
    // record ChromaMcpManager registers under CHROMA_SUPERVISOR_ID — rather
    // than poking at the MCP SDK's private _process field.
    const record = getSupervisor().getRegistry().getAll().find(r => r.id === 'chroma-mcp');

    // callTool() returns chroma's structured result, not MCP text content.
    // `ids` is per-query-text, so it nests one level: [[ "doc_..." ]].
    const rawIds = (queryResult as { ids?: unknown }).ids;
    const ids = Array.isArray(rawIds) ? (rawIds.flat(2) as unknown[]).filter(
      (value): value is string => typeof value === 'string'
    ) : [];

    return { ids, documentId, rootPid: record?.pid };
  } finally {
    await ChromaMcpManager.reset();
  }
}

describe.if(RUN_CHROMA)('chroma-mcp lifecycle over the production path', () => {
  beforeAll(() => {
    assertIsolatedDataDir();
  });

  it('round-trips a document and returns it by id', async () => {
    const { ids, documentId, rootPid } = await roundTrip('plain');

    // The real assertion: the exact document must come BACK, by id. A query
    // that returns an empty result set is a failure, not a pass.
    expect(ids).toContain(documentId);

    // The supervisor must have seen a real subprocess.
    expect(rootPid).toBeGreaterThan(0);
  }, ROUND_TRIP_TIMEOUT_MS);
});

describe.if(RUN_CHROMA)('ChromaMcpManager teardown reaps the whole tree', () => {
  beforeAll(() => {
    assertIsolatedDataDir();
  });

  // Regression cover for the teardown reorder. Graceful-first close means the
  // direct child (uvx) can exit before we escalate, so the ONLY thing that
  // still reaches uv -> python -> chroma-mcp is the descendant set captured
  // before the close. When that enumeration returned [] — as the pgrep-based
  // walk did on Windows — the escalation was skipped, the re-scan found
  // nothing, and the chain was orphaned by the very manager this work exists
  // to fix. Nothing in the suite could see that, which is why this exists.
  //
  // Runs on every platform. On Windows it is the direct guard on the CIM
  // enumeration path; on POSIX it guards the pgrep path and the reap.
  it('leaves no orphaned descendants after stop()', async () => {
    const { ChromaMcpManager } = await import('../../src/services/sync/ChromaMcpManager.js');
    const { getSupervisor } = await import('../../src/supervisor/index.js');
    const { collectDescendantPids } = await import('../../src/shared/kill-process-tree.js');
    const { snapshotDescendants, survivingProcesses, describeProcesses } = await import(
      './helpers/process-tree.js'
    );

    await ChromaMcpManager.reset();
    const manager = ChromaMcpManager.getInstance();
    const collection = `teardown_${Date.now()}`;

    let snapshot: ReturnType<typeof snapshotDescendants> = [];
    try {
      await manager.callTool('chroma_create_collection', { collection_name: collection });

      const record = getSupervisor().getRegistry().getAll().find(r => r.id === 'chroma-mcp');
      expect(record?.pid).toBeGreaterThan(0);
      const rootPid = record!.pid;

      // The PRODUCTION enumeration must see the chain. This is the assertion
      // that fails outright on a platform where collectDescendantPids cannot
      // enumerate — the exact shape of the Windows regression.
      const productionView = await collectDescendantPids(rootPid);
      expect(productionView.length).toBeGreaterThan(0);

      // Independent snapshot via the test helper, with identity captured.
      snapshot = snapshotDescendants(rootPid);
      expect(snapshot.length).toBeGreaterThan(0);
    } finally {
      await ChromaMcpManager.reset();
    }

    // Poll: teardown reaps asynchronously.
    const deadline = Date.now() + 30_000;
    let survivors = survivingProcesses(snapshot);
    while (survivors.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      survivors = survivingProcesses(snapshot);
    }

    expect(
      survivors.length === 0,
      `chroma-mcp descendants survived manager teardown: ${describeProcesses(survivors)}`
    ).toBe(true);
  }, ROUND_TRIP_TIMEOUT_MS);
});

describe.if(RUN_CHROMA && RUN_POLLUTED)('chroma-mcp with a hostile ambient Python env (#3552)', () => {
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    assertIsolatedDataDir();

    // Exactly the shape of an activated venv / conda shell. Unsanitized, uvx's
    // child imports this interpreter's site-packages on top of uv's and dies
    // during chromadb import — silently, before the MCP handshake.
    const pollution: Record<string, string> = {
      VIRTUAL_ENV: path.join(os.tmpdir(), 'claude-mem-fake-venv'),
      PYTHONHOME: path.join(os.tmpdir(), 'claude-mem-fake-pythonhome'),
      PYTHONPATH: path.join(os.tmpdir(), 'claude-mem-fake-sitepackages'),
      CONDA_PREFIX: path.join(os.tmpdir(), 'claude-mem-fake-conda'),
      CONDA_DEFAULT_ENV: 'claude-mem-fake-env',
    };
    for (const [key, value] of Object.entries(pollution)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('still round-trips a document with a foreign interpreter in the env', async () => {
    const { ids, documentId } = await roundTrip('polluted');

    expect(ids).toContain(documentId);
  }, ROUND_TRIP_TIMEOUT_MS);
});
