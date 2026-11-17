// How long a request has been going, as the card and the one-line rows say it (components/live-motion.tsx RunningFor).
// Pure, with .ts imports, so `node --test` loads it.
import { interpolate } from '../../../i18n/locale.ts'
import type { LiveState } from '../data.ts'

/**
 * The word before a request's duration (c-live-motion-running-for): only a request still under way is "running"; an
 * idle one has been open that long (it said "Running 41 days"), and a shipped one says how long it took.
 */
export const DURATION_WORD: Record<LiveState, string> = {
  working: 'Running',
  'your-move': 'Running',
  'needs-check': 'Running',
  idle: 'Open for',
  shipped: 'Took',
}

/**
 * Whether a request's duration is a whole run to its recorded end: a shipped one, which says how long it took
 * (DURATION_WORD's "Took"). The one rule; RunningFor asks it. Every other state is still going, or open.
 */
export const isFinishedRun = (state: LiveState) => state === 'shipped'

/**
 * The unit a duration is told in: under a minute a run still going has just started and a finished one took under a
 * minute (c-live-motion-running-for: a shipped run read "Took Just started"), then whole minutes, hours and days (the
 * steps the card has used since 15.x). The one definition; DURATION_UNIT_WORDS below words each unit for the screens
 * (RunningFor, the drawer), and the shared page words them in its English (live/to-shared-focus.ts).
 */
export type DurationUnit = 'just-started' | 'under-a-minute' | 'minutes' | 'hours' | 'days'

/**
 * A duration in milliseconds as its unit and whole count (0 under a minute). `finishedRun`: the duration is how long
 * a finished run took (isFinishedRun), so under a minute is `under-a-minute`, never `just-started`.
 */
export function durationIn(milliseconds: number, finishedRun = false): { unit: DurationUnit; count: number } {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  if (minutes < 1) return { unit: finishedRun ? 'under-a-minute' : 'just-started', count: 0 }
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', count: hours }
  return { unit: 'days', count: Math.floor(hours / 24) }
}

/** Each duration unit in the reader's words, each in its own t() call so the catalog test reads every one. */
const DURATION_UNIT_WORDS: Record<DurationUnit, (count: number, t: (text: string) => string) => string> = {
  'just-started': (_count, t) => t('Just started'),
  'under-a-minute': (_count, t) => t('under a minute'),
  minutes: (count, t) => interpolate(t('{count} min'), { count }),
  hours: (count, t) => interpolate(t('{count} hr'), { count }),
  days: (count, t) => interpolate(count === 1 ? t('{count} day') : t('{count} days'), { count }),
}

/**
 * A duration in the reader's words, from the model's value (Request.runningForMs). A worker before 16.0.0 sent English
 * text instead of a value, which shows as it is (G19); no recorded start reads "Not recorded". `finishedRun` as
 * durationIn takes it.
 */
export function durationWords(milliseconds: number | null | undefined, olderWorkerText: string | undefined, t: (text: string) => string, finishedRun = false): string {
  if (milliseconds === undefined && olderWorkerText !== undefined) return olderWorkerText
  if (milliseconds === undefined || milliseconds === null) return t('Not recorded')
  const { unit, count } = durationIn(milliseconds, finishedRun)
  return DURATION_UNIT_WORDS[unit](count, t)
}
