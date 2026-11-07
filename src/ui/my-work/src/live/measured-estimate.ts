// The ship estimate from measured pace (plan Phase 9, decision 3). It reads the last two memory reviews only:
// with one reading, or a flat or falling pace, there is no estimate. Nothing is guessed from task counts.

export interface ProgressReading { at: string; percent: number }

const MONTH_DAY = (epoch: number) => new Date(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** "at this pace, about Oct 24", or null when two advancing readings don't exist or the request shipped. */
export function measuredEstimate(readings: ProgressReading[], shipped: boolean): string | null {
  if (shipped) return null
  const dated = readings
    .map((reading) => ({ at: Date.parse(reading.at), percent: reading.percent }))
    .filter((reading) => Number.isFinite(reading.at) && Number.isFinite(reading.percent))
    .sort((a, b) => a.at - b.at)
  if (dated.length < 2) return null
  const [first, last] = dated.slice(-2)
  if (last.percent <= first.percent || last.at <= first.at || last.percent >= 100) return null
  const percentPerMs = (last.percent - first.percent) / (last.at - first.at)
  return `at this pace, about ${MONTH_DAY(last.at + (100 - last.percent) / percentPerMs)}`
}
