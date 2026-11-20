import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SAMPLE_REQUESTS, type FocusArea } from '../data.ts'
import { focusNavActivity, focusNavAreas } from './focus-nav.ts'

const area = (id: string, fields: Partial<FocusArea> = {}): FocusArea => ({
  id, name: id, goal: null, status: 'kept', ownerRank: null, priorityRank: null, source: 'owner',
  mergedInto: null, evidence: null, timesAsked: null, latestAt: null, quotes: [], asks: [], ...fields,
})
const ids = (areas: readonly FocusArea[]) => areas.map((entry) => entry.id)

test('short focus navigation preserves owner order and excludes suggestions, finished and merged areas', () => {
  const areas = [area('fifth', { priorityRank: 5 }), area('second', { ownerRank: 2 }),
    area('first', { ownerRank: 1, priorityRank: 9 }), area('fourth', { priorityRank: 4 }), area('third', { priorityRank: 3 }),
    area('suggested', { status: 'suggested', ownerRank: 0 }), area('done', { status: 'done' }),
    area('dismissed', { status: 'dismissed' }), area('merged', { mergedInto: 'first' })]
  assert.deepEqual(ids(focusNavAreas(areas, null)), ['first', 'second', 'third', 'fourth'])
})

test('an off-list kept selection preserves the first three and replaces only the fourth slot', () => {
  const areas = Array.from({ length: 8 }, (_, index) => area(`area-${index + 1}`, { ownerRank: index + 1 }))
  assert.deepEqual(ids(focusNavAreas(areas, 'area-8')), ['area-1', 'area-2', 'area-3', 'area-8'])
  assert.deepEqual(ids(focusNavAreas(areas, 'area-2')), ['area-1', 'area-2', 'area-3', 'area-4'])
  assert.deepEqual(ids(focusNavAreas(areas, null)), ['area-1', 'area-2', 'area-3', 'area-4'])
})

test('Other, unknown and non-kept selections cannot displace a kept area; merges resolve to their live selection', () => {
  const areas = [area('first', { ownerRank: 1 }), area('second', { ownerRank: 2 }), area('third', { ownerRank: 3 }),
    area('fourth', { ownerRank: 4 }), area('fifth', { ownerRank: 5 }),
    area('suggested', { status: 'suggested' }), area('done', { status: 'done' }), area('old', { mergedInto: 'fifth' })]
  for (const selected of ['other', 'missing', 'suggested', 'done']) {
    assert.deepEqual(ids(focusNavAreas(areas, selected)), ['first', 'second', 'third', 'fourth'])
  }
  assert.deepEqual(ids(focusNavAreas(areas, 'old')), ['first', 'second', 'third', 'fifth'])
})

test('navigation limits no saved data and remains usable with fewer than four kept areas', () => {
  const areas = Array.from({ length: 30 }, (_, index) => area(`area-${30 - index}`, { ownerRank: 30 - index }))
  const original = ids(areas)
  const visible = focusNavAreas(areas, 'area-30')
  assert.equal(visible.length, 4)
  assert.deepEqual(ids(areas), original)
  assert.equal(areas.length, 30)
  assert.equal(visible[3], areas[0], 'the presentation preserves the original area record')
  assert.deepEqual(ids(focusNavAreas(areas.slice(-2), 'area-2')), ['area-1', 'area-2'])
  assert.deepEqual(focusNavAreas([], null), [])
})

test('navigation activity aggregates attention and movement once across merged, other and unsorted work', () => {
  const areas = [area('live'), area('old', { mergedInto: 'live' }), area('dismissed', { status: 'dismissed' })]
  const requests = [
    { ...SAMPLE_REQUESTS[0], id: 'review', focusAreaId: 'old', state: 'needs-check' as const },
    { ...SAMPLE_REQUESTS[0], id: 'move', focusAreaId: 'live', state: 'your-move' as const },
    { ...SAMPLE_REQUESTS[0], id: 'running', focusAreaId: 'old', state: 'working' as const },
    { ...SAMPLE_REQUESTS[0], id: 'other', focusAreaId: 'other', state: 'needs-check' as const },
    { ...SAMPLE_REQUESTS[0], id: 'closed', focusAreaId: 'other', state: 'working' as const, closed: true },
    { ...SAMPLE_REQUESTS[0], id: 'unknown', focusAreaId: 'missing', state: 'your-move' as const },
    { ...SAMPLE_REQUESTS[0], id: 'dismissed', focusAreaId: 'dismissed', state: 'your-move' as const },
  ]
  assert.deepEqual([...focusNavActivity(areas, requests)], [
    ['live', { count: 2, moving: true }],
    ['other', { count: 1, moving: false }],
  ])
})
