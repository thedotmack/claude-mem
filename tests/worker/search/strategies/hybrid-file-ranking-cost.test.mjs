import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridSearchStrategy } from '../../../../src/services/worker/search/strategies/HybridSearchStrategy.js';

function fixture(ids, ranking, hydrate = ids => [...ids].reverse().map(id => ({ id, created_at_epoch: id }))) {
  let requested;
  const observations = ids.map(id => ({ id, created_at_epoch: id }));
  const sessions = [{ id: 8 }];
  const strategy = new HybridSearchStrategy(
    { queryChroma: async () => ({ ids: ranking }) },
    {
      getProjectReadKeys: projects => projects,
      getObservationsByIds: (ids, options) => { requested = [...ids]; return hydrate(ids, options); },
    },
    { findByFile: () => ({ observations, sessions }) },
  );
  return { strategy, sessions, requested: () => requested };
}

test('semantic ranks precede remaining metadata matches without duplicates', async () => {
  const f = fixture([1, 2, 3, 4, 2], [3, 3, 999, 1]);
  const result = await f.strategy.findByFile('src/main.ts', { limit: 10 });
  assert.deepEqual(f.requested(), [3, 1, 2, 4]);
  assert.deepEqual(result.observations.map(row => row.id), [3, 1, 2, 4]);
  assert.equal(result.sessions, f.sessions);
  assert.equal(result.usedChroma, true);
});

test('an explicit date order keeps the storage ordering', async () => {
  const f = fixture([1, 2, 3], [3, 1], (ids, options) => {
    assert.equal(options.orderBy, 'date_asc');
    return [...ids].sort((a, b) => a - b).map(id => ({ id }));
  });
  const result = await f.strategy.findByFile('src/main.ts', { limit: 10, orderBy: 'date_asc' });
  assert.deepEqual(result.observations.map(row => row.id), [1, 2, 3]);
});

test('empty semantic intersection retains metadata fallback ordering and limit', async () => {
  const f = fixture([1, 3, 2], [999]);
  const result = await f.strategy.findByFile('src/main.ts', { limit: 2 });
  assert.deepEqual(result.observations.map(row => row.id), [3, 2]);
  assert.equal(result.usedChroma, false);
});

test('large file histories retain every metadata match and the semantic prefix', async () => {
  const ids = Array.from({ length: 50000 }, (_, index) => index + 1);
  const f = fixture(ids, [50000, 3, 50000, 1]);
  const result = await f.strategy.findByFile('src/main.ts', { limit: ids.length });
  assert.equal(result.observations.length, ids.length);
  assert.deepEqual(result.observations.slice(0, 5).map(row => row.id), [50000, 3, 1, 2, 4]);
  assert.equal(new Set(result.observations.map(row => row.id)).size, ids.length);
});
