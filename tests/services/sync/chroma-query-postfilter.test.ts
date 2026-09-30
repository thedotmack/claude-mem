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
// Capture the current exports before mock.module mutates the live namespace, and
// re-register them in afterAll so these mocks do not leak into later files
// (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';
import * as realLogger from '../../../src/utils/logger.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
const realLoggerSnapshot = { ...realLogger };

interface Call { tool: string; args: any }
let calls: Call[] = [];

interface CorpusDoc {
  id: string;
  project: string;
  merged_into_project?: string;
  doc_type: string;
  platform_source: string;
}

// Synthetic corpus: `big` dominates, `tiny` is a sliver -- the real shape.
// `big-old` is a project that was merged into `big`, so only the dual-project
// clause ({project} OR {merged_into_project}) reaches it.
const CORPUS: CorpusDoc[] = [];
for (let i = 0; i < 1000; i++) {
  const project = i % 50 === 0 ? 'tiny' : i % 7 === 0 ? 'big-old' : 'big';
  CORPUS.push({
    id: `obs_${i}_fact_0`,
    project,
    // addDocuments strips empty metadata, so unmerged docs have no such key.
    ...(project === 'big-old' ? { merged_into_project: 'big' } : {}),
    doc_type: i % 10 === 9 ? 'session_summary' : 'observation',
    platform_source: i % 3 === 0 ? 'codex' : 'claude',
  });
}

function matches(where: any, meta: any): boolean {
  if (!where) return true;
  if (where.$and) return where.$and.every((clause: any) => matches(clause, meta));
  if (where.$or) return where.$or.some((clause: any) => matches(clause, meta));
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object') {
      if ('$eq' in v) return meta[k] === v.$eq;
      if ('$in' in v) return v.$in.includes(meta[k]);
      return false;
    }
    return meta[k] === v;
  });
}

// Stand-in for chroma: honours `where` and `include`, caps at n_results, preserves order.
function fakeQuery(args: any) {
  const n = args.n_results ?? 10;
  const hits = CORPUS.filter(d => matches(args.where, d)).slice(0, n);
  const include: string[] = args.include ?? ['documents', 'metadatas', 'distances'];
  return {
    ids: [hits.map(d => d.id)],
    metadatas: include.includes('metadatas') ? [hits.map(({ id: _id, ...metadata }) => metadata)] : null,
    distances: include.includes('distances') ? [hits.map((_, i) => i * 0.001)] : null,
    documents: include.includes('documents') ? [hits.map(d => d.id)] : null,
  };
}

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
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
});

const queryCalls = () => calls.filter(c => c.tool === 'chroma_query_documents');

// The project scoping SearchManager and ChromaSearchStrategy put on every
// project search (SearchManager.buildDocTypeWhereFilter and search()).
const dualProject = (project: string) => ({
  $or: [{ project }, { merged_into_project: project }],
});

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

  it('over-fetches only metadatas and distances, which is all it reads', async () => {
    await sync.queryChroma('anything', 100, { project: 'tiny' });

    const qs = queryCalls();
    expect(qs[0].args.include).toEqual(['metadatas', 'distances']);
    expect(qs[1].args.include).toEqual(['documents', 'metadatas', 'distances']);
  });

  it('never takes the fast path for a limit of zero', async () => {
    await sync.queryChroma('anything', 0, { project: 'big' });

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toEqual({ project: 'big' });
  });
});

describe('ChromaSync.queryChroma with the dual-project $or scoping', () => {
  beforeEach(() => {
    calls = [];
    sync = new ChromaSync('claude-mem');
  });

  it('evaluates the $or project clause client-side, including merged projects', async () => {
    const out = await sync.queryChroma('anything', 100, dualProject('big'));

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toBeUndefined();
    expect(out.ids.length).toBe(100);
    expect(out.metadatas.every((m: any) => m.project === 'big' || m.merged_into_project === 'big')).toBe(true);
    // Documents from the project that was merged into `big` come through too.
    expect(out.metadatas.some((m: any) => m.project === 'big-old')).toBe(true);
    expect(out.metadatas.some((m: any) => m.project === 'tiny')).toBe(false);
  });

  it('matches what chroma returns for the same $or clause', async () => {
    const where = dualProject('big');
    const fast = await sync.queryChroma('anything', 20, where);

    const exact = CORPUS.filter(d => matches(where, d)).slice(0, 20).map(d => Number(d.id.split('_')[1]));
    expect(fast.ids).toEqual(exact);
  });

  it('handles the full SearchManager shape: doc_type AND dual-project AND platform_source', async () => {
    const where = {
      $and: [{ doc_type: 'observation' }, dualProject('big'), { platform_source: 'claude' }],
    };

    const out = await sync.queryChroma('anything', 50, where);

    const qs = queryCalls();
    expect(qs.length).toBe(1);
    expect(qs[0].args.where).toBeUndefined();
    expect(out.ids.length).toBe(50);
    expect(out.metadatas.every((m: any) =>
      m.doc_type === 'observation' &&
      (m.project === 'big' || m.merged_into_project === 'big') &&
      m.platform_source === 'claude'
    )).toBe(true);
  });

  it('falls back to chroma with the exact $or clause when the project is too small', async () => {
    await sync.queryChroma('anything', 100, dualProject('tiny'));

    const qs = queryCalls();
    expect(qs.length).toBe(2);
    expect(qs[0].args.where).toBeUndefined();
    expect(qs[1].args.where).toEqual(dualProject('tiny'));
  });

  it('sends shapes chroma itself rejects straight to chroma, so they fail as before', async () => {
    // Several keys in one clause, and an $or with a single clause, are invalid
    // chroma filters; evaluating them here would hide the error.
    const invalidFilters = [
      { project: 'big', doc_type: 'observation' },
      { $or: [{ project: 'big' }] },
      { $and: [] },
      { project: null },
    ];

    for (const where of invalidFilters) {
      calls = [];
      await sync.queryChroma('anything', 10, where as Record<string, any>);
      const qs = queryCalls();
      expect(qs.length).toBe(1);
      expect(qs[0].args.where).toEqual(where);
    }
  });
});

describe('ChromaSync.queryChroma selectivity memo', () => {
  const memoOf = (instance: ChromaSync) =>
    (instance as unknown as { selectiveFilters: Map<string, number> }).selectiveFilters;

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

  it('forgets a filter once the fast path fills the limit for it again', async () => {
    await sync.queryChroma('anything', 100, { project: 'tiny' });
    expect(memoOf(sync).get(JSON.stringify({ project: 'tiny' }))).toBe(20);

    // Limit 1 over-fetches 20 documents, and the first one is `tiny`.
    calls = [];
    const out = await sync.queryChroma('anything', 1, { project: 'tiny' });

    expect(queryCalls().length).toBe(1);
    expect(out.ids).toEqual([0]);
    expect(memoOf(sync).has(JSON.stringify({ project: 'tiny' }))).toBe(false);
  });

  it('clears the memo when it reaches its cap instead of growing without bound', async () => {
    // Each unknown project is selective (no survivors), so each one is memoized.
    for (let i = 0; i < 256; i++) {
      await sync.queryChroma('anything', 1, { project: `absent-${i}` });
    }
    expect(memoOf(sync).size).toBe(256);

    await sync.queryChroma('anything', 1, { project: 'absent-256' });

    expect(memoOf(sync).size).toBe(1);
    expect(memoOf(sync).has(JSON.stringify({ project: 'absent-256' }))).toBe(true);
  });
});
