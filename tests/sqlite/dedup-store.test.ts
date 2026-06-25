import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { bumpTokenDf, getProjectDocCount, buildProjectIdf, isFuzzyReady, computeTitleNormKey, findTier0Canonical } from '../../src/services/sqlite/dedup-store.js';

describe('dedup-store: token_df maintenance + IDF lookup (#3038)', () => {
  let store: any;
  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => store.close());

  it('bumps df per UNIQUE title token and increments project doc_count', () => {
    bumpTokenDf(store.db, 'p', 'added rdlp-api crate crate'); // 'crate' twice -> counted once
    const df = (t: string) => (store.db.prepare('SELECT df FROM token_df WHERE project=? AND token=?').get('p', t) as any)?.df ?? 0;
    expect(df('added')).toBe(1);
    expect(df('rdlp-api')).toBe(1);
    expect(df('crate')).toBe(1);
    expect(getProjectDocCount(store.db, 'p')).toBe(1);

    bumpTokenDf(store.db, 'p', 'added plugin');
    expect(df('added')).toBe(2);
    expect(df('plugin')).toBe(1);
    expect(getProjectDocCount(store.db, 'p')).toBe(2);
  });

  it('scopes df per project', () => {
    bumpTokenDf(store.db, 'p1', 'shared token');
    bumpTokenDf(store.db, 'p2', 'shared token');
    const df = (proj: string, t: string) => (store.db.prepare('SELECT df FROM token_df WHERE project=? AND token=?').get(proj, t) as any)?.df ?? 0;
    expect(df('p1', 'shared')).toBe(1);
    expect(df('p2', 'shared')).toBe(1);
    expect(getProjectDocCount(store.db, 'p1')).toBe(1);
  });

  it('buildProjectIdf weights a rare token above a common one', () => {
    for (let i = 0; i < 20; i++) bumpTokenDf(store.db, 'p', `common token-${i}`); // 'common' in all 20
    bumpTokenDf(store.db, 'p', 'common raretoken');                              // 'raretoken' in 1
    const { idfFn, docCount } = buildProjectIdf(store.db, 'p');
    expect(docCount).toBe(21);
    expect(idfFn('raretoken')).toBeGreaterThan(idfFn('common'));
    expect(idfFn('never-seen')).toBeGreaterThan(idfFn('raretoken')); // df=0 -> highest
  });

  it('computeTitleNormKey: equal for normalization-equivalent titles, distinct per project, null for empty', () => {
    expect(computeTitleNormKey('p', 'On-Demand Checkpoint.')).toBe(computeTitleNormKey('p', 'on demand checkpoint'));
    expect(computeTitleNormKey('p1', 'same title')).not.toBe(computeTitleNormKey('p2', 'same title')); // project-scoped
    expect(computeTitleNormKey('p', 'Added X')).not.toBe(computeTitleNormKey('p', 'Removed X'));
    for (const empty of [null, '', '   ', '!!!', '🔵']) expect(computeTitleNormKey('p', empty)).toBeNull();
  });

  it('findTier0Canonical returns the oldest matching row, null on miss or null key', () => {
    const id = store.createSDKSession('content-t0', 'project', 'prompt');
    store.updateMemorySessionId(id, 'mem-t0');
    const norm = computeTitleNormKey('project', 'Hardened Checkpoint!');
    const o = { type: 'discovery', title: 'x', subtitle: null, facts: [], narrative: 'x', concepts: [], files_read: [], files_modified: [] };
    store.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?")
      .run(norm, store.storeObservation('mem-t0', 'project', o, 1, 0, Date.now()).id);
    const hit = findTier0Canonical(store.db, 'project', norm);
    expect(hit?.id).toBeGreaterThan(0);
    expect(findTier0Canonical(store.db, 'project', computeTitleNormKey('project', 'totally different'))).toBeNull();
    expect(findTier0Canonical(store.db, 'project', null)).toBeNull();
  });

  it('isFuzzyReady gates on the cold-start minimum doc count', () => {
    for (let i = 0; i < 9; i++) bumpTokenDf(store.db, 'p', `doc ${i}`);
    expect(isFuzzyReady(store.db, 'p', 10)).toBe(false); // 9 < 10
    bumpTokenDf(store.db, 'p', 'doc 9');
    expect(isFuzzyReady(store.db, 'p', 10)).toBe(true);  // 10 >= 10
    expect(isFuzzyReady(store.db, 'brand-new', 10)).toBe(false); // unknown project -> 0
  });
});
