import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function cols(store: any, t: string): string[] {
  return (store.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
}
function hasTable(store: any, n: string): boolean {
  return !!store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(n);
}
const OBS = {
  type: 'discovery', title: 'T', subtitle: null as string | null, facts: [] as string[],
  narrative: 'N', concepts: [] as string[], files_read: [] as string[], files_modified: [] as string[],
};

describe('dedup schema migration (#3038)', () => {
  let store: any;
  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => store.close());

  function session(mem: string): string {
    const id = store.createSDKSession(`content-${mem}`, 'project', 'prompt');
    store.updateMemorySessionId(id, mem);
    return mem;
  }
  function store1(mem: string, title: string) {
    return store.storeObservation(mem, 'project', { ...OBS, title, narrative: `n-${title}` }, 1, 0, Date.now());
  }

  it('adds observations.occurrence_count defaulting to 1', () => {
    expect(cols(store, 'observations')).toContain('occurrence_count');
    const r = store1(session('m1'), 'Hello');
    const row = store.db.prepare('SELECT occurrence_count FROM observations WHERE id = ?').get(r.id) as { occurrence_count: number };
    expect(row.occurrence_count).toBe(1);
  });

  it('creates token_df / dedup_meta / observation_dedup_candidates with the expected columns', () => {
    expect(hasTable(store, 'token_df')).toBe(true);
    expect(cols(store, 'token_df')).toEqual(expect.arrayContaining(['project', 'token', 'df']));
    expect(hasTable(store, 'dedup_meta')).toBe(true);
    expect(cols(store, 'dedup_meta')).toEqual(expect.arrayContaining(['project', 'doc_count', 'last_rebuild_doc_count', 'deleted_since_rebuild']));
    expect(hasTable(store, 'observation_dedup_candidates')).toBe(true);
    expect(cols(store, 'observation_dedup_candidates')).toEqual(
      expect.arrayContaining(['id', 'observation_id', 'duplicate_of_id', 'project', 'method', 'score', 'status', 'created_at', 'created_at_epoch', 'metadata'])
    );
  });

  it('starts candidates empty and records schema version 36', () => {
    expect((store.db.query('SELECT COUNT(*) c FROM observation_dedup_candidates').get() as { c: number }).c).toBe(0);
    expect(!!store.db.query('SELECT version FROM schema_versions WHERE version = 36').get()).toBe(true);
  });

  it('is idempotent (re-running migrations on the same db does not throw)', () => {
    expect(() => new SessionStore(store.db)).not.toThrow();
  });

  it('enforces UNIQUE(observation_id, duplicate_of_id) on candidates', () => {
    const mem = session('m2');
    const a = store1(mem, 'A');
    const b = store1(mem, 'B');
    const ins = () => store.db.prepare(
      "INSERT INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?,?,?,?,?,?,?,?)"
    ).run(a.id, b.id, 'project', 'idf_cosine', 0.9, 'pending', new Date().toISOString(), Date.now());
    ins();
    expect(ins).toThrow();
  });

  it('rejects an invalid method/status via CHECK constraints', () => {
    const mem = session('m3');
    const a = store1(mem, 'A');
    const b = store1(mem, 'B');
    expect(() => store.db.prepare(
      "INSERT INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?,?,?,?,?,?,?,?)"
    ).run(a.id, b.id, 'project', 'bogus_method', 0.9, 'pending', new Date().toISOString(), Date.now())).toThrow();
  });
});
