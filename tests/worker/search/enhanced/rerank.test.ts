import { test, expect, describe } from 'bun:test';
import { rerank, RerankableObservation } from '../../../../src/services/worker/search/enhanced/rerank.js';

function obs(over: Partial<RerankableObservation> & { id: number }): RerankableObservation {
  return {
    title: null, subtitle: null, narrative: null, facts: null,
    created_at_epoch: 0, relevance_count: 0,
    ...over,
  };
}

describe('rerank', () => {
  test('empty input yields empty output', () => {
    expect(rerank([], 'anything')).toEqual([]);
  });

  test('positional prior preserved when no signals differ', () => {
    const input = [obs({ id: 1 }), obs({ id: 2 }), obs({ id: 3 })];
    expect(rerank(input, 'query').map(o => o.id)).toEqual([1, 2, 3]);
  });

  test('strong entity-match lifts a lower-ranked candidate', () => {
    // id 2 starts second but its text fully matches the query tokens.
    const input = [
      obs({ id: 1, narrative: 'unrelated content here' }),
      obs({ id: 2, narrative: 'worker restart database migration' }),
    ];
    const out = rerank(input, 'worker restart database migration', { entityWeight: 1.0 });
    expect(out[0].id).toBe(2);
  });

  test('recency lifts a newer candidate when weight is high', () => {
    const input = [
      obs({ id: 1, created_at_epoch: 1000 }),
      obs({ id: 2, created_at_epoch: 9000 }),
    ];
    const out = rerank(input, 'query', { recencyWeight: 1.0 });
    expect(out[0].id).toBe(2);
  });
});
