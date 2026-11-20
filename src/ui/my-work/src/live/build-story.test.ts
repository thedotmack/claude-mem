import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request } from '../data.ts'
import { datedHeading, fitLine, RECAP_LINE_MAX_CHARACTERS, storyChapters, storyHeadingInReaderClock, storyHeadingInstant, storyNumbers } from './build-story.ts'

test('a story from 16.0.0 carries its chapters; an older one is read by where its sentences end', () => {
  const chapters = [{ heading: 'Velocity', paragraphs: ['First part.'] }]
  assert.equal(storyChapters({ paragraphs: ['ignored'], chapters }), chapters)
  // The shape the 15.19.0 worker sends: heading marks gone, headings are the lines that end no sentence.
  const paragraphs = ['Shipping continued through Nov 6.', 'Nov 9-10: ponytail test-suite review', 'Tests ran (17/17 green).', 'What the record teaches', 'Verify registries.']
  assert.deepEqual(storyChapters({ paragraphs }), [
    { heading: null, paragraphs: ['Shipping continued through Nov 6.'] },
    { heading: 'Nov 9-10: ponytail test-suite review', paragraphs: ['Tests ran (17/17 green).'] },
    { heading: 'What the record teaches', paragraphs: ['Verify registries.'] },
  ])
})

test('a heading that starts with a date splits into the date and what happened', () => {
  assert.deepEqual(datedHeading('Nov 9-10: ponytail test-suite review'), { date: 'Nov 9-10', title: 'ponytail test-suite review' })
  assert.deepEqual(datedHeading('Oct 5-Nov 9: gateway, My Work, gallery'), { date: 'Oct 5-Nov 9', title: 'gateway, My Work, gallery' })
  assert.deepEqual(datedHeading('Nov 9 10:07: v15.13.0 release image'), { date: 'Nov 9 10:07', title: 'v15.13.0 release image' })
  assert.deepEqual(datedHeading('Nov 15: marmalade probes'), { date: 'Nov 15', title: 'marmalade probes' })
  assert.deepEqual(datedHeading('What the record teaches'), { date: null, title: 'What the record teaches' })
})

test('the numbers count waiting on you and still open, never closed requests; shipped is left out, the story has no period', () => {
  const request = (state: Request['state'], closed = false) => ({ state, closed: closed || undefined }) as Request
  const requests = [request('shipped'), request('shipped'), request('your-move'), request('needs-check'), request('working'), request('idle'), request('idle', true)]
  // "Shipped within the story's period" cannot be derived (the story carries no period), so no shipped number is made up.
  assert.deepEqual(storyNumbers(requests), { waiting: 2, stillOpen: 2 })
})

test('a recap line is at most 75 characters, cut at a word with an ellipsis', () => {
  assert.equal(fitLine('short line'), 'short line')
  const long = 'The owner asked to finish the release, then a Fable review of every page and component in the app'
  const fitted = fitLine(long)
  assert.ok(fitted.length <= RECAP_LINE_MAX_CHARACTERS, `${fitted.length} characters`)
  assert.ok(fitted.endsWith('…'))
  assert.ok(long.startsWith(fitted.slice(0, -1)))
})

// A heading's day and time are UTC by contract (plugin/skills/request-progress/SKILL.md, step 4); the page shows them in
// the reader's own zone. A fixed zone here, so the tests read the same on every machine.
const LOS_ANGELES = 'America/Los_Angeles'
const iso = (epoch: number | null) => (epoch === null ? null : new Date(epoch).toISOString())

test('a dated heading’s UTC day and time read in the reader’s own date and clock (Los Angeles here)', () => {
  // The 15.19.0 story's "Nov 17 01:13" is 01:13 UTC: 5:13 pm the day before in Los Angeles, before the 6:12 pm writing.
  assert.equal(storyHeadingInReaderClock('Nov 17 01:13', '2026-11-17T02:12:00Z', 0, LOS_ANGELES), 'Nov 16, 5:13 pm')
  assert.equal(storyHeadingInReaderClock('Nov 16 13:20', '2026-11-17T02:12:00Z', 0, LOS_ANGELES), 'Nov 16, 5:20 am')
  assert.equal(storyHeadingInReaderClock('Nov 16 08:00', '2026-11-17T02:12:00Z', 0, LOS_ANGELES), 'Nov 16, 12:00 am')
  // The zone's own rules, not a fixed offset: in July Los Angeles is 7 hours behind UTC.
  assert.equal(storyHeadingInReaderClock('Jul 4 01:13', '2026-07-05T00:00:00Z', 0, LOS_ANGELES), 'Jul 3, 6:13 pm')
  // With no writing time (a worker before 16.0.0 sends none), the page's own time dates it.
  assert.equal(storyHeadingInReaderClock('Nov 17 01:13', undefined, Date.parse('2026-11-17T02:50:00Z'), LOS_ANGELES), 'Nov 16, 5:13 pm')
})

test('a heading’s year is the latest that puts it at or before the story’s writing, across a new year too', () => {
  const written = Date.parse('2027-01-01T08:00:00Z')
  // A December heading in a January story is last year's.
  assert.equal(iso(storyHeadingInstant('Dec 31 23:30', written)), '2026-12-31T23:30:00.000Z')
  assert.equal(iso(storyHeadingInstant('Jan 1 06:00', written)), '2027-01-01T06:00:00.000Z')
  // A heading later than the writing is the year before's.
  assert.equal(iso(storyHeadingInstant('Jan 1 09:00', written)), '2026-01-01T09:00:00.000Z')
  // In the reader's clock, 06:00 UTC on Jan 1 is still Dec 31 in Los Angeles.
  assert.equal(storyHeadingInReaderClock('Jan 1 06:00', '2027-01-01T08:00:00Z', 0, LOS_ANGELES), 'Dec 31, 10:00 pm')
  // A day that year does not have is not a time to convert.
  assert.equal(storyHeadingInstant('Feb 29 10:00', Date.parse('2027-03-05T00:00:00Z')), null)
})

test('a heading with only a day, or a range of days, has no time to convert and stays as written', () => {
  for (const date of ['Nov 9-10', 'Nov 15', 'Oct 5-Nov 9', 'Nov 9-10 13:00']) {
    assert.equal(storyHeadingInReaderClock(date, '2026-11-17T02:12:00Z', 0, LOS_ANGELES), null, date)
  }
})
