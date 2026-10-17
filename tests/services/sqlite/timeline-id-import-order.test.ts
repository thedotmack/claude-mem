import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let store: SessionStore;
afterEach(() => store?.close());

function seed(epoch: number, label = String(epoch)) {
  return store.storeObservation('ordered-memory', 'ordered-project', {
    type: 'discovery', title: `observation-${label}`, subtitle: null,
    narrative: null, facts: [], concepts: [], files_read: [], files_modified: [],
  }, 1, 0, epoch).id;
}

it.each([false, true])('keeps an ID anchor and chronological neighbors after out-of-order capture (reverse=%s)', (reverse) => {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('ordered-content', 'ordered-project', 'prompt');
  store.ensureMemorySessionIdRegistered(sid, 'ordered-memory');
  const epochs = reverse ? [3000, 1000, 2000] : [1000, 3000, 2000];
  const ids = new Map(epochs.map(epoch => [epoch, seed(epoch)]));
  const before = store.getTimelineAroundObservation(ids.get(2000)!, 2000, 1, 0, 'ordered-project');
  expect(before.observations.map(row => row.id)).toEqual([ids.get(1000), ids.get(2000)]);
  const after = store.getTimelineAroundObservation(ids.get(2000)!, 2000, 0, 1, 'ordered-project');
  expect(after.observations.map(row => row.id)).toEqual([ids.get(2000), ids.get(3000)]);
  const anchorOnly = store.getTimelineAroundObservation(ids.get(2000)!, 2000, 0, 0, 'ordered-project');
  expect(anchorOnly.observations.map(row => row.id)).toEqual([ids.get(2000)]);
});

it('keeps tied-epoch boundaries while using the existing timestamp index without a temporary sort', () => {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('ordered-content', 'ordered-project', 'prompt');
  store.ensureMemorySessionIdRegistered(sid, 'ordered-memory');
  const older = seed(1000);
  const tiedBefore = seed(2000, "tied-before");
  const anchor = seed(2000, "anchor");
  const later = seed(3000);
  const plans: Array<Array<{ detail: string }>> = [];
  const prepare = store.db.prepare.bind(store.db);
  (store.db as any).prepare = (sql: string, ...parameters: any[]) => {
    const statement = (prepare as any)(sql, ...parameters);
    if (sql.includes('SELECT o.id, o.created_at_epoch')) {
      const all = statement.all.bind(statement);
      statement.all = (...args: any[]) => {
        plans.push((prepare as any)(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
        return all(...args);
      };
    }
    return statement;
  };
  expect(store.getTimelineAroundObservation(anchor, 2000, 0, 0).observations.map(row => row.id))
    .toEqual([tiedBefore, anchor]);
  expect(store.getTimelineAroundObservation(anchor, 2000, 2, 0).observations.map(row => row.id))
    .toEqual([older, tiedBefore, anchor]);
  expect(store.getTimelineAroundObservation(anchor, 2000, 0, 1).observations.map(row => row.id))
    .toEqual([tiedBefore, anchor, later]);
  expect(plans).toHaveLength(6);
  for (const plan of plans) {
    expect(plan.some(row => row.detail.includes('idx_observations_created'))).toBe(true);
    expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
  }
});
