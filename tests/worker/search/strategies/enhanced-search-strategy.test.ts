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
    getObservationsByIds: (ids: number[]) => ids.map(i => byId[i]).filter(Boolean),
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
});
