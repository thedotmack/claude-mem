import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SAMPLE_REQUESTS, type FocusArea, type Request } from '../data.ts'
import { focusOverview } from './focus-overview.ts'
import { FILTER_MATCHES } from './work-filters.ts'

const area = (id: string, fields: Partial<FocusArea> = {}): FocusArea => ({
  id, name: id, goal: null, status: 'kept', ownerRank: null, priorityRank: null, source: 'owner',
  mergedInto: null, evidence: null, timesAsked: null, latestAt: null, quotes: [], asks: [], ...fields,
})
const request = (id: string, focusAreaId?: string, fields: Partial<Request> = {}): Request => ({
  ...SAMPLE_REQUESTS[0], id, title: 'Viewer', focusAreaId, state: 'idle', ...fields,
})

test('overview preserves owner priority and separates suggestions from kept areas', () => {
  const areas = [area('second', { ownerRank: 2 }), area('suggested', { status: 'suggested', priorityRank: 1 }),
    area('first', { ownerRank: 1, priorityRank: 9 }), area('unranked', { priorityRank: 2 }),
    area('done', { status: 'done' }), area('dismissed', { status: 'dismissed' }), area('merged', { mergedInto: 'first' })]
  const overview = focusOverview(areas, [])
  assert.deepEqual(overview.areas.map((row) => row.area.id), ['first', 'second', 'unranked'])
  assert.deepEqual(overview.suggested.map((row) => row.area.id), ['suggested'])
  assert.equal(overview.areas[0].area, areas[2], 'recorded area and its evidence stay intact')
  assert.deepEqual(areas.map((entry) => entry.id), ['second', 'suggested', 'first', 'unranked', 'done', 'dismissed', 'merged'])
})

test('membership follows merge chains; unknown, dismissed and cyclic placements stay sorting', () => {
  const areas = [area('old', { mergedInto: 'middle' }), area('middle', { mergedInto: 'live' }), area('live'),
    area('dismissed', { status: 'dismissed' }), area('loop-a', { mergedInto: 'loop-b' }), area('loop-b', { mergedInto: 'loop-a' })]
  const overview = focusOverview(areas, [request('merged', 'old'), request('explicit', 'other'), request('absent'),
    request('unknown', 'missing'), request('dismissed', 'dismissed'), request('cycle', 'loop-a')])
  assert.deepEqual(overview.areas[0].requests.map((entry) => entry.id), ['merged'])
  assert.deepEqual(overview.other.map((entry) => entry.id), ['explicit'])
  assert.deepEqual(overview.sorting.map((entry) => entry.id), ['absent', 'unknown', 'dismissed', 'cycle'])
})

test('state counts leave out checked and closed work, include both kinds of human attention and preserve all membership', () => {
  const requests = [request('decision', 'live', { state: 'your-move' }), request('review', 'live', { state: 'needs-check' }),
    request('running', 'live', { state: 'working' }), request('shipped', 'live', { state: 'shipped' }),
    request('checked', 'live', { state: 'checked' }), request('closed', 'live', { state: 'closed' })]
  const [row] = focusOverview([area('live')], requests).areas
  assert.equal(row.requests.length, 6)
  assert.deepEqual([row.needsYou, row.working, row.shipped], [2, 1, 1])
})

test('requests with matching titles remain unsorted and done work does not become unassigned', () => {
  const overview = focusOverview([area('viewer', { name: 'Viewer' }), area('done', { status: 'done' })],
    [request('unplaced'), request('done-work', 'done')])
  assert.deepEqual(overview.areas[0].requests, [])
  assert.deepEqual(overview.sorting.map((entry) => entry.id), ['unplaced'])
  assert.deepEqual(overview.other, [])
})

test('a focus card counts and points at only what the page\'s filter shows: Open work leaves Done out, Done shows only it', () => {
  const requests = [request('decision', 'live', { state: 'your-move', next: { who: 'human', need: 'answer', text: 'Pick one' } }),
    request('running', 'live', { state: 'working' }), request('shipped', 'live', { state: 'shipped' }),
    request('checked', 'live', { state: 'checked' }), request('closed', 'live', { state: 'closed' }),
    request('loose-done', 'other', { state: 'shipped' }), request('unsorted-done', undefined, { state: 'checked' })]
  const open = focusOverview([area('live')], requests, FILTER_MATCHES.open)
  assert.deepEqual(open.areas[0].shown.map((entry) => entry.id), ['decision', 'running'])
  assert.deepEqual([open.areas[0].needsYou, open.areas[0].working, open.areas[0].next?.id], [1, 1, 'decision'])
  assert.equal(open.areas[0].requests.length, 5, 'the focus still opens onto every request placed in it')
  assert.deepEqual([open.other, open.sorting], [[], []])
  const done = focusOverview([area('live')], requests, FILTER_MATCHES.done)
  assert.deepEqual(done.areas[0].shown.map((entry) => entry.id), ['shipped', 'checked', 'closed'])
  assert.deepEqual([done.areas[0].needsYou, done.areas[0].working, done.areas[0].next], [0, 0, null])
  assert.deepEqual([done.other.map((entry) => entry.id), done.sorting.map((entry) => entry.id)], [['loose-done'], ['unsorted-done']])
  const working = focusOverview([area('live')], requests, FILTER_MATCHES.working)
  assert.deepEqual([working.areas[0].shown.map((entry) => entry.id), working.areas[0].next?.id], [['running'], 'running'])
})

test('with no filter, as in setup, a card counts everything that is not closed', () => {
  const [row] = focusOverview([area('live')], [request('shipped', 'live', { state: 'shipped' }), request('closed', 'live', { state: 'closed' })]).areas
  assert.deepEqual(row.shown.map((entry) => entry.id), ['shipped'])
})

test('a focus card\'s picture is the focus\'s own icon, and a focus without one has no picture at all', () => {
  const overview = focusOverview([area('drawn', { ownerRank: 1, icon: 'a1b2c3d4e5f6' }), area('uploaded', { ownerRank: 2, icon: 'data:image/png;base64,AAAA' }), area('plain', { ownerRank: 3 }),
    area('suggested-plain', { status: 'suggested' })], [])
  assert.deepEqual(overview.areas.map((row) => row.iconSrc), ['/api/work-view/focus-icon/drawn?v=a1b2c3d4e5f6', 'data:image/png;base64,AAAA', null])
  assert.equal(overview.suggested[0].iconSrc, null)
})
