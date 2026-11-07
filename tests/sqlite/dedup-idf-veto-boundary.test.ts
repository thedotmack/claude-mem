import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { backfillProjectDedup, sweepProjectCandidates } from '../../src/services/sqlite/dedup-store.js';

// #3038 — the IDF-veto boundary. The documented contract for CLAUDE_MEM_DEDUP_IDF_VETO_DF
// (SettingsDefaultsManager + FuzzyDedupConfig) is: "a token appearing in <= idfVetoDf
// records is discriminating" and so vetoes a near-duplicate. A token sitting EXACTLY at
// idfVetoDf must therefore fire the veto.
const CFG = { cosineThreshold: 0.8, idfVetoDf: 3, minSharedTokens: 2, maxScan: 2000, maxBackfillRows: 50000 };

describe('dedup IDF-veto boundary (#3038)', () => {
  let store: any;
  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => store.close());

  function seed(titles: string[], project = 'p') {
    const id = store.createSDKSession(`c-${project}`, project, 'prompt');
    store.updateMemorySessionId(id, `m-${project}`);
    let t = Date.now();
    for (const title of titles) {
      store.storeObservation(`m-${project}`, project, { type: 'discovery', title, subtitle: null, facts: [], narrative: `n-${title}`, concepts: [], files_read: [], files_modified: [] }, 1, 0, t++);
    }
  }
  const candCount = () => (store.db.prepare('SELECT COUNT(*) c FROM observation_dedup_candidates').get() as any).c;

  it('vetoes a pair whose only distinguisher sits at exactly idfVetoDf records', () => {
    // sa..se, xa and xb each end up in EXACTLY 3 (= idfVetoDf) records.
    // The near-dup pairs below differ only by xa / xb, each a discriminating
    // token under the documented "<= idfVetoDf" rule, so none may be flagged.
    seed([
      'sa sb sc sd se xa', // obs 1
      'sa sb sc sd se xb', // obs 2 — symmetric diff {xa, xb}
      'sa sb sc sd se',    // obs 3 — symmetric diff {xa} / {xb} vs 1 / 2
      'xa pone ptwo',      // obs 4
      'xa qone qtwo',      // obs 5 — xa now in records 1,4,5 -> df 3
      'xb rone rtwo',      // obs 6
      'xb tone ttwo',      // obs 7 — xb now in records 2,6,7 -> df 3
    ]);
    backfillProjectDedup(store.db, 'p');

    // Precondition: the distinguishing tokens really are at the boundary df.
    const df = (token: string) => (store.db.prepare('SELECT df FROM token_df WHERE project = ? AND token = ?').get('p', token) as any)?.df ?? 0;
    expect(df('xa')).toBe(CFG.idfVetoDf);
    expect(df('xb')).toBe(CFG.idfVetoDf);
    expect(df('sa')).toBe(CFG.idfVetoDf);

    const persisted = sweepProjectCandidates(store.db, 'p', CFG);

    // Every near-dup pair differs only by a token in exactly idfVetoDf records,
    // which the veto must treat as discriminating -> zero candidates.
    expect(persisted).toBe(0);
    expect(candCount()).toBe(0);
  });
});
