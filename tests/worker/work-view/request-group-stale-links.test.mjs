import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGroupDecisions, groupIdFor } from '../../../src/services/work-view/request-groups.mjs';

const key = id => JSON.stringify(['conversation', 'claude', id]);
const link = (...ids) => ({ kind: 'agent-judgment', conversations: ids.map(key), evidence: 'These conversations continue the same recorded request.' });
const first = () => applyGroupDecisions(null, { groups: [{
  title: 'Original request', conversations: ['a', 'b', 'c'].map(key), links: [link('a', 'b'), link('a', 'c')],
}] }, 1000);

test('moving a conversation removes its stale evidence from the previous group', () => {
  const stored = first();
  const moved = applyGroupDecisions(stored, { groups: [{
    title: 'Other request', conversations: ['d', 'b'].map(key), links: [link('d', 'b')],
  }] }, 2000);
  assert.deepEqual(moved.groups[groupIdFor(key('a'))].links, [link('a', 'c')]);
  assert.deepEqual(moved.groups[groupIdFor(key('d'))].links, [link('d', 'b')]);
  assert.equal(moved.conversations[key('b')], groupIdFor(key('d')));
  assert.equal(stored.groups[groupIdFor(key('a'))].links.length, 2);
});

test('ignoring a conversation removes its evidence while preserving remaining links', () => {
  const next = applyGroupDecisions(first(), { groups: [], ignored: [{ conversation: key('b'), reason: 'Not part of this request.' }] }, 2000);
  assert.deepEqual(next.groups[groupIdFor(key('a'))].links, [link('a', 'c')]);
  assert.equal(next.conversations[key('b')], undefined);
  assert.equal(next.ignored[key('b')], 'Not part of this request.');
});

test('a decision that keeps every member also keeps all recorded links', () => {
  const stored = first();
  const next = applyGroupDecisions(stored, { groups: [] }, 2000);
  assert.deepEqual(next.groups, stored.groups);
});
