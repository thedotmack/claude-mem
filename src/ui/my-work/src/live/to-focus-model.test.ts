// My Focus from the snapshot (plan Phase 6): areas from the my-focus list, each request's placement, and the
// owner-goals words behind areas and asks. Copies to-goals-model.test.ts: the trimmed real fixture plus made-up rows.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { focusAreaLabel, resolveFocusAreaId, suggestionEditDecision } from './to-focus-model.ts'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewFocusArea, WorkViewGoalItem, WorkViewGoalList, WorkViewHumanRequest, WorkViewSnapshot } from './work-view-api-types.ts'

const appRoot = new URL('../../', import.meta.url)
const baseSnapshot = JSON.parse(readFileSync(new URL('test-fixtures/work-view-snapshot.trimmed.json', appRoot), 'utf8')) as WorkViewSnapshot
const now = Date.parse(baseSnapshot.generatedAt)
const [template] = baseSnapshot.humanRequests

const area = (focusAreaId: string, fields: Partial<WorkViewFocusArea> = {}): WorkViewFocusArea => ({
  focusAreaId, name: focusAreaId, goal: null, status: 'kept', priorityRank: null, ownerRank: null, source: 'owner-goals',
  mergedInto: null, evidence: null, decidedBy: 'owner', savedAt: null, ...fields,
})
const placed = (id: string, focusAreaId?: string): WorkViewHumanRequest => {
  const { focusAreaId: _ignored, ...request } = template
  return { ...request, id, ...(focusAreaId ? { focusAreaId } : {}) }
}
const goalItem = (id: string, kind: WorkViewGoalItem['kind'], focusAreaId: string | null, quote: string): WorkViewGoalItem => ({
  id, task: id, kind, rank: 1, title: id, goal: null, focusArea: null, focusAreaId, product: null, latestAt: '2026-10-20 09:15', timesAsked: 3, status: 'todo',
  evidence: [{ at: '2026-10-20 09:15', quote }],
})
const goals = (areas: WorkViewGoalItem[], asks: WorkViewGoalItem[]): WorkViewGoalList => ({
  listId: 'l', listName: 'owner-goals', history: false, project: 'p', updatedAt: '2026-10-22T00:00:00Z', periodStart: null, periodEnd: null,
  summary: null, generatedAt: '2026-10-22T00:00:00Z', windowDays: 30, sourcePromptCount: 10, mapPath: null, areas, asks,
})
const mapFocus = (focusAreas: WorkViewFocusArea[], humanRequests: WorkViewHumanRequest[], extra: Partial<WorkViewSnapshot> = {}) =>
  toWorkModel({ ...baseSnapshot, focusAreas, humanRequests, ...extra }, now)

test('a request\'s placement maps to its area; no placement reads "Sorting…", never a guessed area', () => {
  const model = mapFocus([area('fa_viewer', { name: 'Viewer' })], [placed('r1', 'fa_viewer'), placed('r2')])
  assert.deepEqual(model.requestReadErrors, [])
  assert.deepEqual(model.requests.map((request) => request.focusAreaId), ['fa_viewer', undefined])
  assert.deepEqual(model.requests.map((request) => focusAreaLabel(request.focusAreaId, model.focusAreas)), ['Viewer', 'Sorting…'])
})

test('Other is its own bucket, never an area', () => {
  const model = mapFocus([area('fa_viewer')], [placed('r1', 'other')])
  assert.equal(model.requests[0].focusAreaId, 'other')
  assert.equal(focusAreaLabel('other', model.focusAreas), 'Other')
  assert.ok(!model.focusAreas.some((entry) => entry.id === 'other'))
})

test('the owner\'s order wins over the suggested priority; unordered areas follow by priority, then name', () => {
  const model = mapFocus([
    area('fa_b', { name: 'B', priorityRank: 1 }),
    area('fa_owner2', { name: 'Owner second', ownerRank: 2, priorityRank: 9 }),
    area('fa_owner1', { name: 'Owner first', ownerRank: 1, priorityRank: 7 }),
    area('fa_a', { name: 'A', priorityRank: 1 }),
    area('fa_none', { name: 'No rank' }),
  ], [])
  assert.deepEqual(model.focusAreas.map((entry) => entry.name), ['Owner first', 'Owner second', 'A', 'B', 'No rank'])
})

test('a placement in a merged area resolves to the area it was merged into, through a chain', () => {
  const areas = [area('fa_old', { mergedInto: 'fa_mid' }), area('fa_mid', { mergedInto: 'fa_new' }), area('fa_new', { name: 'New' })]
  const model = mapFocus(areas, [placed('r1', 'fa_old')])
  assert.equal(model.requests[0].focusAreaId, 'fa_new')
  assert.equal(focusAreaLabel('fa_old', model.focusAreas), 'New')
})

