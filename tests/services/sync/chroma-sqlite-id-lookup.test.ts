/**
 * sqlite_id-only Chroma lookups for adoption and backfill (#4682).
 *
 * `updateMergedIntoProject` and `removeObsoleteFragments` used to push
 * `doc_type` into the get `where` clause as an $and member. chromadb 1.5.9
 * evaluates an $and member over every document matching it before the
 * selective condition or the limit narrows anything, so on a ~1.2M-doc
 * doc_type=observation partition each lookup cost ~33s with a cold page
 * cache — past the chroma-mcp 60s timeout, which killed the subprocess and
 * left every search waiting on 30s timeouts until Chroma was disabled.
 * Reporting the reporter's measurements against a byte-identical store copy:
 *
 *     {$and: [{doc_type: "observation"}, {sqlite_id: {$in: [51 ids]}}]}   33.0s cold / 0.90s warm
 *     {sqlite_id: {$in: [51 ids]}}                                         4.8s cold / 0.11s warm
 *
 * So `where` now carries only `sqlite_id` and `doc_type` is filtered
 * client-side. That filter is load-bearing: observation and session_summary
 * ids overlap, so the fake below serves sibling- and other-typed documents
 * for the same sqlite_id and every delete/update set must still match the
 * reference sets the old server-side $and semantics would have produced.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

const calls: Array<{ tool: string; args: any }> = [];

// One sqlite_id, four documents across three types: the collision the
// client-side doc_type filter exists for. Key order is the response order.
const CORPUS: Record<string, Record<string, unknown>> = {
  'obs_5_narrative': { sqlite_id: 5, doc_type: 'observation', project: 'p' },
  'obs_5_fact_0': { sqlite_id: 5, doc_type: 'observation', project: 'p' },
  'summary_5_request': { sqlite_id: 5, doc_type: 'session_summary', project: 'p' },
  'prompt_5': { sqlite_id: 5, doc_type: 'user_prompt', project: 'p' },
  'obs_6_narrative': { sqlite_id: 6, doc_type: 'observation', project: 'p' },
  'summary_6_notes': { sqlite_id: 6, doc_type: 'session_summary', project: 'p' }
};

// What the chroma server (and thus the old $and pushdown) would have
// selected for a doc_type + sqlite_id lookup. The patched methods must
// reproduce exactly these sets from a sqlite_id-only response.
function referenceSelect(docType: string, sqliteIds: number[]): string[] {
  return Object.keys(CORPUS).filter(id =>
    CORPUS[id].doc_type === docType && sqliteIds.includes(CORPUS[id].sqlite_id as number));
}

function matches(where: any, meta: Record<string, unknown>): boolean {
  if (!where) return true;
  if (where.$and) return where.$and.every((clause: any) => matches(clause, meta));
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object') {
      if ('$in' in v) return v.$in.includes(meta[k]);
      return false;
    }
    return meta[k] === v;
  });
}

// Swappable per test; defaults to a corpus-backed chroma that honours the
// where clause it is given (server-side evaluation, as chroma does).
let getImpl: (args: any) => unknown = (args: any) => {
  const ids = Object.keys(CORPUS).filter(id => matches(args.where, CORPUS[id]));
  const include: string[] = args.include ?? [];
  return {
    ids,
    ...(include.includes('metadatas')
      ? { metadatas: ids.map(id => ({ ...CORPUS[id] })) }
      : {})
  };
};

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (tool: string, args: any) => {
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
  getImpl = (args: any) => {
    const ids = Object.keys(CORPUS).filter(id => matches(args.where, CORPUS[id]));
    const include: string[] = args.include ?? [];
    return {
      ids,
      ...(include.includes('metadatas')
        ? { metadatas: ids.map(id => ({ ...CORPUS[id] })) }
        : {})
    };
  };
});

const getCalls = () => calls.filter(c => c.tool === 'chroma_get_documents');
const updateCalls = () => calls.filter(c => c.tool === 'chroma_update_documents');
const deleteCalls = () => calls.filter(c => c.tool === 'chroma_delete_documents');

function newSync(): ChromaSync {
  const sync = new ChromaSync('claude-mem');
  return sync;
}

describe('ChromaSync sqlite_id-only lookups (#4682)', () => {
  it('updateMergedIntoProject sends sqlite_id-only where clauses with metadatas', async () => {
    await newSync().updateMergedIntoProject(
      [{ docType: 'observation', sqliteId: 5 }, { docType: 'session_summary', sqliteId: 5 }],
      'parent'
    );

    const gets = getCalls();
    expect(gets.length).toBe(2);
    // No $and, no doc_type pushed down — for either type's loop.
    expect(gets.map(c => c.args.where)).toEqual([
      { sqlite_id: { $in: [5] } },
      { sqlite_id: { $in: [5] } }
    ]);
    expect(gets.map(c => c.args.include)).toEqual([['metadatas'], ['metadatas']]);
  });

  it('removeObsoleteFragments sends a sqlite_id-only where clause with metadatas', async () => {
    const sync = newSync();
    const docs = [
      { id: 'obs_5_narrative', document: 'n', metadata: { sqlite_id: 5 } },
      { id: 'obs_5_fact_0', document: 'f', metadata: { sqlite_id: 5 } }
    ];
    await (sync as unknown as {
      removeObsoleteFragments: (docType: string, sqliteId: number, docs: typeof docs) => Promise<void>;
    }).removeObsoleteFragments('observation', 5, docs);

    const gets = getCalls();
    expect(gets.length).toBe(1);
    expect(gets[0].args.where).toEqual({ sqlite_id: 5 });
    expect(gets[0].args.include).toEqual(['metadatas']);
  });

  it('updateMergedIntoProject patches exactly what the server-side $and would have', async () => {
    // Both types share sqlite_id 5; the corpus also holds a user_prompt with
    // the same id that must never be touched.
    await newSync().updateMergedIntoProject(
      [{ docType: 'observation', sqliteId: 5 }, { docType: 'session_summary', sqliteId: 5 }],
      'parent'
    );

    const patchedObs = updateCalls().find(c =>
      (c.args.metadatas as any[])[0]?.doc_type === 'observation');
    const patchedSummary = updateCalls().find(c =>
      (c.args.metadatas as any[])[0]?.doc_type === 'session_summary');

    expect(patchedObs?.args.ids.sort()).toEqual(referenceSelect('observation', [5]).sort());
    expect(patchedSummary?.args.ids.sort()).toEqual(referenceSelect('session_summary', [5]).sort());

    // No document outside the reference sets got stamped.
    const allPatched = updateCalls().flatMap(c => c.args.ids as string[]).sort();
    expect(allPatched).toEqual(
      [...referenceSelect('observation', [5]), ...referenceSelect('session_summary', [5])].sort()
    );
    expect(allPatched).not.toContain('prompt_5');

    for (const call of updateCalls()) {
      for (const meta of call.args.metadatas as Array<Record<string, unknown>>) {
        expect(meta.merged_into_project).toBe('parent');
      }
    }
  });

  it('removeObsoleteFragments deletes exactly what the server-side $and would have', async () => {
    // sqlite_id 5 response spans three types; only the stale observation
    // fragment is obsolete, and the summary/prompt docs sharing the id must
    // survive even though they are not in the surviving set either.
    const sync = newSync();
    const docs = [{ id: 'obs_5_narrative', document: 'n', metadata: { sqlite_id: 5 } }];
    await (sync as unknown as {
      removeObsoleteFragments: (docType: string, sqliteId: number, docs: typeof docs) => Promise<void>;
    }).removeObsoleteFragments('observation', 5, docs);

    const deleted = deleteCalls().flatMap(c => c.args.ids as string[]);
    const reference = referenceSelect('observation', [5]).filter(id => id !== 'obs_5_narrative');
    expect(deleted.sort()).toEqual(reference.sort());
    expect(deleted).toEqual(['obs_5_fact_0']);
    expect(deleted).not.toContain('summary_5_request');
    expect(deleted).not.toContain('prompt_5');
  });

  it('removeObsoleteFragments throws and deletes nothing when metadatas are missing', async () => {
    getImpl = () => ({ ids: ['obs_5_narrative', 'summary_5_request'] });

    const sync = newSync();
    const docs = [{ id: 'obs_5_narrative', document: 'n', metadata: { sqlite_id: 5 } }];
    await expect((sync as unknown as {
      removeObsoleteFragments: (docType: string, sqliteId: number, docs: typeof docs) => Promise<void>;
    }).removeObsoleteFragments('observation', 5, docs))
      .rejects.toThrow('Chroma fragment lookup did not return a valid document ID list with metadatas');

    // Without the types the response cannot be filtered safely: nothing may be deleted.
    expect(deleteCalls()).toHaveLength(0);
  });

  it('removeObsoleteFragments throws when metadatas are shorter than ids', async () => {
    getImpl = () => ({
      ids: ['obs_5_narrative', 'obs_5_fact_0'],
      metadatas: [{ sqlite_id: 5, doc_type: 'observation' }]
    });

    const sync = newSync();
    const docs = [{ id: 'obs_5_narrative', document: 'n', metadata: { sqlite_id: 5 } }];
    await expect((sync as unknown as {
      removeObsoleteFragments: (docType: string, sqliteId: number, docs: typeof docs) => Promise<void>;
    }).removeObsoleteFragments('observation', 5, docs))
      .rejects.toThrow('Chroma fragment lookup did not return a valid document ID list with metadatas');

    expect(deleteCalls()).toHaveLength(0);
  });
});
