import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { bumpTokenDf, getProjectDocCount, buildProjectIdf, computeTitleNormKey } from '../../src/services/sqlite/dedup-store.js';

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
    bumpTokenDf(store.db, 'p2', 'added');
    expect(df('added')).toBe(2);
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
    expect(computeTitleNormKey('p', 'claude', 'On-Demand Checkpoint.')).toBe(computeTitleNormKey('p', 'claude', 'on demand checkpoint'));
    expect(computeTitleNormKey('p1', 'claude', 'same title')).not.toBe(computeTitleNormKey('p2', 'claude', 'same title')); // project-scoped
    expect(computeTitleNormKey('p', 'claude', 'same title')).not.toBe(computeTitleNormKey('p', 'codex', 'same title')); // platform-scoped
    expect(computeTitleNormKey('p', null, 'same title')).toBe(computeTitleNormKey('p', 'claude', 'same title')); // unknown platform = default
    expect(computeTitleNormKey('p', 'claude', 'same title', true)).not.toBe(computeTitleNormKey('p', 'claude', 'same title')); // agent-scoped (#3310)
    expect(computeTitleNormKey('p', 'claude', 'Added X')).not.toBe(computeTitleNormKey('p', 'claude', 'Removed X'));
    for (const empty of [null, '', '   ', '!!!', '🔵']) expect(computeTitleNormKey('p', 'claude', empty)).toBeNull();
  });
});