test('a merge loop, a dismissed area or an unknown area reads "Sorting…" until a refresh places the request', () => {
  const model = mapFocus([area('fa_x', { mergedInto: 'fa_y' }), area('fa_y', { mergedInto: 'fa_x' }), area('fa_gone', { status: 'dismissed' })], [])
  for (const id of ['fa_x', 'fa_gone', 'fa_unknown']) {
    assert.equal(resolveFocusAreaId(id, model.focusAreas), null, id)
    assert.equal(focusAreaLabel(id, model.focusAreas), 'Sorting…', id)
  }
  assert.equal(mapFocus([area('fa_gone', { status: 'dismissed' })], [placed('r1', 'fa_gone')]).requests[0].focusAreaId, undefined)
})

test('a done area keeps its requests', () => {
  const model = mapFocus([area('fa_done', { status: 'done', name: 'Done one' })], [placed('r1', 'fa_done')])
  assert.equal(model.requests[0].focusAreaId, 'fa_done')
})

test('an area carries its own owner-goals quotes; asks go under their area (following merges), the rest under Other', () => {
  const model = mapFocus([area('fa_ship', { name: 'Ship' }), area('fa_old', { mergedInto: 'fa_ship' }), area('fa_gone', { status: 'dismissed' })], [], {
    goals: goals([goalItem('area-ship', 'focus-area', 'fa_ship', 'ship it this week')], [
      goalItem('ask-in', 'ask', 'fa_ship', 'add a release button'),
      goalItem('ask-merged', 'ask', 'fa_old', 'and the changelog'),
      goalItem('ask-dismissed', 'ask', 'fa_gone', 'a dark mode'),
      goalItem('ask-none', 'ask', null, 'any new stars?'),
    ]),
  })
  const ship = model.focusAreas.find((entry) => entry.id === 'fa_ship')!
  assert.deepEqual(ship.quotes, [{ at: '10-20 09:15', quote: 'ship it this week' }])
  assert.equal(ship.timesAsked, 3)
  assert.deepEqual(ship.asks.map((ask) => ask.id), ['ask-in', 'ask-merged'])
  assert.deepEqual(model.otherAsks.map((ask) => ask.id), ['ask-dismissed', 'ask-none'])
})

test('owner-goals area items follow merges like asks, and items on one area combine instead of the last one winning', () => {
  const later = { ...goalItem('area-old', 'focus-area', 'fa_old', 'x'), latestAt: '2026-10-22 18:00', timesAsked: 2, evidence: [{ at: '2026-10-22 18:00', quote: 'and the release notes' }] }
  const model = mapFocus([area('fa_ship', { name: 'Ship' }), area('fa_old', { mergedInto: 'fa_ship' })], [], {
    goals: goals([goalItem('area-ship', 'focus-area', 'fa_ship', 'ship it this week'), later, goalItem('area-dup', 'focus-area', 'fa_ship', 'ship it this week')], []),
  })
  const ship = model.focusAreas.find((entry) => entry.id === 'fa_ship')!
  assert.equal(ship.timesAsked, 3 + 2 + 3, 'times asked add up across the items')
  assert.equal(ship.latestAt, '10-22 18:00', 'the newest prompt is the latest')
  assert.deepEqual(ship.quotes, [{ at: '10-22 18:00', quote: 'and the release notes' }, { at: '10-20 09:15', quote: 'ship it this week' }], 'every quote once, newest first')
  assert.deepEqual(model.focusAreas.find((entry) => entry.id === 'fa_old')!.quotes, [], 'a merged-away area keeps no words of its own')
})

test('an older worker with no focusAreas: no areas, and every request reads "Sorting…"', () => {
  const model = toWorkModel({ ...baseSnapshot, humanRequests: [placed('r1', 'fa_viewer')] }, now)
  assert.deepEqual(model.focusAreas, [])
  assert.equal(model.requests[0].focusAreaId, undefined)
})

test('a Suggested card owns the Undo for a merge only; a rename or a new goal goes to the change bar, with Undo', () => {
  assert.equal(suggestionEditDecision({ action: 'merge', focusAreaId: 'fa_old', intoFocusAreaId: 'fa_ship' }), 'merged')
  assert.equal(suggestionEditDecision({ action: 'rename', focusAreaId: 'fa_old', name: 'Shipping' }), null)
  assert.equal(suggestionEditDecision({ action: 'edit-goal', focusAreaId: 'fa_old', goal: 'Ship weekly.' }), null)
})
