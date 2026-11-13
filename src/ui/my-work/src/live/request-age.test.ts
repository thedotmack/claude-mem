// Run with `npm test`. The age a thread row shows (components/thread-list.tsx AskedAge).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AGE_SENTENCE, AGE_UNITS, ageSentence, requestAge } from './request-age.ts'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const ago = (ms: number) => requestAge(new Date(NOW - ms).toISOString(), NOW)
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const short = (ms: number) => ago(ms)?.short

describe('how long ago a request was asked', () => {
  it('counts minutes, hours and days, from "now" under a minute', () => {
    assert.deepEqual([0, 59_000, MINUTE, 5 * MINUTE, 59 * MINUTE + 59_000].map(short), ['now', 'now', '1m', '5m', '59m'])
    assert.deepEqual([HOUR, 3 * HOUR + 40 * MINUTE, 23 * HOUR + 59 * MINUTE].map(short), ['1h', '3h', '23h'])
    assert.deepEqual([DAY, 2 * DAY + 5 * HOUR, 13 * DAY + 23 * HOUR].map(short), ['1d', '2d', '13d'])
  })
  it('counts weeks from 14 days and months from two months on', () => {
    assert.deepEqual([14 * DAY, 20 * DAY, 21 * DAY, 60 * DAY].map(short), ['2w', '2w', '3w', '8w'])
    assert.deepEqual([61 * DAY, 92 * DAY, 400 * DAY].map(short), ['2mo', '3mo', '13mo'])
  })
  it('shows nothing when the start is not recorded or cannot be read, and "now" for a start ahead of this clock', () => {
    assert.equal(requestAge(undefined, NOW), null)
    assert.equal(requestAge('', NOW), null)
    assert.equal(requestAge('Start not recorded', NOW), null)
    assert.equal(short(-5 * MINUTE), 'now')
  })
  it('says the age in words, one and many, for every unit', () => {
    assert.equal(ageSentence(ago(5 * MINUTE)!), 'Asked {count} minutes ago')
    assert.equal(ageSentence(ago(MINUTE)!), 'Asked 1 minute ago')
    assert.equal(ageSentence(ago(14 * DAY)!), 'Asked {count} weeks ago')
    assert.equal(ageSentence(ago(10_000)!), 'Asked just now')
    assert.deepEqual(Object.keys(AGE_SENTENCE), [...AGE_UNITS])
  })
})
