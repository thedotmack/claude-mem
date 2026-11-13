// How long ago a request was asked, as the few characters a row has room for: "now", "5m", "3h", "2d", "2w", "3mo".

export const AGE_UNITS = ['now', 'minute', 'hour', 'day', 'week', 'month'] as const
export type AgeUnit = (typeof AGE_UNITS)[number]
export interface RequestAge { unit: AgeUnit; count: number; short: string }

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
/** Days are counted up to two weeks, weeks up to two months. */
const WEEKS_FROM_DAYS = 14, MONTHS_FROM_DAYS = 61, DAYS_PER_MONTH = 30.44

const SHORT: Record<Exclude<AgeUnit, 'now'>, string> = { minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo' }
/** The sentence a screen reader and the hover text say, one and many, since the short form has no words. */
export const AGE_SENTENCE: Record<AgeUnit, { one: string; many: string }> = {
  now: { one: 'Asked just now', many: 'Asked just now' },
  minute: { one: 'Asked 1 minute ago', many: 'Asked {count} minutes ago' },
  hour: { one: 'Asked 1 hour ago', many: 'Asked {count} hours ago' },
  day: { one: 'Asked 1 day ago', many: 'Asked {count} days ago' },
  week: { one: 'Asked 1 week ago', many: 'Asked {count} weeks ago' },
  month: { one: 'Asked 1 month ago', many: 'Asked {count} months ago' },
}

/**
 * The age of a request asked at `startedAtIso`, read at `now`. Null when the start is not recorded or cannot be
 * read: no age is shown, never a guessed one. A start in the future (two clocks that disagree) reads as now.
 */
export function requestAge(startedAtIso: string | undefined, now: number): RequestAge | null {
  const started = startedAtIso ? Date.parse(startedAtIso) : Number.NaN
  if (!Number.isFinite(started)) return null
  const elapsed = now - started
  const days = Math.floor(elapsed / DAY)
  const [unit, count]: [AgeUnit, number] = elapsed < MINUTE ? ['now', 0]
    : elapsed < HOUR ? ['minute', Math.floor(elapsed / MINUTE)]
      : elapsed < DAY ? ['hour', Math.floor(elapsed / HOUR)]
        : days < WEEKS_FROM_DAYS ? ['day', days]
          : days < MONTHS_FROM_DAYS ? ['week', Math.floor(days / 7)]
            : ['month', Math.floor(days / DAYS_PER_MONTH)]
  return { unit, count, short: unit === 'now' ? 'now' : `${count}${SHORT[unit]}` }
}

/** The age's sentence before translation, and the count to put in it. */
export const ageSentence = (age: RequestAge): string => age.count === 1 ? AGE_SENTENCE[age.unit].one : AGE_SENTENCE[age.unit].many
