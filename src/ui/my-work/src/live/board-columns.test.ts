import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ATTENTION_ORDER, DONE_STATES, HUMAN_NEEDS, SAMPLE_REQUESTS, type Request } from '../data.ts'
import { BOARD_COLUMNS, boardColumn, boardColumns, columnFolds } from './board-columns.ts'

const variant = (id: string, change: Partial<Request>): Request => ({ ...SAMPLE_REQUESTS[0], id, ...change })
const everyShape: Request[] = [
  ...SAMPLE_REQUESTS,
  ...ATTENTION_ORDER.map((state) => variant(`bot-${state}`, { state, next: { who: 'bot', text: 'Keep going' } })),
  ...ATTENTION_ORDER.flatMap((state) => HUMAN_NEEDS.map((need) => variant(`human-${state}-${need}`, { state, next: { who: 'human', need, text: 'Your turn' } }))),
]

test('every request sits in exactly one column', () => {
  const columns = boardColumns(everyShape)
  assert.deepEqual(columns.map((entry) => entry.column), [...BOARD_COLUMNS])
  const placed = columns.flatMap((entry) => entry.requests.map((request) => request.id))
  assert.deepEqual([...placed].sort(), everyShape.map((request) => request.id).sort())
  assert.equal(new Set(placed).size, placed.length)
})

test('a step that waits on a person is filed by what it needs, whatever the state says', () => {
  const column = (change: Partial<Request>) => boardColumn(variant('x', change))
  assert.equal(column({ state: 'your-move', next: { who: 'human', need: 'answer', text: 'Pick one' } }), 'answer')
  assert.equal(column({ state: 'needs-check', next: { who: 'human', need: 'review', text: 'Check it' } }), 'review')
  assert.equal(column({ state: 'your-move', next: { who: 'human', need: 'approval', text: 'Merge it?' } }), 'approve')
  assert.equal(column({ state: 'shipped', next: { who: 'human', need: 'approval', text: 'Approve the follow-up' } }), 'approve')
  assert.equal(column({ state: 'working', next: { who: 'bot', text: 'Build' } }), 'working')
  assert.equal(column({ state: 'idle', next: { who: 'bot', text: 'Wait' } }), 'idle')
})

test('shipped, checked and closed requests rest together under Done, and none of them is a person\'s column', () => {
  const resting = DONE_STATES.map((state) => variant(state, { state, next: { who: 'bot', text: '' } }))
  for (const request of resting) assert.equal(boardColumn(request), 'done', request.state)
  const columns = boardColumns(resting)
  assert.deepEqual(columns.filter((entry) => entry.requests.length > 0).map((entry) => entry.column), ['done'])
})

test('only the Done column folds away', () => {
  assert.deepEqual(BOARD_COLUMNS.filter(columnFolds), ['done'])
})

test('a column lists its newest thread first', () => {
  const idle = (id: string, startedAtIso: string) => variant(id, { state: 'idle', startedAtIso, next: { who: 'bot', text: 'Wait' } })
  const [older, newer] = [idle('older', '2026-10-01T00:00:00Z'), idle('newer', '2026-10-09T00:00:00Z')]
  assert.deepEqual(boardColumns([older, newer]).find((entry) => entry.column === 'idle')!.requests.map((request) => request.id), ['newer', 'older'])
})

test('the board inside one focus holds that focus\'s threads only, with what the Open filter hides still under Done', async () => {
  const { threadGroups } = await import('./thread-groups.ts')
  const { FILTER_MATCHES } = await import('./work-filters.ts')
  const kept = (id: string) => ({ id, name: id, status: 'kept', ownerRank: null, priorityRank: null, mergedInto: null }) as import('../data.ts').FocusArea
  const thread = (id: string, state: Request['state'], focusAreaId: string) => ({ id, state, focusAreaId, startedAtIso: '2026-11-01T00:00:00Z', next: { who: 'bot', text: 'x' } }) as Request
  const groups = threadGroups([kept('atlas'), kept('harbor')], [thread('a-work', 'working', 'atlas'), thread('a-done', 'shipped', 'atlas'), thread('h-work', 'working', 'harbor'), thread('loose', 'idle', 'other')], FILTER_MATCHES.open)
  const atlas = groups.find((group) => group.key === 'atlas')!
  assert.deepEqual(atlas.rows.map((entry) => entry.id), ['a-work'])
  assert.deepEqual(boardColumns(atlas.requests).filter((entry) => entry.requests.length).map((entry) => [entry.column, entry.requests.map((request) => request.id)]), [['working', ['a-work']], ['done', ['a-done']]])
})
