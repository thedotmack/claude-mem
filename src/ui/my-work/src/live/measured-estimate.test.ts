// Run with `npm test` (node --test). The ETA needs two advancing readings and an unshipped request.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measuredEstimate } from './measured-estimate.ts'

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12)).toISOString()

test('two advancing readings project the finish at the measured pace', () => {
  // 40% → 60% over one day: 40% left takes two more days.
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 60 }], false), 'at this pace, about Oct 23')
})

test('only the last two readings count, whatever order they arrive in', () => {
  assert.equal(measuredEstimate([{ at: at(21), percent: 60 }, { at: at(10), percent: 0 }, { at: at(20), percent: 40 }], false), 'at this pace, about Oct 23')
})

test('no estimate from one reading, a flat or falling pace, a shipped request, or a bad date', () => {
  assert.equal(measuredEstimate([], false), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }], false), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 40 }], false), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 60 }, { at: at(21), percent: 40 }], false), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 60 }], true), null)
  assert.equal(measuredEstimate([{ at: 'not a date', percent: 40 }, { at: at(21), percent: 60 }], false), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 100 }], false), null)
})
