// The ship estimate from measured pace (plan Phase 9, decision 3). It reads the last two memory reviews only:
// with one reading, or a flat or falling pace, there is no estimate. Nothing is guessed from task counts.

import { formatEstimate, type Language } from '../i18n/index.ts'

export interface ProgressReading { at: string; percent: number }

/** "at this pace, about Oct 24", or null when two advancing readings don't exist or the request shipped. */
export function measuredEstimate(readings: ProgressReading[], shipped: boolean, language: Language = 'en'): string | null {
  return formatEstimate(readings, shipped, language)
}
