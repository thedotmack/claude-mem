import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ATTENTION_ORDER, DONE_STATES, HUMAN_NEEDS, SAMPLE_REQUESTS, needsYou, type Request } from '../data.ts'
import { WORK_FILTERS } from '../store/store-types.ts'
import { boardColumn } from './board-columns.ts'
import { FILTER_MATCHES } from './work-filters.ts'

const variant = (id: string, change: Partial<Request>): Request => ({ ...SAMPLE_REQUESTS[0], id, ...change })
const everyShape: Request[] = [
  ...SAMPLE_REQUESTS,
  ...ATTENTION_ORDER.map((state) => variant(`bot-${state}`, { state, next: { who: 'bot', text: 'Keep going' } })),
  ...ATTENTION_ORDER.flatMap((state) => HUMAN_NEEDS.map((need) => variant(`human-${state}-${need}`, { state, next: { who: 'human', need, text: 'Your turn' } }))),
]
const ids = (requests: Request[]) => requests.map((request) => request.id)

test('there is a rule for every filter, and Open is the first one offered', () => {
  assert.deepEqual(Object.keys(FILTER_MATCHES).sort(), [...WORK_FILTERS].sort())
  assert.equal(WORK_FILTERS[0], 'open')
})

test('every request is under Open or under Done, never both', () => {
  for (const request of everyShape) assert.notEqual(FILTER_MATCHES.open(request), FILTER_MATCHES.done(request), request.id)
})

test('Done holds shipped, checked and closed requests that owe nobody a move, and the list, the board and Needs you agree', () => {
  const done = everyShape.filter(FILTER_MATCHES.done)
  assert.deepEqual([...new Set(done.map((request) => request.state))].sort(), [...DONE_STATES].sort())
  for (const request of everyShape) assert.equal(FILTER_MATCHES.done(request), boardColumn(request) === 'done', request.id)
  assert.deepEqual(done.filter(needsYou), [])
  assert.deepEqual(done.filter(FILTER_MATCHES['needs-you']), [])
  assert.deepEqual(done.filter(FILTER_MATCHES.working), [])
})

test('Open, the default, hides what rests and keeps everything else', () => {
  const open = ids(everyShape.filter(FILTER_MATCHES.open))
  for (const state of DONE_STATES) assert.ok(!open.includes(`bot-${state}`), state)
  for (const state of ['your-move', 'needs-check', 'working', 'idle']) assert.ok(open.includes(`bot-${state}`), state)
  assert.ok(open.includes('human-shipped-approval'), 'a shipped request that still owes an approval is open')
})
