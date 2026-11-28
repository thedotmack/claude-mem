import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SAMPLE_REQUESTS, type Request } from '../data.ts'
import { byNewestReview, homeWork } from './home-lead.ts'

const request = (id: string, fields: Partial<Request> = {}): Request => ({ ...SAMPLE_REQUESTS[0], id, state: 'idle', closed: false, ...fields })
/** A request reviewed at `reviewedAtIso` (or never, with no recorded review time) that started at `startedAtIso`. */
const working = (id: string, reviewedAtIso: string | undefined, startedAtIso = '2026-11-01T10:00:00.000Z') => request(id, {
  state: 'working', startedAtIso,
  // The sample's progress carries words only, no review instant (data.ts).
  progress: { ...SAMPLE_REQUESTS[0].progress, ...(reviewedAtIso ? { reviewedAtIso } : {}) },
})

test('with nothing waiting, the working request with the newest review leads, whatever order they come in', () => {
  const older = working('older', '2026-11-27T09:00:00.000Z', '2026-11-27T08:00:00.000Z')
  const newest = working('newest', '2026-11-28T05:48:00.000Z', '2026-10-01T08:00:00.000Z')
  const unreviewed = working('unreviewed', undefined, '2026-11-28T06:00:00.000Z')
  for (const order of [[older, newest, unreviewed], [unreviewed, older, newest], [newest, unreviewed, older]]) {
    const home = homeWork([request('idle'), request('shipped', { state: 'shipped' }), ...order])
    assert.deepEqual(home.lead, { kind: 'working', request: newest }, 'the newest review leads, not the newest start')
    assert.deepEqual(home.working.map((entry) => entry.id), ['newest', 'older', 'unreviewed'], 'a request with no review time comes last')
    assert.deepEqual(home.waiting, [])
  }
})

test('a request waiting on the owner leads over every working one, in the boards\' attention order', () => {
  const check = request('check', { state: 'needs-check', startedAtIso: '2026-11-28T09:00:00.000Z' })
  const move = request('move', { state: 'your-move', startedAtIso: '2026-11-20T09:00:00.000Z' })
  const newerMove = request('newer-move', { state: 'your-move', startedAtIso: '2026-11-27T09:00:00.000Z' })
  const home = homeWork([working('busy', '2026-11-28T05:48:00.000Z'), check, move, newerMove])
  // Your move before done-and-waiting-for-a-check, the newest first within each (data.ts byAttention).
  assert.deepEqual(home.waiting.map((entry) => entry.id), ['newer-move', 'move', 'check'])
  assert.deepEqual(home.lead, { kind: 'waiting', request: newerMove })
  assert.deepEqual(home.working.map((entry) => entry.id), ['busy'])
})

test('closed requests never count or lead; with nothing waiting or working there is no lead', () => {
  const home = homeWork([request('closed-move', { state: 'your-move', closed: true }), working('closed-work', '2026-11-28T05:48:00.000Z'), request('idle')]
    .map((entry) => entry.id === 'closed-work' ? { ...entry, closed: true } : entry))
  assert.deepEqual(home, { waiting: [], working: [], lead: null })
  assert.deepEqual(homeWork([]), { waiting: [], working: [], lead: null })
})

test('two working requests reviewed at the same instant, or neither reviewed, put the newest start first', () => {
  const at = '2026-11-28T05:48:00.000Z'
  assert.ok(byNewestReview(working('a', at, '2026-11-02T00:00:00.000Z'), working('b', at, '2026-11-01T00:00:00.000Z')) < 0)
  assert.ok(byNewestReview(working('a', undefined, '2026-11-01T00:00:00.000Z'), working('b', undefined, '2026-11-02T00:00:00.000Z')) > 0)
  // A review time that is not a time counts as none.
  assert.ok(byNewestReview(working('reviewed', at), working('garbled', 'not a time')) < 0)
})
