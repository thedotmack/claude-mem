// The owner-goals run (asks, and Past focus), against a scrubbed fixture with made-up text in the real shape.
// Focus areas themselves come from the my-focus list: see to-focus-model.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewGoalList, WorkViewSnapshot } from './work-view-api-types.ts'

const appRoot = new URL('../../', import.meta.url)
const readJson = <T>(path: string) => JSON.parse(readFileSync(new URL(path, appRoot), 'utf8')) as T
const baseSnapshot = readJson<WorkViewSnapshot>('test-fixtures/work-view-snapshot.trimmed.json')
const scrubbedGoals = readJson<{ goals: WorkViewGoalList; goalHistory: WorkViewGoalList[] }>('test-fixtures/work-view-goals.scrubbed.json')
const now = Date.parse(baseSnapshot.generatedAt)
const mapWithGoals = (goals: Partial<Pick<WorkViewSnapshot, 'goals' | 'goalHistory'>>) => toWorkModel({ ...baseSnapshot, ...goals }, now)

test('mined areas with no my-focus area add no area; an ask with no area keeps its words and goes under Other', () => {
  const model = mapWithGoals(scrubbedGoals)
  assert.equal(model.goalsReadError, null)
  assert.deepEqual(model.focusAreas, [], 'areas come only from the my-focus list')
  assert.deepEqual(model.otherAsks, [{ id: scrubbedGoals.goals.asks[0].id, title: 'Dark mode for the planner', timesAsked: 3, latestAt: '10-17 06:40', quotes: [{ at: '10-17 06:40', quote: 'can we get a dark mode yet?' }] }])
})

test('the current period and last run come from the run itself, with no cost', () => {
  const model = mapWithGoals(scrubbedGoals)
  assert.deepEqual(model.currentPeriod, { label: '31 days to Oct 18', windowDays: 31, promptCount: 120 })
  assert.equal(model.lastRuns.goals?.label, 'owner-goals')
  assert.equal(model.lastRuns.goals?.deviceName, 'this computer')
  assert.match(model.lastRuns.goals!.lastRunAt, /^Oct 1[89]\b/)
})

test('past months: label from the period, prompt count, summary headline and first quote', () => {
  const model = mapWithGoals(scrubbedGoals)
  assert.deepEqual(model.pastPeriods, [
    { id: 'owner-goals/2026-08-18', label: 'Aug 18 – Sep 17', promptCount: 54, headline: 'The sample owner set up the seed catalog.',
      areas: [{ title: 'Seed catalog', label: 'Catalog', timesAsked: 3, quote: { at: '09-15 10:04', quote: 'add every tomato variety to the catalog' } }] },
    { id: 'owner-goals/2025-12-18', label: 'Dec 18, 2025 – Jan 17, 2026', promptCount: 7, headline: 'No summary recorded for this month.',
      areas: [{ title: 'Winter plan', label: 'Planner', timesAsked: 1, quote: null }] },
  ])
})

test('a month in another year says which year', () => {
  const lastYear = { ...scrubbedGoals.goalHistory[0], periodStart: '2025-08-18', periodEnd: '2025-09-18' }
  assert.equal(mapWithGoals({ ...scrubbedGoals, goalHistory: [lastYear] }).pastPeriods[0].label, 'Aug 18 – Sep 17, 2025')
})

test('no owner-goals run: no asks, no period, no last run, and no error', () => {
  for (const goals of [{}, { goals: null, goalHistory: [] }]) {
    const model = mapWithGoals(goals)
    assert.deepEqual([model.focusAreas, model.otherAsks, model.pastPeriods, model.currentPeriod, model.lastRuns.goals, model.goalsReadError], [[], [], [], null, null, null])
  }
})

test('an unreadable run empties Past focus and the asks with the reason, and leaves the requests alone', () => {
  const broken = { ...scrubbedGoals.goals, areas: [{ ...scrubbedGoals.goals.areas[0], timesAsked: null }] }
  const model = mapWithGoals({ goals: broken, goalHistory: scrubbedGoals.goalHistory })
  assert.match(model.goalsReadError!, /How often the focus area "Ship the garden planner" was asked is not recorded/)
  assert.equal(model.currentPeriod, null)
  assert.deepEqual(model.otherAsks, [])
  assert.equal(model.requests.length, mapWithGoals({}).requests.length)
  const badTime = { ...scrubbedGoals.goals, generatedAt: 'yesterday' }
  assert.match(mapWithGoals({ goals: badTime }).goalsReadError!, /no readable generated_at/)
})
