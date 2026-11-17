import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DURATION_WORD, durationIn } from './running-time.ts'

test('an idle request is never "running"; a shipped one says how long it took', () => {
  assert.equal(DURATION_WORD.idle, 'Open for')
  assert.equal(DURATION_WORD.shipped, 'Took')
  assert.equal(DURATION_WORD.working, 'Running')
})

test('a duration is a value in whole units, for each screen to word (never English text in the model)', () => {
  const minute = 60_000
  assert.deepEqual(durationIn(30_000), { unit: 'just-started', count: 0 })
  assert.deepEqual(durationIn(-5 * minute), { unit: 'just-started', count: 0 }, 'a clock that runs behind reads as just started')
  assert.deepEqual(durationIn(42 * minute), { unit: 'minutes', count: 42 })
  assert.deepEqual(durationIn(59 * minute), { unit: 'minutes', count: 59 })
  assert.deepEqual(durationIn(60 * minute), { unit: 'hours', count: 1 })
  assert.deepEqual(durationIn(23 * 60 * minute + 59 * minute), { unit: 'hours', count: 23 })
  assert.deepEqual(durationIn(24 * 60 * minute), { unit: 'days', count: 1 })
  assert.deepEqual(durationIn(41 * 24 * 60 * minute), { unit: 'days', count: 41 })
})
