// Run with `npm test`. The Cards view's sections (pages/my-work.tsx CardsView) as one flat keyed list.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { cardGridEntries } from './card-groups.ts'

const request = (id: string, state: Request['state']) => ({ id, state }) as Request

describe('cardGridEntries', () => {
  it('keeps a card the same keyed entry in one flat list when its request moves from Working to Needs you', () => {
    const before = cardGridEntries([request('a', 'working'), request('b', 'working')], {})
    const after = cardGridEntries([request('a', 'your-move'), request('b', 'working')], {})
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
})
