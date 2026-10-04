import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let store: SessionStore;
afterEach(() => store?.close());

function seed(epoch: number) {
  return store.storeObservation('ordered-memory', 'ordered-project', {
    type: 'discovery', title: `observation-${epoch}`, subtitle: null,
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
