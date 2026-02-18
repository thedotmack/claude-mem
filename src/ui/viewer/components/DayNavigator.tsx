import React from 'react';
import { getTodayString } from '../utils/date';

// ---------------------------------------------------------------------------
// Pure utilities (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Formats a YYYY-MM-DD date string into a short display string like "Feb 17".
 * Returns "Today" when the date matches today.
 */
function formatSingleDate(date: string, today: string): string {
  if (date === today) return 'Today';
  // Parse as local date to avoid timezone shifts
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Adds `days` to a YYYY-MM-DD string and returns a new YYYY-MM-DD string.
 * Uses local calendar arithmetic to avoid timezone drift.
 */
function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Computes the new single-day date when navigating by one day.
 *
 * @param currentDate - The currently active date filter value (YYYY-MM-DD), or "" for no filter.
 * @param direction   - "prev" to go back one day, "next" to go forward one day.
 * @param today       - Today's date in YYYY-MM-DD format (used as the cap for "next").
 * @returns A YYYY-MM-DD string representing the new date.
 */
export function navigateDay(
  currentDate: string,
  direction: 'prev' | 'next',
  today: string,
): string {
  if (!currentDate) {
    // No active filter: going next sets to today, going prev sets to yesterday
    return direction === 'next' ? today : addDays(today, -1);
  }

  if (direction === 'prev') {
    return addDays(currentDate, -1);
  }

  // next — cap at today
  const candidate = addDays(currentDate, 1);
  return candidate <= today ? candidate : today;
}

/**
 * Builds the display label for the DayNavigator.
 *
 * @param dateStart - Active start date filter (YYYY-MM-DD) or "".
 * @param dateEnd   - Active end date filter (YYYY-MM-DD) or "".
 * @param today     - Today's date in YYYY-MM-DD format.
 * @returns A human-readable label string.
 */
export function formatDayLabel(dateStart: string, dateEnd: string, today: string): string {
  if (!dateStart && !dateEnd) return 'All sessions';

  const hasRange = dateEnd && dateEnd !== dateStart;

  if (hasRange) {
    const startLabel = formatSingleDate(dateStart, today);
    const endLabel = formatSingleDate(dateEnd, today);
    return `${startLabel} \u2013 ${endLabel}`;
  }

  return formatSingleDate(dateStart, today);
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface DayNavigatorProps {
  /** Available date keys from session groups, in display order (newest first). */
  availableDateKeys: string[];
  /** The currently active/visible date key, or null for "All sessions". */
  activeDateKey: string | null;
  /** Navigate to the previous (older) day. */
  onPrev: () => void;
  /** Navigate to the next (newer) day. */
  onNext: () => void;
  /** Reset to show all sessions (scroll to top). */
  onReset: () => void;
  /** Today's date in YYYY-MM-DD format. Defaults to the current local date. */
  today?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * DayNavigator renders a compact [←] label [→] row for day-by-day
 * scroll navigation between available session groups.
 * Clicking the label resets to "All sessions" (scroll to top).
 */
export function DayNavigator({
  availableDateKeys,
  activeDateKey,
  onPrev,
  onNext,
  onReset,
  today = getTodayString(),
}: DayNavigatorProps): React.ReactElement {
  const label = activeDateKey
    ? formatDayLabel(activeDateKey, '', today)
    : 'All sessions';

  const hasKeys = availableDateKeys.length > 0;
  const isAtOldest = activeDateKey !== null && activeDateKey === availableDateKeys[availableDateKeys.length - 1];
  const prevDisabled = !hasKeys || isAtOldest;
  const nextDisabled = !hasKeys || activeDateKey === null;

  return (
    <div className="day-navigator" data-testid="day-navigator">
      <button
        className="day-navigator__btn"
        onClick={onPrev}
        disabled={prevDisabled}
        title="Previous day"
        aria-label="Previous day"
        type="button"
      >
        ←
      </button>

      <button
        className={`day-navigator__label${!activeDateKey ? ' day-navigator__label--all' : ''}`}
        onClick={onReset}
        title={!activeDateKey ? 'Showing all sessions' : 'Click to show all sessions'}
        aria-label={!activeDateKey ? 'All sessions — click to clear date filter' : `${label} — click to clear date filter`}
        type="button"
      >
        {label}
      </button>

      <button
        className="day-navigator__btn"
        onClick={onNext}
        disabled={nextDisabled}
        title="Next day"
        aria-label="Next day"
        type="button"
      >
        →
      </button>
    </div>
  );
}
