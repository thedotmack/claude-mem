import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OwnerRule } from '../data-rules.ts'
import { addedRuleFromSave, currentRuleDecisions, ruleUndoIsCurrent, ruleVersion } from './rule-actions.ts'

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

  it('keeps the saved B receipt separate from a newer live C after editing A', () => {
    const savedB = { ...rule, then: 'Saved edit B.' }
    const currentC = { ...rule, then: 'Newer edit C.' }
    const receipt = { rule: { decision: 'approved' as const, version: ruleVersion(savedB)! } }
    assert.equal(ruleUndoIsCurrent(rule.id, receipt.rule.version, [savedB]), true)
    assert.equal(ruleUndoIsCurrent(rule.id, receipt.rule.version, [currentC]), false)
    assert.deepEqual(currentRuleDecisions([currentC], receipt), {})
  })

  it('identifies an added rule by the POST receipt, independent of newer live changes', () => {
    const added = { ...rule, id: 'new', setBy: 'owner' as const }
    const concurrent = { ...added, id: 'other' }
    const draft = { scopeTier: 'everywhere' as const, scopeName: 'Everywhere', when: '', then: rule.then }
    const savedModel = { rules: [rule, concurrent, added], ruleScopes: [{ id: 'everywhere', tier: 'everywhere' as const, name: 'Everywhere' }] }
    assert.equal(addedRuleFromSave(savedModel, [rule], draft, 'new'), added)
    // An old worker cannot tell two matching additions apart. No undo is safer than undoing the wrong rule.
    assert.equal(addedRuleFromSave(savedModel, [rule], draft), undefined)
    assert.equal(addedRuleFromSave({ ...savedModel, rules: [rule, added] }, [rule], draft), added)
    assert.equal(addedRuleFromSave(savedModel, [rule], draft, 'missing'), undefined)
  })

  it('requires the matching scope for the old-worker addition fallback', () => {
    const added = { ...rule, id: 'new', setBy: 'owner' as const, scopeId: 'project:one' }
    const other = { ...added, id: 'other', scopeId: 'project:two' }
    const saved = {
      rules: [other, added],
      ruleScopes: [{ id: 'project:one', tier: 'project' as const, name: 'One' }, { id: 'project:two', tier: 'project' as const, name: 'Two' }],
    }
    const draft = { scopeTier: 'project' as const, scopeName: 'One', when: '', then: rule.then }
    assert.equal(addedRuleFromSave(saved, [], draft), added)
  })
})
