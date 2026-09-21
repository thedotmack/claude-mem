
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert a date-range bound to an epoch for a `created_at_epoch` comparison.
 *
 * A date-only end bound (e.g. "2025-01-01") means "through the end of that day".
 * `new Date("2025-01-01").getTime()` returns midnight UTC, so without this an
 * end equal to the start matches only the exact midnight millisecond and the
 * range returns nothing. The end bound therefore extends to the last
 * millisecond of the named day.
 */
export function resolveDateBound(value: string | number, boundary: 'start' | 'end'): number {
  if (typeof value === 'number') return value;

  const epoch = new Date(value).getTime();
  if (boundary === 'end' && DATE_ONLY_PATTERN.test(value.trim())) {
    return epoch + MS_PER_DAY - 1;
  }
  return epoch;
}
