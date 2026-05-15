import { test, expect, describe } from 'bun:test';
import { EnhancedSearchStrategy } from '../../../../src/services/worker/search/strategies/EnhancedSearchStrategy.js';

// Minimal stub observation matching ObservationSearchResult's used fields.
function obs(id: number, over: Record<string, any> = {}) {
  return {
    id, memory_session_id: 's', project: 'p', text: null, type: 'discovery',
    title: `obs ${id}`, subtitle: null, facts: null, narrative: null,
    concepts: null, files_read: null, files_modified: null, prompt_number: null,
    discovery_tokens: 0, created_at: '', created_at_epoch: id, relevance_count: 0,
    ...over,
  };
}

function makeSessionSearch(ftsResults: any[]) {
  return { searchObservations: (_q: any, _o: any) => ftsResults } as any;
}
function makeSessionStore(byId: Record<number, any>) {
  return {
    getObservationsByIds: (ids: number[], options: any = {}) => {
      let rows = ids.map(i => byId[i]).filter(Boolean);
      if (options.type) {
        const types = Array.isArray(options.type) ? options.type : [options.type];
        rows = rows.filter((r: any) => types.includes(r.type));
      }
      return rows;
    },
  } as any;
}
function makeChroma(ids: number[], fail = false) {
  return {
    queryChroma: async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return { ids, distances: [], metadatas: [] };
    },
  } as any;
}

describe('EnhancedSearchStrategy', () => {
  test('confident FTS5 top hit => FTS5-only, Chroma not queried', async () => {
    let chromaCalled = false;
    const chroma = { queryChroma: async () => { chromaCalled = true; return { ids: [], distances: [], metadatas: [] }; } } as any;
    const fts = [obs(1, { title: 'worker restart migration done' })];
    const strategy = new EnhancedSearchStrategy(chroma, makeSessionStore({ 1: fts[0] }), makeSessionSearch(fts));

    const result = await strategy.search({ query: 'worker restart migration' });

    expect(chromaCalled).toBe(false);
    expect(result.usedChroma).toBe(false);
    expect(result.results.observations.map((o: any) => o.id)).toEqual([1]);
  });

  test('flat FTS5 top hit => hybrid path merges Chroma ids', async () => {
    const fts = [obs(1, { title: 'partial match only' })];
    const byId = { 1: fts[0], 2: obs(2), 3: obs(3) };
    const strategy = new EnhancedSearchStrategy(
      makeChroma([2, 3]), makeSessionStore(byId), makeSessionSearch(fts),
    );

    const result = await strategy.search({ query: 'worker restart migration rollback audit' });

    expect(result.usedChroma).toBe(true);
    const ids = result.results.observations.map((o: any) => o.id).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  test('Chroma failure on hybrid path => graceful FTS5-only fallback', async () => {
    const fts = [obs(1, { title: 'partial' })];
    const strategy = new EnhancedSearchStrategy(
      makeChroma([], true), makeSessionStore({ 1: fts[0] }), makeSessionSearch(fts),
    );

    const result = await strategy.search({ query: 'worker restart migration rollback audit' });

    expect(result.usedChroma).toBe(false);
    expect(result.results.observations.map((o: any) => o.id)).toEqual([1]);
  });

  test('empty query => empty result', async () => {
    const strategy = new EnhancedSearchStrategy(makeChroma([]), makeSessionStore({}), makeSessionSearch([]));
    const result = await strategy.search({ query: '' });
    expect(result.results.observations).toEqual([]);
  });

  test('hybrid path applies obs_type filter', async () => {
    const fts = [obs(1, { title: 'partial', type: 'bugfix' })];
    const byId = { 1: fts[0], 2: obs(2, { type: 'feature' }), 3: obs(3, { type: 'bugfix' }) };
    const strategy = new EnhancedSearchStrategy(
      makeChroma([2, 3]), makeSessionStore(byId), makeSessionSearch(fts),
    );

    const result = await strategy.search({ query: 'worker restart migration rollback audit', obsType: 'bugfix' });

    expect(result.usedChroma).toBe(true);
    const ids = result.results.observations.map((o: any) => o.id).sort();
    expect(ids).toEqual([1, 3]); // obs 2 (feature) filtered out
  });

  test('hybrid path applies date range filter', async () => {
    const fts = [obs(1, { title: 'partial', created_at_epoch: 5000 })];
    const byId = { 1: fts[0], 2: obs(2, { created_at_epoch: 1000 }), 3: obs(3, { created_at_epoch: 9000 }) };
    const strategy = new EnhancedSearchStrategy(
      makeChroma([2, 3]), makeSessionStore(byId), makeSessionSearch(fts),
    );

    const result = await strategy.search({ query: 'worker restart migration rollback audit', dateRange: { start: 4000, end: 8000 } });

    expect(result.usedChroma).toBe(true);
    const ids = result.results.observations.map((o: any) => o.id).sort();
    expect(ids).toEqual([1]); // obs 2 (epoch 1000) and obs 3 (epoch 9000) outside [4000, 8000]
  });
});
