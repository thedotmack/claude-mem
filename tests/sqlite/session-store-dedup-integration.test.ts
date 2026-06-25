import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const ENV_KEYS = ['CLAUDE_MEM_DEDUP_ENABLED', 'CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS'] as const;
const saved: Record<string, string | undefined> = {};

function obs(title: string, narrative = 'n') {
  return { type: 'discovery', title, subtitle: null as string | null, facts: [] as string[], narrative, concepts: [] as string[], files_read: [] as string[], files_modified: [] as string[] };
}

describe('storeObservation dedup integration (#3038)', () => {
  let store: any;
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    store = new SessionStore(':memory:');
  });
  afterEach(() => {
    store.close();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  function session(mem: string, project = 'p'): string {
    const id = store.createSDKSession(`content-${mem}`, project, 'prompt');
    store.updateMemorySessionId(id, mem);
    return mem;
  }
  const rowCount = (project = 'p') => (store.db.prepare('SELECT COUNT(*) c FROM observations WHERE project = ?').get(project) as any).c;
  const candCount = () => (store.db.prepare('SELECT COUNT(*) c FROM observation_dedup_candidates').get() as any).c;

  it('Tier-0: collapses a normalized-equal title across sessions and bumps occurrence_count', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const t = Date.now();
    const a = store.storeObservation(session('s1'), 'p', obs('On-Demand Checkpoint.'), 1, 0, t);
    const b = store.storeObservation(session('s2'), 'p', obs('on demand checkpoint'), 1, 0, t + 1000);
    expect(b.id).toBe(a.id);
    expect(rowCount()).toBe(1);
    const occ = (store.db.prepare('SELECT occurrence_count FROM observations WHERE id = ?').get(a.id) as any).occurrence_count;
    expect(occ).toBe(2);
  });

  it('Tier-0: does NOT collapse the same normalized title across DIFFERENT projects', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const t = Date.now();
    store.storeObservation(session('s1', 'p1'), 'p1', obs('Same Title'), 1, 0, t);
    store.storeObservation(session('s2', 'p2'), 'p2', obs('Same Title'), 1, 0, t + 1000);
    expect(rowCount('p1')).toBe(1);
    expect(rowCount('p2')).toBe(1);
  });

  it('disabled (default): normalized-equal cross-session titles both insert (byte-identical legacy behavior)', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'false';
    const t = Date.now();
    store.storeObservation(session('s1'), 'p', obs('On-Demand Checkpoint.'), 1, 0, t);
    store.storeObservation(session('s2'), 'p', obs('on demand checkpoint'), 1, 0, t + 1000);
    expect(rowCount()).toBe(2);
    expect(candCount()).toBe(0);
  });

  it('Tier-1: persists a review-only candidate for a reorder near-dup once the corpus is warm', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    process.env.CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS = '2';
    const mem = session('s1');
    let t = Date.now();
    store.storeObservation(mem, 'p', obs('alpha bravo charlie delta'), 1, 0, t++);
    store.storeObservation(mem, 'p', obs('echo foxtrot golf hotel'), 1, 0, t++);
    const r1 = store.storeObservation(mem, 'p', obs('build the worker service module'), 1, 0, t++);
    const r2 = store.storeObservation(mem, 'p', obs('worker build the service module'), 1, 0, t++); // pure reorder
    expect(r2.id).not.toBe(r1.id); // reorder is NOT Tier-0 exact
    const cand = store.db.prepare(
      'SELECT method, status FROM observation_dedup_candidates WHERE observation_id = ? AND duplicate_of_id = ?'
    ).get(r2.id, r1.id) as any;
    expect(cand?.method).toBe('idf_cosine');
    expect(cand?.status).toBe('pending');
  });

  it('storeObservations batch: collapses an intra-batch normalized-equal pair to one row', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const mem = session('s1');
    const res = store.storeObservations(mem, 'p', [obs('Foo Bar!'), obs('foo bar'), obs('Distinct One')], null, 1, 0, Date.now());
    expect(res.observationIds[0]).toBe(res.observationIds[1]); // the pair collapsed to one id
    expect(rowCount()).toBe(2); // {foo bar} + {distinct one}
    const occ = (store.db.prepare('SELECT occurrence_count FROM observations WHERE id = ?').get(res.observationIds[0]) as any).occurrence_count;
    expect(occ).toBe(2);
  });

  it('storeObservations batch: disabled leaves legacy behavior (no collapse, no candidates)', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'false';
    const mem = session('s1');
    store.storeObservations(mem, 'p', [obs('Foo Bar!'), obs('foo bar')], null, 1, 0, Date.now());
    expect(rowCount()).toBe(2);
    expect(candCount()).toBe(0);
  });

  it('cold-start: below MIN_PROJECT_DOCS, Tier-1 is skipped (no candidates) but Tier-0 still merges', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    process.env.CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS = '10';
    const mem = session('s1');
    let t = Date.now();
    const r1 = store.storeObservation(mem, 'p', obs('build the worker service module'), 1, 0, t++);
    store.storeObservation(mem, 'p', obs('worker build the service module'), 1, 0, t++); // reorder, but cold-start
    expect(candCount()).toBe(0);
    // Tier-0 exact still works even cold:
    const dup = store.storeObservation(mem, 'p', obs('Build The Worker Service Module'), 1, 0, t++);
    expect(dup.id).toBe(r1.id);
  });
});
