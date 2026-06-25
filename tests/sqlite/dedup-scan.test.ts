import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { backfillProjectDedup, sweepProjectCandidates, runDedupScan, computeTitleNormKey } from '../../src/services/sqlite/dedup-store.js';

const CFG = { cosineThreshold: 0.8, idfVetoDf: 10, minSharedTokens: 2, maxScan: 2000 };

describe('dedup-scan: backfill + sweep (#3038)', () => {
  let store: any;
  beforeEach(() => { store = new SessionStore(':memory:'); }); // dedup OFF by default -> no maintenance
  afterEach(() => store.close());

  function seed(titles: string[], project = 'p') {
    const id = store.createSDKSession(`c-${project}`, project, 'prompt');
    store.updateMemorySessionId(id, `m-${project}`);
    let t = Date.now();
    for (const title of titles) {
      store.storeObservation(`m-${project}`, project, { type: 'discovery', title, subtitle: null, facts: [], narrative: `n-${title}`, concepts: [], files_read: [], files_modified: [] }, 1, 0, t++);
    }
  }
  const dfCount = (project = 'p') => (store.db.prepare('SELECT COUNT(*) c FROM token_df WHERE project = ?').get(project) as any).c;
  const docCount = (project = 'p') => (store.db.prepare('SELECT doc_count FROM dedup_meta WHERE project = ?').get(project) as any)?.doc_count ?? 0;
  const candCount = () => (store.db.prepare('SELECT COUNT(*) c FROM observation_dedup_candidates').get() as any).c;

  it('backfill (re)builds title_norm_key, token_df, and doc_count idempotently', () => {
    seed(['Build The Worker', 'Ship The Release', 'Audit The Logs']);
    // simulate a legacy/pre-dedup DB: blank the key and clear the IDF model
    store.db.run("UPDATE observations SET title_norm_key = NULL");
    expect(dfCount()).toBe(0);

    const n = backfillProjectDedup(store.db, 'p');
    expect(n).toBe(3);
    expect(docCount()).toBe(3);
    expect(dfCount()).toBeGreaterThan(0);
    const keyed = (store.db.prepare("SELECT COUNT(*) c FROM observations WHERE title_norm_key IS NOT NULL").get() as any).c;
    expect(keyed).toBe(3);
    const buildKey = computeTitleNormKey('p', 'Build The Worker');
    const row = store.db.prepare('SELECT title_norm_key FROM observations WHERE title = ?').get('Build The Worker') as any;
    expect(row.title_norm_key).toBe(buildKey);

    // idempotent: re-run -> same df rows + doc_count (not doubled)
    const dfBefore = dfCount();
    backfillProjectDedup(store.db, 'p');
    expect(dfCount()).toBe(dfBefore);
    expect(docCount()).toBe(3);
  });

  it('sweep finds an existing reorder near-dup and persists a review-only candidate', () => {
    seed([
      'alpha bravo charlie', 'delta echo foxtrot', 'golf hotel india',
      'build the worker service module', 'worker build the service module', // reorder near-dup
    ]);
    backfillProjectDedup(store.db, 'p');
    const n = sweepProjectCandidates(store.db, 'p', CFG);
    expect(n).toBeGreaterThanOrEqual(1);

    const ids = store.db.prepare("SELECT id FROM observations WHERE title LIKE '%worker%service%' OR title LIKE '%worker build%'").all() as any[];
    expect(ids.length).toBe(2);
    const cand = store.db.prepare('SELECT method, status FROM observation_dedup_candidates LIMIT 1').get() as any;
    expect(cand.method).toBe('idf_cosine');
    expect(cand.status).toBe('pending');
  });

  it('sweep is idempotent (re-run does not duplicate candidate rows)', () => {
    seed(['build the worker service module', 'worker build the service module', 'totally distinct topic here']);
    backfillProjectDedup(store.db, 'p');
    sweepProjectCandidates(store.db, 'p', CFG);
    const after1 = candCount();
    sweepProjectCandidates(store.db, 'p', CFG);
    expect(candCount()).toBe(after1); // UNIQUE(observation_id,duplicate_of_id) guards
  });

  it('listDedupCandidates returns candidates joined to both titles, project-scoped', () => {
    seed(['build the worker service module', 'worker build the service module', 'distinct subject matter']);
    backfillProjectDedup(store.db, 'p');
    sweepProjectCandidates(store.db, 'p', CFG);
    const list = store.listDedupCandidates('p');
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].observation_title).toBeTruthy();
    expect(list[0].duplicate_of_title).toBeTruthy();
    expect(list[0].method).toBe('idf_cosine');
    expect(store.listDedupCandidates('other-project')).toEqual([]);
  });

  it('store.runDedupScan() backfills + sweeps all projects via configured knobs', () => {
    process.env.CLAUDE_MEM_DEDUP_COSINE_THRESHOLD = '0.80';
    seed(['build the worker service module', 'worker build the service module'], 'pp');
    const report = store.runDedupScan();
    expect(report.find((r: any) => r.project === 'pp')?.docs).toBe(2);
    delete process.env.CLAUDE_MEM_DEDUP_COSINE_THRESHOLD;
  });

  it('runDedupScan covers every project', () => {
    seed(['one alpha', 'two beta'], 'projA');
    seed(['three gamma', 'four delta'], 'projB');
    const report = runDedupScan(store.db, CFG);
    expect(report.map(r => r.project).sort()).toEqual(['projA', 'projB']);
    expect(report.every(r => r.docs === 2)).toBe(true);
  });
});
