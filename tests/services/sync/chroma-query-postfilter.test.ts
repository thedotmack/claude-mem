/**
 * Adaptive post-filtering for ChromaSync.queryChroma().
 *
 * Chroma brute-forces the metadata-matched candidate set rather than using the
 * HNSW graph, so cost scales with how many documents the `where` clause matches
 * (~30-50us each). Measured on a 347k-doc collection:
 *
 *     unfiltered, n_results 100..2000   0.15 - 0.29s   (flat)
 *     where {project: rxinform-cli}     6.10s          (208k docs matched)
 *
 * Over-fetching unfiltered is therefore effectively free, and filtering client
 * side is ~20x faster whenever the filter is not very selective.
 *
 * The fallback matters as much as the fast path: SearchManager deliberately
 * pushes `project` into the where clause so large projects cannot crowd small
 * ones out of the top-N. So when the over-fetch does NOT yield enough matches --
 * exactly the "small project got crowded out" case -- we must fall back to the
 * real filtered query, which is cheap precisely because that filter is selective.
 */
import { afterAll, describe, it, expect, beforeEach, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

interface Call { tool: string; args: any }
let calls: Call[] = [];

// Synthetic corpus: `big` dominates, `tiny` is a sliver -- the real shape.
const CORPUS: { id: string; project: string; doc_type: string }[] = [];
for (let i = 0; i < 1000; i++) {
  CORPUS.push({ id: `obs_${i}_fact_0`, project: i % 50 === 0 ? 'tiny' : 'big', doc_type: 'observation' });
}

function matches(where: any, meta: any): boolean {
  if (!where) return true;
  if (where.$and) return where.$and.every((clause: any) => matches(clause, meta));
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object') {
      if ('$eq' in v) return meta[k] === v.$eq;
      if ('$in' in v) return v.$in.includes(meta[k]);
      return false;
    }
    return meta[k] === v;
  });
}

// Stand-in for chroma: honours `where`, caps at n_results, preserves order.
function fakeQuery(args: any) {
  const n = args.n_results ?? 10;
  const hits = CORPUS.filter(d => matches(args.where, d)).slice(0, n);
  return {
    ids: [hits.map(d => d.id)],
    metadatas: [hits.map(d => ({ project: d.project, doc_type: d.doc_type }))],
    distances: [hits.map((_, i) => i * 0.001)],
    documents: [hits.map(d => d.id)],
  };
}

// Follow this repo's convention (see chroma-sync-unavailable.test.ts): mock the
// manager and restore the real module in afterAll, so the mock cannot leak into
// the other chroma test files that need the genuine manager.
mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (tool: string, args: any) => {
        calls.push({ tool, args });
        return tool === 'chroma_query_documents' ? fakeQuery(args) : null;
      },
    }),
  },
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, failure: () => {} },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

const queryCalls = () => calls.filter(c => c.tool === 'chroma_query_documents');

let sync: ChromaSync;

describe('ChromaSync.queryChroma adaptive post-filtering', () => {
  beforeEach(() => {
    calls = [];
    sync = new ChromaSync('claude-mem');
  });

  it('does not send a where clause to chroma for a non-selective filter', async () => {
    await sync.queryChroma('anything', 10, { project: 'big' });

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toBeUndefined();
    // and it must over-fetch, or there is nothing to filter down from
    expect(qs[0].args.n_results).toBeGreaterThan(10);
  });

  it('still returns only rows matching the filter', async () => {
    const out = await sync.queryChroma('anything', 10, { project: 'big' });

    expect(out.ids.length).toBeGreaterThan(0);
    expect(out.metadatas.every((m: any) => m.project === 'big')).toBe(true);
  });

  it('falls back to a real filtered query when the over-fetch is too sparse', async () => {
    // 'tiny' is 1-in-50, so an over-fetch cannot supply 100 of them.
    await sync.queryChroma('anything', 100, { project: 'tiny' });

    const qs = queryCalls();
    expect(qs.length).toBe(2);
    expect(qs[0].args.where).toBeUndefined();          // tried the fast path
    expect(qs[1].args.where).toEqual({ project: 'tiny' }); // then asked chroma properly
  });

  it('applies every clause of an $and filter client-side', async () => {
    const out = await sync.queryChroma('anything', 10, {
      $and: [{ doc_type: 'observation' }, { project: 'big' }],
    });

    expect(out.metadatas.length).toBeGreaterThan(0);
    expect(out.metadatas.every((m: any) => m.project === 'big' && m.doc_type === 'observation')).toBe(true);
  });

  it('sends operator filters straight to chroma rather than guessing', async () => {
    // $in is not a shape we evaluate client-side; correctness beats speed.
    await sync.queryChroma('anything', 10, { project: { $in: ['big', 'tiny'] } });

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toEqual({ project: { $in: ['big', 'tiny'] } });
  });

  it('is unchanged when there is no filter at all', async () => {
    await sync.queryChroma('anything', 10);

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toBeUndefined();
    expect(qs[0].args.n_results).toBe(10);
  });
});

describe('ChromaSync.queryChroma selectivity memo', () => {
  beforeEach(() => {
    calls = [];
    sync = new ChromaSync('claude-mem');
  });

  it('stops paying for the over-fetch once a filter is known to be selective', async () => {
    // First call learns that 'tiny' cannot fill the limit: over-fetch + fallback.
    await sync.queryChroma('anything', 100, { project: 'tiny' });
    expect(queryCalls().length).toBe(2);

    // Second identical call must skip the doomed over-fetch entirely.
    calls = [];
    await sync.queryChroma('anything', 100, { project: 'tiny' });
    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toEqual({ project: 'tiny' });
  });

  it('keeps using the fast path for a filter that fills the limit', async () => {
    await sync.queryChroma('anything', 10, { project: 'big' });
    calls = [];
    await sync.queryChroma('anything', 10, { project: 'big' });

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toBeUndefined();
  });

  it('retries the fast path when a smaller limit could now be satisfied', async () => {
    await sync.queryChroma('anything', 100, { project: 'tiny' });  // learns 20 survivors
    calls = [];
    await sync.queryChroma('anything', 5, { project: 'tiny' });    // 20 >= 5, worth trying

    const qs = queryCalls();
    expect(qs[0].args.where).toBeUndefined();
  });
});
