import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, ruleRowFields } from '../../../src/services/work-view/my-rules.mjs';

const ledger = { story: { preferences: [{ preference: 'Keep the explanation brief.', quotes: [{ quote: 'Please be brief.', at: '2026-10-18T10:00:00Z' }] }] } };
const suggested = () => buildRules({ lists: [] }, ledger).rules[0];
const savedState = fields => ({ lists: [{ name: 'my-rules', tasks: [{ name: fields.task, fields, updatedAtEpoch: 1, updatedAt: '2026-10-19T10:00:00Z' }] }] });

test('explicitly saved empty evidence does not resurrect the original suggestion quotes', () => {
  const fields = ruleRowFields({ ...suggested(), quotes: [], setBy: 'approved', status: 'on' });
  assert.equal(fields.quotes, '');
  assert.deepEqual(buildRules(savedState(fields), ledger).rules[0].quotes, []);
});

test('legacy saved rules without an evidence field retain suggestion evidence', () => {
  const fields = ruleRowFields(suggested());
  delete fields.quotes;
  assert.deepEqual(buildRules(savedState(fields), ledger).rules[0].quotes, suggested().quotes);
});

test('a saved replacement quote overrides the original evidence', () => {
  const fields = ruleRowFields({ ...suggested(), quotes: [{ quote: 'Use a short answer.', at: '2026-10-19T11:00:00Z' }] });
  assert.equal(buildRules(savedState(fields), ledger).rules[0].quotes[0].quote, 'Use a short answer.');
});

test('evidence removed to fit the saved-row budget stays removed after projection', () => {
  let fields;
  for (let length = 1200; length < 2000; length++) {
    try {
      const candidate = ruleRowFields({ ...suggested(), then: 'x'.repeat(length) });
      if (candidate.quotes === '') { fields = candidate; break; }
    } catch { break; }
  }
  assert.ok(fields, 'fixture must trigger the existing quote budget');
  assert.deepEqual(buildRules(savedState(fields), ledger).rules[0].quotes, []);
});
