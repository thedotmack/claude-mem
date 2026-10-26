// My Goals from the owner-goals run (plan Phase 7), against a scrubbed fixture with made-up text in the real shape.
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

test('current priorities and open asks keep the run order, ranks, counts and words', () => {
  const model = mapWithGoals(scrubbedGoals)
  assert.equal(model.goalsReadError, null)
  assert.deepEqual(model.priorities.map((goal) => goal.title), ['Ship the garden planner', 'Fix the watering reminders'])
  const [first] = model.priorities
  assert.equal(first.id, scrubbedGoals.goals.priorities[0].id)
  assert.equal(first.kind, 'Priority')
  assert.equal(first.rank, 1)
  assert.equal(first.timesAsked, 4, 'times asked comes from the run, not a count of quotes')
  assert.equal(first.latestAt, '10-18 22:11')
  assert.deepEqual(first.quotes, [{ at: '10-18 22:11', quote: 'please ship the garden planner this week' }, { at: '10-16', quote: 'the seed list should sort by month' }])
  assert.equal(model.priorities[1].product, 'Product not recorded')
  assert.deepEqual(model.priorities[1].quotes, [{ at: '', quote: 'reminders fire twice on rainy days' }])
  assert.deepEqual(model.openAsks.map((ask) => [ask.kind, ask.title, ask.servedBy]), [['Open ask', 'Dark mode for the planner', undefined]])
})

test('the current period and last run come from the run itself, with no cost', () => {
  const model = mapWithGoals(scrubbedGoals)
  assert.deepEqual(model.currentPeriod, { label: '31 days to Oct 18', windowDays: 31, promptCount: 120 })
  assert.equal(model.lastRuns.goals?.label, 'owner-goals')
  assert.equal(model.lastRuns.goals?.deviceName, 'this computer')
  assert.match(model.lastRuns.goals!.lastRunAt, /^Oct 1[89]\b/)
  assert.deepEqual(model.goalOnlyRequests, [], 'live mode links goals to recorded requests only')
})

test('past months: label from the period, prompt count, summary headline and first quote', () => {
  const model = mapWithGoals(scrubbedGoals)
  assert.deepEqual(model.pastPeriods, [
    { id: 'owner-goals/2026-08-18', label: 'Aug 18 – Sep 17', promptCount: 54, headline: 'The sample owner set up the seed catalog.',
      priorities: [{ title: 'Seed catalog', product: 'Catalog', timesAsked: 3, quote: { at: '09-15 10:04', quote: 'add every tomato variety to the catalog' } }] },
    { id: 'owner-goals/2025-12-18', label: 'Dec 18, 2025 – Jan 17, 2026', promptCount: 7, headline: 'No summary recorded for this month.',
      priorities: [{ title: 'Winter plan', product: 'Planner', timesAsked: 1, quote: null }] },
  ])
})

test('a month in another year says which year', () => {
  const lastYear = { ...scrubbedGoals.goalHistory[0], periodStart: '2025-08-18', periodEnd: '2025-09-18' }
  assert.equal(mapWithGoals({ ...scrubbedGoals, goalHistory: [lastYear] }).pastPeriods[0].label, 'Aug 18 – Sep 17, 2025')
})

test('no owner-goals run: no goals, no period, no last run, and no error', () => {
  for (const goals of [{}, { goals: null, goalHistory: [] }]) {
    const model = mapWithGoals(goals)
    assert.deepEqual([model.priorities, model.openAsks, model.pastPeriods, model.currentPeriod, model.lastRuns.goals, model.goalsReadError], [[], [], [], null, null, null])
  }
})

test('an unreadable run empties My Goals with the reason and leaves the requests alone', () => {
  const broken = { ...scrubbedGoals.goals, priorities: [{ ...scrubbedGoals.goals.priorities[0], timesAsked: null }] }
  const model = mapWithGoals({ goals: broken, goalHistory: scrubbedGoals.goalHistory })
  assert.match(model.goalsReadError!, /How often goal "Ship the garden planner" was asked is not recorded/)
  assert.equal(model.currentPeriod, null)
  assert.deepEqual(model.priorities, [])
  assert.equal(model.requests.length, mapWithGoals({}).requests.length)
  const badTime = { ...scrubbedGoals.goals, generatedAt: 'yesterday' }
  assert.match(mapWithGoals({ goals: badTime }).goalsReadError!, /no readable generated_at/)
})
