import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../../../src/utils/logger.js';
import { ChromaSyncState } from '../../../../src/services/sync/ChromaSyncState.js';

// #5495 — a delete burst schedules one post-delete Chroma cleanup loop per
// request. Unserialized, 15k concurrent chroma_get_documents reads piled up on
// chroma-mcp's single stdio channel and locked sync/health/search for hours.
// The cleanups must take turns on one process-wide tail.
//
// #5664 — and a cleanup that fails must not simply be dropped: the row is gone
// for good, so the failure is recorded in the sync checkpoint for the next
// backfill sweep to retry.

// The retry record is written to the data dir; never the user's real one.
let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-data-routes-cleanup-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  ChromaSyncState.resetCacheForTests();
});

afterEach(() => {
  ChromaSyncState.resetCacheForTests();
  if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function routesWith(stub: { deleteRowDocuments: (kind: string, id: number) => Promise<void> }) {
  const { DataRoutes } = require('../../../../src/services/worker/http/routes/DataRoutes.js');
  const routes = Object.create(DataRoutes.prototype) as any;
  routes.dbManager = { getChromaSync: () => stub };
  routes.chromaCleanupTail = Promise.resolve();
  return routes;
}

const ROW = { kind: 'observation' as const, id: '1' };

describe('scheduleChromaRowCleanup — one batch in flight (#5495)', () => {
  it('serializes two scheduled cleanups: the second starts only after the first settles', async () => {
    let firstSettled = false;
    let secondSawFirstSettled: boolean | null = null;
    let firstStarted = 0;
    let secondStarted = 0;
    const stub = {
      async deleteRowDocuments(kind: string, id: number) {
        if (id === 1) {
          firstStarted++;
          await new Promise((r) => setTimeout(r, 50));
          firstSettled = true;
        } else {
          secondStarted++;
          secondSawFirstSettled = firstSettled;
        }
      },
    };
    spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const routes = routesWith(stub);
      routes.scheduleChromaRowCleanup([{ ...ROW }]);
      routes.scheduleChromaRowCleanup([{ ...ROW, id: '2' }]);
      await routes.chromaCleanupTail;
      expect(firstStarted).toBe(1);
      expect(secondStarted).toBe(1);
      expect(secondSawFirstSettled).toBe(true); // the second batch started only after the first settled
    } finally {
      mock.restore();
    }
  });

  it('a failing batch never jams the tail for the next one', async () => {
    const ranIds: number[] = [];
    const stub = {
      async deleteRowDocuments(kind: string, id: number) {
        ranIds.push(id);
        if (id === 1) throw new Error('chroma down');
      },
    };
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const routes = routesWith(stub);
      routes.scheduleChromaRowCleanup([{ ...ROW }]);
      routes.scheduleChromaRowCleanup([{ ...ROW, id: '2' }]);
      await routes.chromaCleanupTail;
      expect(warn).toHaveBeenCalled(); // the failure is logged per row
      expect(ranIds).toEqual([1, 2]); // the next batch still ran after the failure
      // ...and the failed row is kept for the next backfill sweep (#5664).
      expect(ChromaSyncState.getPendingRowDeletes()).toEqual([
        { docType: 'observation', sqliteId: 1 },
      ]);
    } finally {
      warn.mockRestore();
      mock.restore();
    }
  });

  it('an empty schedule is a no-op that does not touch the tail', async () => {
    const stub = { deleteRowDocuments: mock(() => Promise.resolve()) };
    const routes = routesWith(stub);
    const before = routes.chromaCleanupTail;
    routes.scheduleChromaRowCleanup([]);
    expect(routes.chromaCleanupTail).toBe(before);
    expect(stub.deleteRowDocuments).not.toHaveBeenCalled();
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
  });
});
