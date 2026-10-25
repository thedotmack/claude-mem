import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OwnerRule } from '../data-rules.ts'
import { currentRuleDecisions, ruleUndoIsCurrent, ruleVersion } from './rule-actions.ts'

const rule: OwnerRule = {
  id: 'rule', scopeId: 'everywhere', setBy: 'approved', when: '', then: 'Use real data.', quotes: [],
  timesSeen: 2, latestAt: 'Today', latestDaysAgo: 0, source: 'request-progress', status: 'on', records: [],
}

describe('local rule receipts', () => {
  it('keeps an approval only while its authoritative saved version agrees', () => {
    const saved = { rule: { decision: 'approved' as const, version: ruleVersion(rule)! } }
    assert.deepEqual(currentRuleDecisions([rule], saved), { rule: 'approved' })
    for (const change of [{ status: 'suggested' as const }, { status: 'off' as const }, { then: 'A newer edit.' }, { setBy: 'learned' as const }]) {
      assert.deepEqual(currentRuleDecisions([{ ...rule, ...change }], saved), {})
    }
    assert.deepEqual(currentRuleDecisions([], saved), {})
  })

  it('keeps a rejection only while the rule is still dismissed', () => {
    const dismissed = { ...rule, setBy: 'learned' as const, status: 'dismissed' as const }
    const saved = { rule: { decision: 'rejected' as const, version: ruleVersion(dismissed)! } }
    assert.deepEqual(currentRuleDecisions([dismissed], saved), { rule: 'rejected' })
    assert.deepEqual(currentRuleDecisions([{ ...dismissed, status: 'suggested' }], saved), {})
  })

  it('refuses undo after a newer edit, replacement, or deletion without expiring on the clock', () => {
    const version = ruleVersion(rule)
    assert.equal(ruleUndoIsCurrent(rule.id, version, [rule]), true)
    assert.equal(ruleUndoIsCurrent(rule.id, version, [{ ...rule, latestDaysAgo: 1, latestAt: 'Yesterday' }]), true)
    assert.equal(ruleUndoIsCurrent(rule.id, version, [{ ...rule, then: 'Newer instructions.' }]), false)
    assert.equal(ruleUndoIsCurrent(rule.id, version, [{ ...rule, status: 'replaced', replacedBy: { ruleId: 'new-rule', at: 'Today' } }]), false)
    assert.equal(ruleUndoIsCurrent(rule.id, version, []), false)
    assert.equal(ruleUndoIsCurrent(rule.id, null, []), false)
  })
})
