/**
 * Direct tests for ChromaSync.deleteRowDocuments (#4805, PR #4813).
 *
 * The delete-route tests mock `deleteRowDocuments` wholesale, so they pin the
 * call arguments but never execute the cleanup itself (Greptile P2 on PR
 * #4813). These tests run the real method against mocked Chroma calls and pin
 * the three behaviors that must hold together:
 *
 * 1. doc_type scoping — observation and session_summary id spaces overlap, so
 *    a sqlite_id-only lookup may return sibling-typed fragments that must NOT
 *    be deleted (the client-side filter in lookupRowFragmentIds is
 *    load-bearing).
 * 2. batching — fragments are deleted in ChromaSync's BATCH_SIZE chunks, so a
 *    large row must produce several correctly-sliced delete calls.
 * 3. row-writer serialization — cleanup queues on the same per-row turn live
 *    writes and backfill use, both ways: a delete waits for an in-flight write
 *    to the same row (a batch landing after the lookup would orphan its
 *    fragments again — Greptile P1), and a write queued behind a delete waits
 *    for the deletions instead of interleaving with them.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

const calls: Array<{ tool: string; args: any }> = [];

// Delete calls park on this until a test releases them, to hold the row
// writer's turn mid-cleanup.
let deleteGate: Promise<void> = Promise.resolve();

// Swappable per test; defaults to a corpus-backed chroma that honours the
// where clause it is given.
let getImpl: (args: any) => unknown = () => ({ ids: [], metadatas: [] });

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (tool: string, args: any) => {
        if (tool === 'chroma_delete_documents') await deleteGate;
        calls.push({ tool, args });
        switch (tool) {
          case 'chroma_create_collection':
            return {};
          case 'chroma_get_documents':
            return getImpl(args);
          default:
            return {};
        }
      }
    })
  }
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

beforeEach(() => {
  calls.length = 0;
  deleteGate = Promise.resolve();
  getImpl = () => ({ ids: [], metadatas: [] });
});

const getCalls = () => calls.filter(c => c.tool === 'chroma_get_documents');
const deleteCalls = () => calls.filter(c => c.tool === 'chroma_delete_documents');
const deletedIds = (): string[] => deleteCalls().flatMap(c => c.args.ids as string[]);

// Let every pending promise chain (row-writer turns, the cleanup itself) run
// to its next await before asserting on ordering.
const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0));
};

type RowWriter = (kind: string, id: number) => Promise<() => void>;

function newSync(): ChromaSync {
  return new ChromaSync('claude-mem');
}

function rowWriter(sync: ChromaSync): RowWriter {
  return (sync as unknown as { acquireRowWriter: RowWriter }).acquireRowWriter.bind(sync);
}

describe('ChromaSync.deleteRowDocuments', () => {
  it('deletes only the requested doc type when sqlite_id spaces overlap', async () => {
    // One sqlite_id, four fragments across three types: the collision the
    // client-side doc_type filter exists for.
    const metadatas = [
      { id: 'obs_5_narrative', doc_type: 'observation' },
      { id: 'obs_5_fact_0', doc_type: 'observation' },
      { id: 'summary_5_request', doc_type: 'session_summary' },
      { id: 'prompt_5', doc_type: 'user_prompt' },
    ];
    getImpl = () => ({ ids: metadatas.map(m => m.id), metadatas });

    const sync = newSync();
    expect(await sync.deleteRowDocuments('observation', 5)).toBe(2);
    expect(deletedIds()).toEqual(['obs_5_narrative', 'obs_5_fact_0']);

    // The sibling types' fragments are untouched by the observation cleanup
    // and go only when their own doc_type is cleaned up.
    calls.length = 0;
    expect(await sync.deleteRowDocuments('session_summary', 5)).toBe(1);
    expect(deletedIds()).toEqual(['summary_5_request']);
  });

  it('deletes a large row in BATCH_SIZE chunks', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `obs_9_frag_${i}`);
    getImpl = () => ({ ids, metadatas: ids.map(() => ({ doc_type: 'observation', sqlite_id: 9 })) });

    const sync = newSync();
    expect(await sync.deleteRowDocuments('observation', 9)).toBe(250);

    const batches = deleteCalls().map(c => c.args.ids as string[]);
    expect(batches.map(batch => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  it('queues behind an in-flight write to the same row before looking up', async () => {
    const sync = newSync();
    const acquire = rowWriter(sync);
    // A live write (or backfill turn) for this row is in flight.
    const releaseWrite = await acquire('observations', 5);

    let cleanupDone = false;
    const cleanup = sync.deleteRowDocuments('observation', 5).then(count => {
      cleanupDone = true;
      return count;
    });
    await drain();

    // The cleanup must not even look up fragments while the write holds the
    // turn — a batch not yet written would be invisible to the lookup.
    expect(cleanupDone).toBe(false);
    expect(getCalls().length).toBe(0);
    expect(deleteCalls().length).toBe(0);

    releaseWrite();
    expect(await cleanup).toBe(0);
    expect(getCalls().length).toBe(1);
  });

  it('makes a write queued behind the cleanup wait for the deletions', async () => {
    const sync = newSync();
    const acquire = rowWriter(sync);
    // The row has fragments, so the cleanup parks mid-delete on the gate below.
    getImpl = () => ({ ids: ['obs_5_narrative'], metadatas: [{ id: 'obs_5_narrative', doc_type: 'observation' }] });

    let releaseDelete: (() => void) | null = null;
    deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });

    const cleanup = sync.deleteRowDocuments('observation', 5);
    await drain();
    expect(getCalls().length).toBe(1); // cleanup holds the turn, parked in its delete call

    // A live write for the same row queues behind the cleanup.
    let writerStarted = false;
    const writer = acquire('observations', 5).then(release => {
      writerStarted = true;
      release();
    });
    await drain();
    expect(writerStarted).toBe(false);

    releaseDelete!();
    await Promise.all([cleanup, writer]);
    expect(writerStarted).toBe(true);
  });

  it('removes nothing for an unknown doc type instead of crashing', async () => {
    getImpl = () => ({
      ids: ['obs_5_narrative'],
      metadatas: [{ id: 'obs_5_narrative', doc_type: 'observation' }],
    });

    const sync = newSync();
    expect(await sync.deleteRowDocuments('unknown_type', 5)).toBe(0);
    expect(deleteCalls().length).toBe(0);
  });
});
