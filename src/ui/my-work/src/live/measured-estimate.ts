// The ship estimate from measured pace (plan Phase 9, decision 3). It reads the last two memory reviews only:
// with one reading, or a flat or falling pace, there is no estimate. Nothing is guessed from task counts.

export interface ProgressReading { at: string; percent: number }

/** The words before an estimate's day. The progress meter words them in the reader's language (bits.tsx ProgressMeter). */
export const ESTIMATE_PREFIX = 'at this pace, about '

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_DAY = (epoch: number) => new Date(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
const startOfDay = (epoch: number) => new Date(new Date(epoch).toDateString()).getTime()

/**
 * "at this pace, about Oct 24", or null when two advancing readings don't exist or the request shipped. The two
 * readings must be from different days: two reviews hours apart measure a few hours of work, and the review read
 * "at this pace, about Nov 15" on a request first reviewed that same Nov 15 as a promise (c-bits-progress-meter,
 * wording). A finish day already behind `now` is left out too: it is not a date to come, only a pace that did not hold
 * (on Nov 16, 20 of the 24 estimates on the owner's data named a day that had passed). The day is the worker's own,
 * as MONTH_DAY's date is.
 */
export function measuredEstimate(readings: ProgressReading[], shipped: boolean, now: number): string | null {
  if (shipped) return null
  const dated = readings
    .map((reading) => ({ at: Date.parse(reading.at), percent: reading.percent }))
    .filter((reading) => Number.isFinite(reading.at) && Number.isFinite(reading.percent))
    .sort((a, b) => a.at - b.at)
  if (dated.length < 2) return null
  const [first, last] = dated.slice(-2)
  if (last.percent <= first.percent || last.at <= first.at || last.percent >= 100) return null
  if (sameDay(first.at, last.at)) return null
  const percentPerMs = (last.percent - first.percent) / (last.at - first.at)
  const finish = last.at + (100 - last.percent) / percentPerMs
  if (startOfDay(finish) < startOfDay(now)) return null
  return `${ESTIMATE_PREFIX}${MONTH_DAY(finish)}`
}

/**
 * Whether an estimate names a day already behind `now`: one a worker before 16.0.0 sent (it never compared with the
 * day), or one a page kept on screen past its day. Its day carries no year, so it is read in the year that puts it
 * nearest to today. An estimate this reads as past is left out by the screens (data.ts measuredEstimate).
 */
export function estimateDayIsPast(estimate: string, now: number): boolean {
  if (!estimate.startsWith(ESTIMATE_PREFIX)) return false
  const match = /^([A-Z][a-z]{2}) (\d{1,2})$/.exec(estimate.slice(ESTIMATE_PREFIX.length).trim())
  const month = match ? MONTHS.indexOf(match[1]) : -1
  if (!match || month < 0) return false
  const today = startOfDay(now)
  const year = new Date(now).getFullYear()
  const nearest = [year - 1, year, year + 1]
    .map((candidate) => new Date(candidate, month, Number(match[2])).getTime())
    .reduce((best, candidate) => (Math.abs(candidate - today) < Math.abs(best - today) ? candidate : best))
  return nearest < today
}
