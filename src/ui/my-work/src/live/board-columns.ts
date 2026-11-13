// The board's columns: the same requests as Cards and List, filed by where each one stands.
import type { LiveState, Request } from '../data.ts'
import type { WorkFilter } from '../store/store-types.ts'

/** Left to right: what waits on a person first, then what is moving, then the rest. There is no column for closed requests. */
export const BOARD_COLUMNS = ['your-move', 'review', 'working', 'idle', 'shipped'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]

const STATE_COLUMN: Record<LiveState, BoardColumn> = { 'your-move': 'your-move', 'needs-check': 'review', working: 'working', idle: 'idle', shipped: 'shipped' }

/** The one column a request sits in. A closed request is on no column. */
export function boardColumn(request: Pick<Request, 'state' | 'closed'>): BoardColumn | null {
  return request.closed ? null : STATE_COLUMN[request.state]
}

/** Every column in order, empty ones included; each keeps the order the requests came in. */
export function boardColumns<T extends Pick<Request, 'state' | 'closed'>>(requests: readonly T[]): { column: BoardColumn; requests: T[] }[] {
  return BOARD_COLUMNS.map((column) => ({ column, requests: requests.filter((request) => boardColumn(request) === column) }))
}

/** The filter the board applies for a saved one: Closed has no column, so it shows every open request instead. */
export function boardFilter(filter: WorkFilter): Exclude<WorkFilter, 'closed'> {
  return filter === 'closed' ? 'all' : filter
}
