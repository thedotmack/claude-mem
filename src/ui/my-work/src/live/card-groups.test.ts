// Run with `npm test`. A focus's Cards view (components/request-cards.tsx) as one flat keyed list.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { CARD_GROUPS, cardGridEntries } from './card-groups.ts'
import { COUNT_BUCKETS } from './status-label.ts'
import { FILTER_MATCHES } from './work-filters.ts'

const request = (id: string, state: Request['state'], next: Request['next'] = { who: 'bot', text: '' }) => ({ id, state, next }) as Request

describe('cardGridEntries', () => {
  it('keeps a card the same keyed entry in one flat list when its request moves from Working to Needs you', () => {
    const before = cardGridEntries([request('a', 'working'), request('b', 'working')], {})
    const after = cardGridEntries([request('a', 'your-move', { who: 'human', need: 'answer', text: '' }), request('b', 'working')], {})
    // One flat list: no entry is itself a list, so React keys are not scoped per section.
    for (const entries of [before, after]) assert.ok(entries.every((entry) => !Array.isArray(entry)))
    assert.deepEqual(before.map((entry) => entry.key), ['heading-working', 'a', 'b'])
    assert.deepEqual(after.map((entry) => entry.key), ['heading-needs-you', 'a', 'heading-working', 'b'])
    const keys = after.map((entry) => entry.key)
    assert.equal(new Set(keys).size, keys.length, 'keys are unique across sections')
  })

  it('folds Idle after six and unfolds it on request', () => {
    const idle = Array.from({ length: 8 }, (_, index) => request(`i${index}`, 'idle'))
    const folded = cardGridEntries(idle, {})
    assert.equal(folded.filter((entry) => entry.kind === 'card').length, 6)
    assert.deepEqual(folded[0], { kind: 'heading', key: 'heading-idle', group: folded[0].kind === 'heading' ? folded[0].group : undefined, count: 8, folds: true, open: false })
    assert.equal(cardGridEntries(idle, { idle: true }).filter((entry) => entry.kind === 'card').length, 8)
  })

  it('files every request under exactly one section, with shipped, checked and closed work together under Done', () => {
    assert.deepEqual(CARD_GROUPS.flatMap((group) => group.buckets).sort(), [...COUNT_BUCKETS].sort())
    const entries = cardGridEntries([request('s', 'shipped'), request('c', 'checked'), request('x', 'closed'), request('n', 'needs-check'), request('i', 'idle')], {})
    assert.deepEqual(entries.map((entry) => entry.key), ['heading-needs-you', 'n', 'heading-idle', 'i', 'heading-done', 's', 'c', 'x'])
  })

  it('shows no Done card under Open work, the filter the page opens on, and only those under Done', () => {
    const requests = [request('w', 'working'), request('s', 'shipped'), request('c', 'checked'), request('x', 'closed')]
    assert.deepEqual(cardGridEntries(requests.filter(FILTER_MATCHES.open), {}).map((entry) => entry.key), ['heading-working', 'w'])
    assert.deepEqual(cardGridEntries(requests.filter(FILTER_MATCHES.done), {}).map((entry) => entry.key), ['heading-done', 's', 'c', 'x'])
  })
})
