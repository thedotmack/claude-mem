import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';

const entry = (id, project, list_name, created_at_epoch, extra = {}) => ({
  id, project, list_name, created_at_epoch, fields: { status: 'open' }, ...extra,
});

test('imported older rows do not move stale lists ahead of recent work', () => {
  const state = reduceWorkState([
    entry(1, 'repo', 'recent', 3000),
    entry(100, 'repo', 'imported', 1000, { origin_device_id: 'other', origin_local_id: '2' }),
    entry(2, 'second', 'middle', 2000),
  ]);
  assert.deepEqual(state.lists.map(list => list.name), ['recent', 'middle', 'imported']);
  assert.equal(state.projects.find(project => project.id === 'repo').lastUpdatedAt, new Date(3000).toISOString());
  assert.deepEqual(state.projects.map(project => project.id), ['repo', 'second']);
  assert.equal(state.revision, 100);
});

test('equal timestamps keep the existing stable row-id tie break', () => {
  const state = reduceWorkState([entry(1, 'repo', 'first', 1000), entry(2, 'repo', 'second', 1000)]);
  assert.deepEqual(state.lists.map(list => list.name), ['second', 'first']);
});
