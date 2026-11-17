// The refresh line (components/bits.tsx RefreshStatus): which of its four states the worker's automatic refresh of
// goals and progress is in, and what a press of Refresh now or Try again changed. Pure, with .ts imports, so
// `node --test` loads it.
import type { AutoRefresh, SourceKind } from './work-data-source.ts'
import type { WorkViewRefreshState } from './work-view-api-types.ts'

/**
 * What the refresh line says (c-bits-refresh-controls, page-01): up to date, updating, failed, or waiting for an agent
 * to run it. The one definition; RefreshStatus words each one in a Record, and the tests take the list from here. Its
 * one writer is the worker's refresh.json (auto-refresh-worker.mjs), read through REFRESH_LINE_STATE. Moves:
 *
 *   up-to-date ──run starts──▶ updating ──run ends──▶ up-to-date | failed | waiting-for-agent
 *   failed | waiting-for-agent ──Try again, or the worker's next check──▶ updating
 */
export const REFRESH_LINE_STATES = ['up-to-date', 'updating', 'failed', 'waiting-for-agent'] as const
export type RefreshLineState = (typeof REFRESH_LINE_STATES)[number]

/** Each run state the worker reports, as the line shows it. A new worker state fails the typecheck here. */
const REFRESH_LINE_STATE: Record<WorkViewRefreshState, RefreshLineState> = {
  idle: 'up-to-date',
  ok: 'up-to-date',
  running: 'updating',
  failed: 'failed',
  'waiting-for-agent': 'waiting-for-agent',
}

/** The line's state. Before the worker's first refresh (no refresh.json yet) the line shows the last saved run. */
export function refreshLineState(refresh: Pick<AutoRefresh, 'state'> | null): RefreshLineState {
  return refresh ? REFRESH_LINE_STATE[refresh.state] : 'up-to-date'
}

/**
 * Whether this page can start a refresh: only the page this computer's worker serves. POST /api/work-view/refresh
 * answers loopback requests only (WorkViewRoutes.ts), so the cloud-served page cannot, and the sample's pretend run is
 * its own button (bits.tsx RefreshButton). RefreshStatus offers Try again on a failed refresh wherever this is true.
 */
export function pageStartsRefresh(sourceKind: SourceKind | null): boolean {
  return sourceKind === 'local'
}

/** What the worker answered a press of Refresh now or Try again, when, and which refresh record was on screen then. */
export interface RefreshPressAnswer {
  /** `running`: a run started. `idle`: nothing was due. `failed`: it failed before it could start, and recorded why. */
  state: string
  /** When the answer came, as an ISO time. */
  atIso: string
  /** refreshRecordKey of the record shown at the press. */
  recordAtPress: string
}

/** Which refresh record the screen shows: its state and when it finished. A new record from the worker changes it. */
export function refreshRecordKey(refresh: Pick<AutoRefresh, 'state' | 'finishedAt' | 'finishedAtIso'> | null): string {
  return JSON.stringify([refresh?.state ?? null, refresh?.finishedAtIso ?? refresh?.finishedAt ?? null])
}

/** What the line shows: its state, the time of a failure the record does not hold yet, and "Nothing new to refresh". */
export interface ShownRefreshLine { state: RefreshLineState; failedAtIso: string | null; nothingNew: boolean }

/**
 * What the line shows after a press, so a press always shows its outcome: a Try again that the worker answered with
 * "nothing was due" left the same failure on screen, as if the button did nothing (c-bits-refresh-controls). Until the
 * worker's record catches up with its answer, a run that started reads `updating`, and a start that failed reads
 * `failed` at the time of the answer; an answer that nothing was due adds "Nothing new to refresh". As soon as the
 * record on screen changes, the line shows that record.
 */
export function shownRefreshLine(refresh: Pick<AutoRefresh, 'state' | 'finishedAt' | 'finishedAtIso'> | null, answer: RefreshPressAnswer | null): ShownRefreshLine {
  const state = refreshLineState(refresh)
  if (!answer || answer.recordAtPress !== refreshRecordKey(refresh)) return { state, failedAtIso: null, nothingNew: false }
  if (answer.state === 'running') return { state: 'updating', failedAtIso: null, nothingNew: false }
  if (answer.state === 'failed') return { state: 'failed', failedAtIso: answer.atIso, nothingNew: false }
  return { state, failedAtIso: null, nothingNew: answer.state === 'idle' }
}
