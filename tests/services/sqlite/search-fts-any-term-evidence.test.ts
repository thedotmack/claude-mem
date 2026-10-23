import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const question = 'What was our Redis connection pool limit?';
const decision = 'Redis connection pool limit: 12 per process; 4 processes; total 48 connections.';

describe('short any-term questions retain bounded matching evidence', () => {
  let store: SessionStore;
  let search: SessionSearch;
  let sequence: number;

  function seed(text: string, project = 'billing-api', summary = false): void {
    const key = `evidence-${sequence++}`;
    const session = store.createSDKSession(key, project, 'prompt');
    store.ensureMemorySessionIdRegistered(session, `${key}-mem`);
    if (summary) {
      store.importSessionSummary({
        memory_session_id: `${key}-mem`, project, request: text,
        investigated: null, learned: null, completed: null, next_steps: null,
        files_read: null, files_edited: null, notes: null, prompt_number: 1, discovery_tokens: 0,
        created_at: new Date(1_700_000_000_000).toISOString(), created_at_epoch: 1_700_000_000_000,
      });
    } else {
      store.storeObservation(`${key}-mem`, project, {
        type: 'decision', title: text, subtitle: null, facts: [], narrative: null,
        concepts: [], files_read: [], files_modified: [],
      }, 1);
    }
  }

  function build(query: string, table = 'observations_fts'): string | null {
    return (search as unknown as { buildFTSAnyTermQuery(q: string, t: string): string | null })
      .buildFTSAnyTermQuery(query, table);
  }

  beforeEach(() => {
    sequence = 0;
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
  });

  afterEach(() => store.close());

  for (const summary of [false, true]) {
    it(`keeps the original ${summary ? 'summary' : 'observation'} discoverable as the topic grows`, () => {
      const results = () => summary
        ? search.searchSessions(question, { project: 'billing-api' }).map(row => row.request)
        : search.searchObservations(question, { project: 'billing-api' }).map(row => row.title);
      seed(decision, 'billing-api', summary);
      expect(results()).toEqual([decision]);
      seed('Redis connection pool limit reviewed during deployment', 'billing-api', summary);
      expect(results()).toContain(decision);
      expect(results()).toHaveLength(2);
      for (let index = 0; index < 8; index++) seed(`Unrelated frontend layout ${index}`, 'other', summary);
      expect(results()).toContain(decision);
      expect(results()).toHaveLength(2);
    });

    it(`preserves an existing non-ASCII ${summary ? 'summary' : 'observation'} match when admitting another term`, () => {
      seed('Αθήνα', 'billing-api', summary);
      seed('Αθήνα', 'billing-api', summary);
      seed('salvage', 'billing-api', summary);
      seed('salvage', 'billing-api', summary);
      const query = 'missing Αθήνα salvage';
      const results = summary
        ? search.searchSessions(query).map(row => row.request)
        : search.searchObservations(query).map(row => row.title);
      expect(results.filter(text => text === 'Αθήνα')).toHaveLength(2);
      expect(results.filter(text => text === 'salvage')).toHaveLength(2);
    });
  }

  it('retrieves the decision from 40 same-topic observations among 100 rows, with filters and pagination', () => {
    seed(decision);
    for (let index = 1; index < 40; index++) seed(`Redis connection pool limit deployment note ${index}`);
    for (let index = 0; index < 60; index++) seed(`Unrelated frontend layout ${index}`);
    const all = search.searchObservations(question, { project: 'billing-api', limit: 100 });
    expect(all).toHaveLength(40);
    expect(all.map(row => row.title)).toContain(decision);
    expect(search.searchObservations(question, { project: 'other' })).toEqual([]);
    expect(search.searchObservations(question, { project: 'billing-api', limit: 1, offset: 1 }).map(row => row.id))
      .toEqual([all[1].id]);
    expect(search.searchObservations(question, { project: 'billing-api', dateRange: { start: Date.now() + 60_000 } }))
      .toEqual([]);
  });

  it('does not re-admit a term whose document count alone exceeds the candidate budget', () => {
    for (let index = 0; index < 1025; index++) seed(`Redis connection pool limit note ${index}`);
    expect(build(question)).toBe('"What" OR "was" OR "our"');
    expect(search.searchObservations(question)).toEqual([]);
  });

  it('admits the least frequent excluded terms within the summed document budget', () => {
    for (let index = 0; index < 1000; index++) {
      seed(['ubiquitous', index < 400 ? 'scarce' : '', index < 600 ? 'shared' : ''].join(' '));
    }
    // All three indexed words exceed the 30% rule. 400 + 600 fits; adding 1000 does not.
    expect(build('missing ubiquitous shared scarce')).toBe('"missing" OR "scarce" OR "shared"');
  });

  it('admits a term at the exact candidate-document boundary', () => {
    for (let index = 0; index < 1024; index++) seed('Redis connection pool limit');
    expect(build(question)).toBe('"What" OR "was" OR "our" OR "Redis"');
    expect(search.searchObservations(question, { limit: 1 })).toHaveLength(1);
  });

  it('does not undercount non-ASCII matches when vocabulary folding differs from unicode61', () => {
    seed('αθηνα salvage');
    const insert = store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
      VALUES ('evidence-0-mem', 'billing-api', '', 'decision', ?, '2026-10-21T00:00:00.000Z', 1792540800000)
    `);
    store.db.transaction(() => {
      for (let index = 1; index < 1000; index++) insert.run('αθηνα salvage');
      for (let index = 0; index < 2000; index++) insert.run('αθήνα');
    })();
    // The frequency helper folds Αθήνα to αθηνα (1000 rows), but unicode61 preserves the Greek accent:
    // the actual MATCH covers 2000 rows. Admission must not mistake that estimate for a <=1024 bound.
    expect(store.db.prepare('SELECT count(*) AS n FROM observations_fts WHERE observations_fts MATCH ?')
      .get('"Αθήνα"')).toEqual({ n: 2000 });
    expect(build('missing absent Αθήνα')).toBe('"missing" OR "absent"');
    // A rejected non-ASCII term must not prevent a later affordable ASCII term from being admitted.
    expect(build('missing absent Αθήνα salvage')).toBe('"missing" OR "absent" OR "salvage"');
  });

  it('still admits non-ASCII evidence when the entire store fits within the candidate budget', () => {
    seed('αθηνα');
    seed('αθηνα');
    seed('αθήνα');
    seed('αθήνα');
    expect(build('missing absent Αθήνα')).toBe('"missing" OR "absent" OR "Αθήνα"');
    expect(search.searchObservations('missing absent Αθήνα').map(row => row.title)).toEqual(['αθήνα', 'αθήνα']);
  });

  it('charges only new candidates while retaining an existing non-ASCII match above the budget', () => {
    seed('Αθήνα');
    seed('Αθήνα');
    for (let index = 0; index < 1024; index++) seed('salvage');
    expect(build('missing Αθήνα salvage')).toBe('"missing" OR "Αθήνα" OR "salvage"');
    const results = search.searchObservations('missing Αθήνα salvage', { limit: 2000 });
    expect(results.filter(row => row.title === 'Αθήνα')).toHaveLength(2);
    expect(results.filter(row => row.title === 'salvage')).toHaveLength(1024);
  });

  for (const [cap, medium] of [[40, false], [60, true]] as const) {
    it(`retains a full ${cap}-term baseline selection instead of replacing it with admitted terms`, () => {
      const tokens = Array.from({ length: cap }, (_, index) => `ά${String(index).padStart(medium ? 3 : 1, '0')}`);
      seed(tokens.join(' '));
      seed(tokens.join(' '));
      seed('salvage');
      seed('salvage');
      const query = `${tokens.join(' ')} salvage`;
      expect(query.length >= 200).toBe(medium);
      expect(query.length).toBeLessThan(600);
      expect(build(query)?.split(' OR ')).toEqual(tokens.map(token => `"${token}"`));
      expect(search.searchObservations(query).map(row => row.title)).toEqual([tokens.join(' '), tokens.join(' ')]);
    });
  }

  it('leaves a selection with an indexed rare term unchanged', () => {
    seed('raremarker Redis connection pool limit');
    for (let index = 0; index < 9; index++) seed('Redis connection pool limit');
    expect(build('missing raremarker Redis connection pool limit'))
      .toBe('"missing" OR "raremarker"');
  });

  it('does not invent matches for a question with no indexed words', () => {
    seed(decision);
    expect(build('absent unknown missing')).toBe('"absent" OR "unknown" OR "missing"');
    expect(search.searchObservations('absent unknown missing')).toEqual([]);
  });

  for (const [count, cap, medium] of [[45, 40, false], [70, 60, true]] as const) {
    it(`keeps the ${cap}-term cap when admitting matching ${medium ? 'medium' : 'short'} tokens`, () => {
      const tokens = Array.from({ length: count }, (_, index) => `${medium ? 'w' : ''}${String(index).padStart(2, '0')}`);
      seed(tokens.join(' '));
      seed(tokens.join(' '));
      const query = tokens.join(' ');
      expect(query.length >= 200).toBe(medium);
      expect(query.length).toBeLessThan(600);
      expect(build(query)?.split(' OR ')).toHaveLength(cap);
    });
  }

  it('keeps long-prompt frequency policy unchanged', () => {
    seed(decision);
    seed('Redis connection pool limit reviewed');
    expect(build(`${'What was our '.repeat(60)}Redis connection pool limit`)).toBeNull();
  });

  it('retains the existing capped selection when vocabulary is unavailable', () => {
    seed(decision);
    seed('Redis connection pool limit reviewed');
    (search as unknown as { vocabLookups: Map<string, null> }).vocabLookups.set('observations_fts', null);
    expect(build(question)).toBe('"What" OR "was" OR "our" OR "Redis" OR "connection" OR "pool" OR "limit?"');
    expect(search.searchObservations(question).map(row => row.title)).toContain(decision);
  });

  it('retains matching evidence on a read-only file-backed connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'any-term-evidence-'));
    const path = join(directory, 'memory.db');
    try {
      const writer = new SessionStore(path);
      new SessionSearch(writer.db);
      store.close();
      store = writer;
      seed(decision);
      seed('Redis connection pool limit reviewed');
      writer.close();
      const reader = new Database(path, { readonly: true, create: false });
      try {
        expect(new SessionSearch(reader).searchObservations(question).map(row => row.title)).toContain(decision);
      } finally {
        reader.close();
      }
      store = new SessionStore(':memory:');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
