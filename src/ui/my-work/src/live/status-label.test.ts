// Run with `npm test`. The words every status dot shows on hover, on focus and to a screen reader.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ATTENTION_ORDER, HUMAN_NEEDS, type Request } from '../data.ts'
import { COUNT_BUCKETS, countBucket, NEED_LABEL, STATE_LABEL, statusCounts, statusLabel, statusTone } from './status-label.ts'

type Shown = Pick<Request, 'state' | 'next'>
const agent = (state: Request['state']): Shown => ({ state, next: { who: 'bot', text: '' } })
const person = (state: Request['state'], need: (typeof HUMAN_NEEDS)[number]): Shown => ({ state, next: { who: 'human', need, text: 'x' } })

describe('statusLabel', () => {
  it('says what a person owes, by need', () => {
    assert.equal(statusLabel(person('needs-check', 'review')), 'Needs you · review')
    assert.equal(statusLabel(person('your-move', 'answer')), 'Needs you · answer')
    assert.equal(statusLabel(person('your-move', 'approval')), 'Needs you · approval')
    assert.equal(statusLabel(person('shipped', 'approval')), 'Needs you · approval')
  })

  it('names where the request stands when it waits on nobody', () => {
    assert.deepEqual((['working', 'idle', 'checked', 'closed', 'shipped'] as const).map((state) => statusLabel(agent(state))), ['Working', 'Idle', 'Checked', 'Closed', 'Shipped'])
  })

  it('colours a status as its state, and a shipped request that still owes a move as that move', () => {
    for (const state of ATTENTION_ORDER) assert.equal(statusTone(agent(state)), state)
    assert.equal(statusTone(person('shipped', 'approval')), 'your-move')
    assert.equal(statusTone(person('needs-check', 'review')), 'needs-check')
  })

  it('gives the status column words for every state a row can be in, alone or with what a person owes', () => {
    for (const state of ATTENTION_ORDER) {
      assert.equal(statusLabel(agent(state)), STATE_LABEL[state])
      for (const need of HUMAN_NEEDS) assert.equal(statusLabel(person(state, need)), `Needs you · ${NEED_LABEL[need]}`)
    }
  })

  it('has words for every state and every need, and passes each through the translator', () => {
    for (const state of ATTENTION_ORDER) assert.ok(STATE_LABEL[state], state)
    for (const need of HUMAN_NEEDS) assert.ok(NEED_LABEL[need], need)
    const words: Record<string, string> = { Checked: 'Geprüft', 'Needs you · {need}': 'Braucht dich · {need}', answer: 'Antwort' }
    const translate = (text: string) => words[text] ?? text
    assert.equal(statusLabel(agent('checked'), translate), 'Geprüft')
    assert.equal(statusLabel(person('your-move', 'answer'), translate), 'Braucht dich · Antwort')
  })
})

describe('statusCounts', () => {
  const requests = [person('your-move', 'answer'), person('your-move', 'approval'), person('your-move', 'answer'), person('needs-check', 'review'),
    agent('working'), agent('idle'), agent('idle'), agent('shipped'), agent('checked'), agent('closed')]

  it('counts each open state and everything that rests as one Done, in order, with the words its dot shows', () => {
    assert.deepEqual(statusCounts(requests).map((entry) => [entry.bucket, entry.label]), [
      ['your-move', '3 need you'], ['needs-check', '1 done, not checked'], ['working', '1 working'], ['idle', '2 idle'], ['done', '3 done'],
    ])
  })

  it('leaves out an empty count and says one thread in the singular', () => {
    assert.deepEqual(statusCounts([person('your-move', 'answer'), agent('checked')]).map((entry) => entry.label), ['1 needs you', '1 done'])
    assert.deepEqual(statusCounts([]), [])
  })

  it('counts every request exactly once, and a shipped request that still owes a move as the person\'s', () => {
    const everyShape = [...ATTENTION_ORDER.map(agent), ...ATTENTION_ORDER.flatMap((state) => HUMAN_NEEDS.map((need) => person(state, need)))]
    assert.equal(statusCounts(everyShape).reduce((sum, entry) => sum + entry.count, 0), everyShape.length)
    for (const shape of everyShape) assert.ok(COUNT_BUCKETS.includes(countBucket(shape)))
    assert.equal(countBucket(person('shipped', 'approval')), 'your-move')
    assert.equal(countBucket(agent('shipped')), 'done')
  })
})
