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
 * The unit a duration is told in: under a minute it has just started, then whole minutes, hours and days (the steps
 * the card has used since 15.x). The one definition; components/live-motion.tsx words each unit in a Record, and the
 * shared page words them in its English (live/to-shared-focus.ts).
 */
export type DurationUnit = 'just-started' | 'minutes' | 'hours' | 'days'

/** A duration in milliseconds as its unit and whole count (0 for `just-started`). */
export function durationIn(milliseconds: number): { unit: DurationUnit; count: number } {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  if (minutes < 1) return { unit: 'just-started', count: 0 }
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', count: hours }
  return { unit: 'days', count: Math.floor(hours / 24) }
}

/** Each duration unit in the reader's words, each in its own t() call so the catalog test reads every one. */
const DURATION_UNIT_WORDS: Record<DurationUnit, (count: number, t: (text: string) => string) => string> = {
  'just-started': (_count, t) => t('Just started'),
  minutes: (count, t) => interpolate(t('{count} min'), { count }),
  hours: (count, t) => interpolate(t('{count} hr'), { count }),
  days: (count, t) => interpolate(count === 1 ? t('{count} day') : t('{count} days'), { count }),
}

/**
 * A duration in the reader's words, from the model's value (Request.runningForMs). A worker before 16.0.0 sent English
 * text instead of a value, which shows as it is (G19); no recorded start reads "Not recorded".
 */
export function durationWords(milliseconds: number | null | undefined, olderWorkerText: string | undefined, t: (text: string) => string): string {
  if (milliseconds === undefined && olderWorkerText !== undefined) return olderWorkerText
  if (milliseconds === undefined || milliseconds === null) return t('Not recorded')
  const { unit, count } = durationIn(milliseconds)
  return DURATION_UNIT_WORDS[unit](count, t)
}
