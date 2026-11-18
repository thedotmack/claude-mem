import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OwnerRule } from '../data-rules.ts'
import { RULE_DECISIONS, type RuleDecision } from './rule-actions.ts'
import { currentIn, inShownOrder, keepShownOrder, stepFrom, upNextAfter } from './rule-queue.ts'

const [APPROVED, REJECTED] = RULE_DECISIONS
const rule = (id: string): OwnerRule => ({
  id, scopeId: 'everywhere', setBy: 'learned', when: '', then: `Rule ${id}.`, quotes: [],
  timesSeen: 1, latestAt: 'Today', latestDaysAgo: 0, source: 'request-progress', status: 'suggested', records: [],
})
const [a, b, c, d, z] = ['a', 'b', 'c', 'd', 'z'].map(rule)
const ids = (rules: readonly OwnerRule[] | readonly string[]) => rules.map((entry) => typeof entry === 'string' ? entry : entry.id)
const none: Record<string, RuleDecision> = {}

describe('the decision queue pointer (quality M1)', () => {
  it('starts on the first waiting rule in the order first drawn', () => {
    const order = keepShownOrder([], [a, b, c], null)
    assert.deepEqual(ids(order), ['a', 'b', 'c'])
    assert.equal(currentIn(order, [a, b, c], none, null), a)
  })

  it('keeps the card on the rule the person is reading when a stronger suggestion arrives; the new rule joins Up next', () => {
    const first = keepShownOrder([], [a, b, c], null)
    // The learning run lands z, which sorts strongest; the card shows a.
    const order = keepShownOrder(first, [z, a, b, c], 'a')
    assert.deepEqual(ids(order), ['a', 'z', 'b', 'c'])
    const shown = inShownOrder(order, [z, a, b, c])
    assert.equal(currentIn(order, shown, none, 'a'), a)
    assert.deepEqual(ids(upNextAfter(shown, none, a, 3)), ['z', 'b', 'c'])
  })

  it('a re-sort of the same rules never reorders the rows', () => {
    const first = keepShownOrder([], [a, b, c], null)
    assert.equal(keepShownOrder(first, [c, b, a], 'a'), first)
  })

  it('moves to the next waiting rule after a middle rule the person decides, not back to the first', () => {
    const order = keepShownOrder([], [a, b, c, d], null)
    assert.equal(currentIn(order, [a, b, c, d], { b: APPROVED }, 'b'), c)
    assert.equal(currentIn(order, [a, b, c, d], { b: REJECTED, c: APPROVED }, 'b'), d)
  })

  it('moves to the rule after the one decided on another computer, which has left the list', () => {
    const order = keepShownOrder([], [a, b, c, d], null)
    // b was approved elsewhere: it is no longer a suggestion, so the list no longer has it.
    const left = inShownOrder(order, [a, c, d])
    assert.equal(currentIn(order, left, none, 'b'), c)
  })

  it('wraps past the end to the first waiting rule, and has none when every rule is decided', () => {
    const order = keepShownOrder([], [a, b, c], null)
    assert.equal(currentIn(order, [a, b, c], { c: APPROVED }, 'c'), a)
    assert.equal(currentIn(order, [a, b, c], { a: APPROVED, b: REJECTED, c: APPROVED }, 'c'), null)
  })

  it('a strength filter shows the next waiting rule of that strength after the pointer', () => {
    const order = keepShownOrder([], [a, b, c, d], null)
    // The filter keeps only c and d; the pointer is on b, which it hides.
    assert.equal(currentIn(order, [c, d], none, 'b'), c)
    assert.equal(currentIn(order, [a, b], none, 'd'), a)
  })

  it('Previous and Next step over decided rules and wrap', () => {
    assert.equal(stepFrom([a, b, c], { b: APPROVED }, a, 1), c)
    assert.equal(stepFrom([a, b, c], none, a, -1), c)
    assert.equal(stepFrom([a], none, a, 1), null)
  })
})
