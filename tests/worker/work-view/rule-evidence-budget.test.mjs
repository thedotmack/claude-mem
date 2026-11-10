import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, ruleIdForPreference, ruleRowFields } from '../../../src/services/work-view/my-rules.mjs';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';

const preference = 'Keep the supporting evidence.';
const quotes = [1, 2, 3].map((index) => ({
  at: '2026-11-09T10:00:00Z', quote: String(index).repeat(200), kind: 'directive',
}));
const rule = {
  ruleId: ruleIdForPreference(preference), scopeTier: 'everywhere', scopeName: 'Everywhere',
  when: '', then: preference, setBy: 'approved', status: 'on', source: 'request-progress',
  timesSeen: 3, latestAt: '2026-11-09T10:00:00Z', quotes, replacedBy: null, replacedAt: null,
};
const ledger = { story: { preferences: [{ preference, quotes, kind: 'directive' }] } };
// Both fields fit the public API limits; JSON escaping is part of the row budget.
const partial = { when: 'x'.repeat(100), then: '"'.repeat(600) };
const full = { when: '"'.repeat(175), then: '"'.repeat(600) };
const readRows = (rows, story = null) => buildRules(reduceWorkState(rows.map((fields, index) => ({
  id: index + 1, project: 'home', list_name: 'my-rules', fields, created_at_epoch: index + 1,
}))), story).rules[0];
const read = (fields, story = null) => readRows([fields], story);

test('a row records omitted evidence within the same 2000-character budget', () => {
  const fields = ruleRowFields({ ...rule, ...partial });
  assert.ok(JSON.stringify(fields).length <= 2000);
  assert.equal(fields.quotes_total, 3);
  const saved = read(fields);
  assert.equal(saved.quotes.length, 1);
  assert.equal(saved.quotesOmitted, 2);
  assert.equal(saved.quotesTotal, 3);
});

test('a device without the story keeps the omission count when saving the surviving quotes again', () => {
  const first = read(ruleRowFields({ ...rule, ...partial }));
  const next = read(ruleRowFields({ ...first, then: 'Shorter rule.', status: 'off' }));
  assert.equal(next.quotes.length, 1);
  assert.equal(next.quotesOmitted, 2);
});

test('a partial save uses the available story evidence and a shorter save restores every quote', () => {
  const fields = ruleRowFields({ ...rule, ...partial });
  const local = read(fields, ledger);
  assert.deepEqual(local.quotes, quotes);
  assert.equal(local.quotesOmitted, 2);

  const complete = ruleRowFields({ ...local, then: 'Shorter rule.' });
  assert.equal(complete.quotes_total, undefined);
  const restored = readRows([fields, complete]);
  assert.deepEqual(restored.quotes, quotes);
  assert.equal(restored.quotesOmitted, 0);
});

test('a partial save retains its quotes when the local story has no additional evidence', () => {
  const fields = ruleRowFields({ ...rule, ...partial });
  const limitedStory = { story: { preferences: [{ preference, quotes: [quotes[2]] }] } };
  const local = read(fields, limitedStory);
  assert.deepEqual(local.quotes, [quotes[0]]);
  assert.equal(local.quotesOmitted, 2);
});

test('complete and legacy saves keep their own quotes even when the story contains more', () => {
  const fields = ruleRowFields({ ...rule, quotes: [quotes[2]] });
  assert.equal(fields.quotes_total, undefined);
  assert.deepEqual(read(fields, ledger).quotes, [quotes[2]]);
  assert.deepEqual(read({ ...fields, quotes_total: 1 }, ledger).quotes, [quotes[2]]);
});

test('dropping every saved quote keeps the local-story fallback and still reports the loss in the row', () => {
  const fields = ruleRowFields({ ...rule, ...full });
  assert.equal(fields.quotes, '');
  assert.ok(JSON.stringify(fields).length <= 2000);
  const local = read(fields, ledger);
  assert.equal(local.quotes.length, 3);
  assert.equal(local.quotesOmitted, 3);
  const remote = read(fields);
  assert.equal(remote.quotes.length, 0);
  assert.equal(remote.quotesOmitted, 3);
  // A shorter save can carry the recovered local evidence in full.
  const complete = ruleRowFields({ ...local, then: 'Shorter rule.' });
  assert.equal(complete.quotes_total, undefined);
  // The reducer retains the previous total when a later complete row omits that field.
  const restored = readRows([fields, complete]);
  assert.equal(restored.quotes.length, 3);
  assert.equal(restored.quotesTotal, 3);
  assert.equal(restored.quotesOmitted, 0);
});

test('complete saves and owner-written rules have no omitted evidence', () => {
  const complete = ruleRowFields(rule);
  assert.equal(read(complete).quotesOmitted ?? 0, 0);
  assert.equal(complete.quotes_total, undefined);
  const own = ruleRowFields({ ...rule, setBy: 'owner', source: 'you', quotes: [] });
  assert.equal(read(own).quotesOmitted ?? 0, 0);
  assert.equal(own.quotes_total, undefined);
});

test('legacy rows keep their evidence fallback without inventing an omission count', () => {
  const fields = { ...ruleRowFields(rule), quotes: '' };
  delete fields.quotes_total;
  const legacy = read(fields, ledger);
  assert.equal(legacy.quotes.length, 3);
  assert.equal(legacy.quotesOmitted ?? 0, 0);
});

test('the saved count follows nonempty story quotes through newline normalization and the three-quote cap', () => {
  const story = { source: 'hosted-intent', preferences: [{ preference, quotes: [
    { quote: '' }, { quote: ' \n ' }, { quote: 'first line\nsecond line' },
    { quote: 'second quote' }, { quote: 'third quote' }, { quote: 'fourth quote' },
  ] }] };
  const suggestion = buildRules({ lists: [] }, { story }).rules[0];
  assert.equal(suggestion.quotes.length, 4);
  const saved = read(ruleRowFields({ ...suggestion, setBy: 'approved', status: 'on' }));
  assert.equal(saved.quotesTotal, 4);
  assert.equal(saved.quotes.length, 3);
  assert.equal(saved.quotes[0].quote, 'first line second line');
  assert.equal(saved.quotesOmitted, 1);
});
