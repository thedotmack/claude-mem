// Run with `npm test`. The Board view's columns (components/thread-board.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { presentStatus, STATUS, type NormalizedStatus } from './status-normalization.ts'
import { BOARD_COLUMNS, boardColumn, boardColumns, boardFilter } from './board-columns.ts'

const request = (id: string, state: Request['state'], closed = false) => ({ id, state, closed }) as Request
const ids = (requests: Request[]) => boardColumns(requests).map((entry) => [entry.column, entry.requests.map((item) => item.id)])

describe('boardColumn', () => {
  it('files each state under its column', () => {
    assert.deepEqual(
      (['your-move', 'needs-check', 'working', 'idle', 'shipped'] as const).map((state) => boardColumn({ state })),
      ['your-move', 'review', 'working', 'idle', 'shipped'],
    )
  })

  it('gives every recorded status a column, through the state it is shown as', () => {
    const columnOf = (status: NormalizedStatus, recent = true) => boardColumn({ state: presentStatus(status, recent).state })
    assert.deepEqual(Object.fromEntries((Object.keys(STATUS) as NormalizedStatus[]).map((status) => [status, columnOf(status)])), {
      'needs-you': 'your-move', blocked: 'your-move', checked: 'your-move',
      'needs-review': 'review', done: 'review',
      'in-progress': 'working', todo: 'working', unknown: 'working',
      quiet: 'idle', closed: 'idle',
      shipped: 'shipped',
    })
    assert.equal(columnOf('unknown', false), 'idle')
  })

  it('puts a closed request on no column, whatever its state', () => {
    for (const state of ['your-move', 'needs-check', 'working', 'idle', 'shipped'] as const) assert.equal(boardColumn({ state, closed: true }), null)
  })
})

describe('boardColumns', () => {
  it('has no Closed column', () => {
    assert.deepEqual([...BOARD_COLUMNS], ['your-move', 'review', 'working', 'idle', 'shipped'])
  })

  it('keeps every column, empty ones included, in order', () => {
    assert.deepEqual(ids([]), [['your-move', []], ['review', []], ['working', []], ['idle', []], ['shipped', []]])
    assert.deepEqual(ids([request('a', 'working')]), [['your-move', []], ['review', []], ['working', ['a']], ['idle', []], ['shipped', []]])
  })

  it('puts each open request in exactly one column, in the order given, and leaves closed ones out', () => {
    const requests = [request('s', 'shipped'), request('w2', 'working'), request('y', 'your-move'), request('gone', 'idle', true), request('c', 'needs-check'), request('w1', 'working'), request('i', 'idle')]
    assert.deepEqual(ids(requests), [['your-move', ['y']], ['review', ['c']], ['working', ['w2', 'w1']], ['idle', ['i']], ['shipped', ['s']]])
  })

  it('shows only what the page filter let through', () => {
    const all = [request('y', 'your-move'), request('w', 'working'), request('s', 'shipped')]
    const working = all.filter((item) => item.state === 'working')
    assert.deepEqual(ids(working), [['your-move', []], ['review', []], ['working', ['w']], ['idle', []], ['shipped', []]])
  })
})

describe('boardFilter', () => {
  it('keeps every filter but Closed, which shows all open requests', () => {
    assert.deepEqual((['all', 'needs-you', 'working', 'shipped', 'closed'] as const).map(boardFilter), ['all', 'needs-you', 'working', 'shipped', 'all'])
  })
})
