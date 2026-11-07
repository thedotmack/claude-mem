// Status rules copied from claude-mem v15.0.1 plugin/ui/work-view/view-model.js:59-110
// (normalizeRecordedStatus, statusFor, STATUS and the lifecycle override in buildModel), plus:
// - the `needs-review` row, which appears in live data and B did not map;
// - `open` counted as in progress;
// - an explicit `shipped` lifecycle kept apart from `done`;
// - the LiveState, stage and next.who columns the wireframe needs.
// One normalized status drives state, stage and whose move is next, so those fields agree by construction.
import type { LiveState, Stage } from '../data.ts'

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000

export type NormalizedStatus =
  | 'needs-you' | 'needs-review' | 'blocked' | 'shipped' | 'done' | 'checked'
  | 'closed' | 'quiet' | 'in-progress' | 'todo' | 'unknown'

const NEEDS_YOU_VALUES = ['needs-you', 'needs-input', 'waiting-on-user', 'awaiting-approval', 'needs-approval']
const NEEDS_REVIEW_VALUES = ['needs-review', 'review', 'in-review', 'awaiting-review', 'ready-for-review']
const COMPLETE_LIFECYCLE_VALUES = ['done', 'completed', 'complete']
const SHIPPED_LIFECYCLE_VALUES = ['shipped', 'delivered']

/** Lowercased, `_` and spaces become `-`, and the synonym groups collapse to one value. */
export function normalizeRecordedStatus(value: unknown): string {
  const status = String(value ?? '').trim().toLowerCase().replace(/[_ ]/g, '-')
  if (NEEDS_YOU_VALUES.includes(status)) return 'needs-you'
  if (NEEDS_REVIEW_VALUES.includes(status)) return 'needs-review'
  return status
}

interface StatusItem { kind: string; status: string; lastUpdateEpoch?: number }

/** Item statuses only. Done needs an explicit lifecycle, so all-done items alone are `done` here and `unknown` after the override. */
export function statusFor(items: StatusItem[], now: number): NormalizedStatus {
  const states = items.map((item) => normalizeRecordedStatus(item.status))
  if (states.includes('needs-you')) return 'needs-you'
  if (states.includes('needs-review')) return 'needs-review'
  if (states.some((state) => ['blocked', 'failed'].includes(state))) return 'blocked'
  if (items.length && items.every((item) => item.kind === 'work-state' && ['done', 'completed'].includes(item.status))) return 'done'
  if (items.length && items.every((item) => item.kind === 'work-state' && item.status === 'dropped')) return 'closed'
  const updated = Math.max(0, ...items.map((item) => item.lastUpdateEpoch || 0))
  if (now - updated > STALE_AFTER_MS) return 'quiet'
  if (states.some((state) => ['doing', 'in-progress', 'active', 'running', 'open'].includes(state))) return 'in-progress'
  if (states.some((state) => ['todo', 'planned', 'queued'].includes(state))) return 'todo'
  return 'unknown'
}

export const STATUS: Record<NormalizedStatus, { label: string; rank: number }> = {
  'needs-you': { label: 'Needs you', rank: 0 },
  'needs-review': { label: 'Done, not checked', rank: 1 },
  blocked: { label: 'Blocked', rank: 1 },
  'in-progress': { label: 'In progress', rank: 2 },
  quiet: { label: 'No recent update', rank: 1 },
  done: { label: 'Done', rank: 5 },
  checked: { label: 'Checked', rank: 5 },
  shipped: { label: 'Shipped', rank: 6 },
  todo: { label: 'To do', rank: 3 },
  unknown: { label: 'Update recorded', rank: 4 },
  closed: { label: 'Closed', rank: 6 },
}

export interface RequestStatusInput {
  items: StatusItem[]
  lifecycle: { status: string | null; explicit: boolean; complete?: boolean | null } | null
  /** The worker sets this only for the version that was checked (fingerprint-guarded review). */
  checked: boolean
  /** Ledger progress state, when request-progress has reviewed it. */
  progressState?: string | null
  /** The latest review's percent. 100 means the work is done, even while recorded items still say doing. */
  progressPercent?: number | null
}

/** Lifecycle first (an explicit request_status / request_complete), then item statuses. */
export function normalizeRequestStatus({ items, lifecycle, checked, progressState, progressPercent }: RequestStatusInput, now: number): NormalizedStatus {
  let status = statusFor(items, now)
  const recordedStatus = lifecycle?.explicit ? normalizeRecordedStatus(lifecycle.status) : null
  const lifecycleStatus = !lifecycle?.explicit ? null
    : SHIPPED_LIFECYCLE_VALUES.includes(recordedStatus!) ? 'shipped'
      : lifecycle.complete === true || COMPLETE_LIFECYCLE_VALUES.includes(recordedStatus!) ? 'done'
        : recordedStatus
  // Done needs an explicit lifecycle; all-dropped items close the request on their own (status table row "all items dropped").
  if (status === 'done' && !['done', 'shipped'].includes(lifecycleStatus ?? '')) status = 'unknown'
  if (lifecycleStatus && lifecycleStatus in STATUS) status = lifecycleStatus as NormalizedStatus
  if (progressState === 'shipped') status = 'shipped'
  // Reviewed as finished but not shipped: done, waiting on a person's check, never still "working" at 100%.
  else if (progressPercent === 100 && ['in-progress', 'todo', 'unknown', 'quiet'].includes(status)) status = 'needs-review'
  if (checked && (status === 'done' || status === 'needs-review')) status = 'checked'
  return status
}

export interface StatusPresentation { state: LiveState; stage: Stage; who: 'bot' | 'human' }

/** The LiveState, stage and next.who columns of the status table. `recent` = updated in the last 6 hours. */
export function presentStatus(status: NormalizedStatus, recent: boolean): StatusPresentation {
  switch (status) {
    case 'needs-you': return { state: 'your-move', stage: 'Building', who: 'human' }
    case 'needs-review': return { state: 'needs-check', stage: 'Reviewing', who: 'human' }
    case 'blocked': return { state: 'your-move', stage: 'Building', who: 'human' }
    case 'shipped': return { state: 'shipped', stage: 'Shipped', who: 'bot' }
    case 'done': return { state: 'needs-check', stage: 'Reviewing', who: 'human' }
    case 'checked': return { state: 'your-move', stage: 'Reviewing', who: 'human' }
    case 'closed': return { state: 'idle', stage: 'Building', who: 'bot' }
    case 'quiet': return { state: 'idle', stage: 'Building', who: 'bot' }
    case 'in-progress': return { state: 'working', stage: 'Building', who: 'bot' }
    case 'todo': return { state: 'working', stage: 'Planning', who: 'bot' }
    case 'unknown': return { state: recent ? 'working' : 'idle', stage: 'Building', who: 'bot' }
  }
}
