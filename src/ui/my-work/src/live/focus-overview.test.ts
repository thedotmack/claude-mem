import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SAMPLE_REQUESTS, type FocusArea, type Request } from '../data.ts'
import { focusOverview } from './focus-overview.ts'

const area = (id: string, fields: Partial<FocusArea> = {}): FocusArea => ({
  id, name: id, goal: null, status: 'kept', ownerRank: null, priorityRank: null, source: 'owner',
  mergedInto: null, evidence: null, timesAsked: null, latestAt: null, quotes: [], asks: [], ...fields,
})
const request = (id: string, focusAreaId?: string, fields: Partial<Request> = {}): Request => ({
  ...SAMPLE_REQUESTS[0], id, title: 'Viewer', focusAreaId, state: 'idle', closed: false, ...fields,
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

test('state counts exclude closed work, include both kinds of human attention and preserve all membership', () => {
  const requests = [request('decision', 'live', { state: 'your-move' }), request('review', 'live', { state: 'needs-check' }),
    request('running', 'live', { state: 'working' }), request('shipped', 'live', { state: 'shipped' }),
    request('closed-review', 'live', { state: 'needs-check', closed: true }),
    request('closed-running', 'live', { state: 'working', closed: true }), request('closed-ship', 'live', { state: 'shipped', closed: true })]
  const [row] = focusOverview([area('live')], requests).areas
  assert.equal(row.requests.length, 7)
  assert.deepEqual([row.needsYou, row.working, row.shipped], [2, 1, 1])
})

test('requests with matching titles remain unsorted and done work does not become unassigned', () => {
  const overview = focusOverview([area('viewer', { name: 'Viewer' }), area('done', { status: 'done' })],
    [request('unplaced'), request('done-work', 'done')])
  assert.deepEqual(overview.areas[0].requests, [])
  assert.deepEqual(overview.sorting.map((entry) => entry.id), ['unplaced'])
  assert.deepEqual(overview.other, [])
})
