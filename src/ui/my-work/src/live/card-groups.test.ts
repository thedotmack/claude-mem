// Run with `npm test`. The Cards view's sections (pages/my-work.tsx CardsView): card sections as one flat keyed list,
// one-line sections apart, sizes by state, and one-line rows 50 at a time (G4).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveState, Request } from '../data.ts'
import { CARD_GROUPS, CARD_SIZE, LINE_ROWS_PER_PAGE, cardGridEntries, linePage, lineSections } from './card-groups.ts'

const request = (id: string, state: Request['state']) => ({ id, state }) as Request

describe('cardGridEntries', () => {
  it('keeps a card the same keyed entry in one flat list when its request moves from Working to Needs you', () => {
    const before = cardGridEntries([request('a', 'working'), request('b', 'working')])
    const after = cardGridEntries([request('a', 'your-move'), request('b', 'working')])
    // One flat list: no entry is itself a list, so React keys are not scoped per section.
    for (const entries of [before, after]) assert.ok(entries.every((entry) => !Array.isArray(entry)))
    assert.deepEqual(before.map((entry) => entry.key), ['heading-working', 'a', 'b'])
    assert.deepEqual(after.map((entry) => entry.key), ['heading-needs-you', 'a', 'heading-working', 'b'])
    const keys = after.map((entry) => entry.key)
    assert.equal(new Set(keys).size, keys.length, 'keys are unique across sections')
  })

  it('draws no card for an idle or shipped request: those sections fold to one line each (G4)', () => {
    const requests = [request('n', 'your-move'), request('w', 'working'), request('i', 'idle'), request('s', 'shipped')]
    assert.deepEqual(cardGridEntries(requests).filter((entry) => entry.kind === 'card').map((entry) => entry.key), ['n', 'w'])
    assert.deepEqual(lineSections(requests).map(({ group, members }) => [group.id, members.map((member) => member.id)]), [['idle', ['i']], ['shipped', ['s']]])
    assert.deepEqual(lineSections([request('n', 'your-move')]), [], 'an empty section is left out')
  })
})

describe('card size by state', () => {
  it('draws each state at its CARD_SIZE: a card in the grid at that size, a line-sized state only as a folded row', () => {
    // Every state belongs to exactly one section, and each section has that state's size.
    const states = CARD_GROUPS.flatMap((group) => group.states)
    assert.deepEqual([...states].sort(), (Object.keys(CARD_SIZE) as LiveState[]).sort())
    for (const group of CARD_GROUPS) for (const state of group.states) assert.equal(group.size, CARD_SIZE[state])
    // The grid's card entries carry their state's size, so the board never restates the rule (L7).
    for (const state of Object.keys(CARD_SIZE) as LiveState[]) {
      const cards = cardGridEntries([request(state, state)]).filter((entry) => entry.kind === 'card')
      const rows = lineSections([request(state, state)]).flatMap((section) => section.members)
      if (CARD_SIZE[state] === 'line') assert.deepEqual([cards.length, rows.length], [0, 1], state)
      else assert.deepEqual(cards.map((entry) => entry.kind === 'card' && entry.size), [CARD_SIZE[state]], state)
    }
  })
})

describe('linePage', () => {
  it('shows 50 rows a page and says how many are left', () => {
    assert.equal(LINE_ROWS_PER_PAGE, 50)
    assert.deepEqual(linePage(118, 0), { shown: 0, left: 118 })
    assert.deepEqual(linePage(118, 1), { shown: 50, left: 68 })
    assert.deepEqual(linePage(118, 2), { shown: 100, left: 18 })
    assert.deepEqual(linePage(118, 3), { shown: 118, left: 0 })
    assert.deepEqual(linePage(12, 1), { shown: 12, left: 0 })
  })
})
