// The board's columns: the same threads as the list, filed by what a person must do next. A step that waits on a
// person goes under what it needs from them; anything else goes under where the agent's work stands.
import type { HumanNeed, LiveState, Request } from '../data.ts'
import { sortThreads } from './thread-groups.ts'

/** Left to right: a person's moves first, then what is moving, then what rests. */
export const BOARD_COLUMNS = ['answer', 'review', 'approve', 'working', 'idle', 'done'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

const NEED_COLUMN: Record<HumanNeed, BoardColumn> = { answer: 'answer', review: 'review', approval: 'approve' }
// A state that names a person always comes with a human next step (assertConsistentRequest), so its entry here is
// only reached by a record that broke that rule; it still lands with the person's moves.
const STATE_COLUMN: Record<LiveState, BoardColumn> = { 'your-move': 'answer', 'needs-check': 'review', working: 'working', idle: 'idle', checked: 'done', closed: 'done', shipped: 'done' }

/** The one column a request sits in. Shipped, checked and closed requests rest together under Done. */
export function boardColumn(request: Pick<Request, 'state' | 'next'>): BoardColumn {
  return request.next.who === 'human' ? NEED_COLUMN[request.next.need] : STATE_COLUMN[request.state]
}

/** The column that folds to its header and count until a person opens it: what rests is out of the way by default. */
export const columnFolds = (column: BoardColumn): boolean => column === 'done'

/** Every column in order, empty ones included, each in the thread list's order (newest first within a state). */
export function boardColumns(requests: readonly Request[]): { column: BoardColumn; requests: Request[] }[] {
  const sorted = sortThreads(requests)
  return BOARD_COLUMNS.map((column) => ({ column, requests: sorted.filter((request) => boardColumn(request) === column) }))
}
