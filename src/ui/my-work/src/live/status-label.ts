// The words for where a request stands: one table per thing that is worded, read by every dot, badge and count.
import { isDone, isDoneState, type DoneState, type HumanNeed, type LiveState, type Request } from '../data.ts'

export const STATE_LABEL: Record<LiveState, string> = {
  working: 'Working', 'needs-check': 'Done, not checked', 'your-move': 'Your move', idle: 'Idle',
  checked: 'Checked', closed: 'Closed', shipped: 'Shipped',
}

export const NEED_LABEL: Record<HumanNeed, string> = { answer: 'answer', review: 'review', approval: 'approval' }

type Translate = (text: string) => string
const asWritten: Translate = (text) => text

/**
 * What a request's status dot says on hover, on keyboard focus and to a screen reader: what it needs from a person
 * ("Needs you · review"), or where it stands when it needs nobody ("Working", "Checked").
 */
export function statusLabel(request: Pick<Request, 'state' | 'next'>, t: Translate = asWritten): string {
  return request.next.who === 'human' ? t('Needs you · {need}').replace('{need}', t(NEED_LABEL[request.next.need])) : t(STATE_LABEL[request.state])
}

/** What a focus line counts: each open state by itself, and everything that rests as one quiet Done. */
export const COUNT_BUCKETS = ['your-move', 'needs-check', 'working', 'idle', 'done'] as const satisfies readonly (Exclude<LiveState, DoneState> | 'done')[]
export type CountBucket = (typeof COUNT_BUCKETS)[number]

const COUNT_LABEL: Record<CountBucket, { one: string; many: string }> = {
  'your-move': { one: '{count} needs you', many: '{count} need you' },
  'needs-check': { one: '{count} done, not checked', many: '{count} done, not checked' },
  working: { one: '{count} working', many: '{count} working' },
  idle: { one: '{count} idle', many: '{count} idle' },
  done: { one: '{count} done', many: '{count} done' },
}

/** The bucket a request is counted in. A shipped request that still owes a person a move counts as that person's. */
export function countBucket(request: Pick<Request, 'state' | 'next'>): CountBucket {
  if (isDoneState(request.state)) return isDone(request) ? 'done' : 'your-move'
  return request.state
}

/** The state whose colours a status label wears: a shipped request that still owes a person a move is coloured as that move, as it is counted. */
export function statusTone(request: Pick<Request, 'state' | 'next'>): LiveState {
  const bucket = countBucket(request)
  return bucket === 'done' ? request.state : bucket
}

/** A focus line's counts in order, empty buckets left out, each with the words its dot shows ("3 need you"). */
export function statusCounts(requests: readonly Pick<Request, 'state' | 'next'>[], t: Translate = asWritten): { bucket: CountBucket; count: number; label: string }[] {
  return COUNT_BUCKETS.map((bucket) => {
    const count = requests.filter((request) => countBucket(request) === bucket).length
    return { bucket, count, label: t(COUNT_LABEL[bucket][count === 1 ? 'one' : 'many']).replace('{count}', String(count)) }
  }).filter((entry) => entry.count > 0)
}
