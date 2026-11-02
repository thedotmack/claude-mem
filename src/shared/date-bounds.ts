import { AppError } from '../services/server/ErrorHandler.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert a date-range bound to an epoch for a `created_at_epoch` comparison.
 *
 * A date-only end bound (e.g. "2025-01-01") means "through the end of that day".
 * `new Date("2025-01-01").getTime()` returns midnight UTC, so without this an
 * end equal to the start matches only the exact midnight millisecond and the
 * range returns nothing. The end bound therefore extends to the last
 * millisecond of the named day.
 *
 * A value that is not a date throws a 400 `AppError`. It used to come back as
 * NaN, which matched nothing in SQLite (NaN binds as NULL) but nothing was
 * filtered in the Chroma path (`!NaN` skips the comparison).
 */
export function resolveDateBound(value: string | number, boundary: 'start' | 'end'): number {
  if (typeof value === 'number') return requireValidEpoch(value, value, boundary);

  // Trim before parsing as well as classification: padded ISO dates otherwise
  // use the runtime local timezone instead of date-only UTC semantics.
  const normalized = value.trim();
  const parsed = isCalendarDatePrefix(normalized) ? new Date(normalized).getTime() : Number.NaN;
  const epoch = requireValidEpoch(parsed, value, boundary);
  if (boundary === 'end' && DATE_ONLY_PATTERN.test(normalized)) {
    return epoch + MS_PER_DAY - 1;
  }
  return epoch;
}

/**
 * False when the value starts with a YYYY-MM-DD date that is not on the
 * calendar. `new Date("2025-02-30")` does not fail: it rolls over to March 2,
 * so a range ending on "February 30" silently ran into March.
 */
function isCalendarDatePrefix(value: string): boolean {
  const match = ISO_DATE_PREFIX.exec(value);
  if (!match) return true;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireValidEpoch(epoch: number, original: string | number, boundary: 'start' | 'end'): number {
  if (Number.isNaN(epoch)) {
    throw new AppError(
      `Invalid date for the ${boundary} of the range: ${JSON.stringify(original)}. Use an ISO date such as 2025-01-31 or 2025-01-31T08:00:00Z.`,
      400,
      'INVALID_DATE'
    );
  }
  return epoch;
}
