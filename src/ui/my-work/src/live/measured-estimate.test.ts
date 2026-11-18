// Run with `npm test` (node --test). The ETA needs two advancing readings, an unshipped request and a day still to come.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateDayIsPast, measuredEstimate } from './measured-estimate.ts'

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12)).toISOString()
/** The morning after the last reading these tests use (Oct 21): every estimate below is still to come. */
const NOW = Date.UTC(2026, 9, 22, 9)

test('two advancing readings project the finish at the measured pace', () => {
  // 40% → 60% over one day: 40% left takes two more days.
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 60 }], false, NOW), 'at this pace, about Oct 23')
})

test('only the last two readings count, whatever order they arrive in', () => {
  assert.equal(measuredEstimate([{ at: at(21), percent: 60 }, { at: at(10), percent: 0 }, { at: at(20), percent: 40 }], false, NOW), 'at this pace, about Oct 23')
})

test('no estimate from one reading, a flat or falling pace, a shipped request, or a bad date', () => {
  assert.equal(measuredEstimate([], false, NOW), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }], false, NOW), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 40 }], false, NOW), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 60 }, { at: at(21), percent: 40 }], false, NOW), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 60 }], true, NOW), null)
  assert.equal(measuredEstimate([{ at: 'not a date', percent: 40 }, { at: at(21), percent: 60 }], false, NOW), null)
  assert.equal(measuredEstimate([{ at: at(20), percent: 40 }, { at: at(21), percent: 100 }], false, NOW), null)
})

test('two reviews on the same day give no estimate: hours of pace read as a promise (c-bits-progress-meter)', () => {
  const morning = new Date(2026, 9, 21, 9, 0).toISOString()
  const afternoon = new Date(2026, 9, 21, 15, 0).toISOString()
  assert.equal(measuredEstimate([{ at: morning, percent: 20 }, { at: afternoon, percent: 60 }], false, NOW), null)
  // The same pace across two days gives an estimate.
  const nextMorning = new Date(2026, 9, 22, 9, 0).toISOString()
  assert.match(measuredEstimate([{ at: morning, percent: 20 }, { at: nextMorning, percent: 60 }], false, NOW) ?? '', /^at this pace, about /)
})

test('a finish day already behind today is left out, never shown as a date to come (c-bits-progress-meter)', () => {
  // The pace projects Oct 23; on Nov 16 that day has passed.
  const readings = [{ at: at(20), percent: 40 }, { at: at(21), percent: 60 }]
  assert.equal(measuredEstimate(readings, false, Date.UTC(2026, 10, 16, 12)), null)
  // On the finish day itself it still reads as today's estimate.
  assert.equal(measuredEstimate(readings, false, new Date(2026, 9, 23, 18).getTime()), 'at this pace, about Oct 23')
})

test('an estimate an older worker sent is read as past when its day has gone by, in the year nearest to today', () => {
  const nov16 = new Date(2026, 10, 16, 12).getTime()
  assert.equal(estimateDayIsPast('at this pace, about Oct 22', nov16), true)
  assert.equal(estimateDayIsPast('at this pace, about Nov 15', nov16), true)
  assert.equal(estimateDayIsPast('at this pace, about Nov 16', nov16), false, 'today is not past')
  assert.equal(estimateDayIsPast('at this pace, about Nov 20', nov16), false)
  // Across the new year: on Dec 20 an estimate of Jan 5 is next year's, and on Jan 3 one of Dec 28 was last year's.
  assert.equal(estimateDayIsPast('at this pace, about Jan 5', new Date(2026, 11, 20, 12).getTime()), false)
  assert.equal(estimateDayIsPast('at this pace, about Dec 28', new Date(2027, 0, 3, 12).getTime()), true)
  // Anything else is not an estimate it can date, so it is not called past.
  assert.equal(estimateDayIsPast('Ship date not recorded', nov16), false)
})

test('the screens leave out an estimate whose day has passed, as an older worker sends it (data.ts measuredEstimate)', async () => {
  const { SAMPLE_REQUESTS, measuredEstimate: shownEstimate } = await import('../data.ts')
  const request = { ...SAMPLE_REQUESTS[0], state: 'working' as const, progress: { ...SAMPLE_REQUESTS[0].progress, history: [40, 60], readings: 2, percent: 60 } }
  const nov16 = new Date(2026, 10, 16, 12).getTime()
  assert.equal(shownEstimate({ ...request, estimate: 'at this pace, about Oct 22' }, nov16), null)
  assert.equal(shownEstimate({ ...request, estimate: 'at this pace, about Nov 20' }, nov16), 'at this pace, about Nov 20')
})
