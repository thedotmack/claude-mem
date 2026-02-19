import React, { useState, useCallback, useMemo } from 'react';
import { CalendarPicker } from './CalendarPicker';
import type { ActivityDay } from '../types';
import { getTodayString, toLocalDateKey } from '../utils/date';

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
  return toLocalDateKey(new Date(year, month - 1, day + days));
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
  /** The currently active/visible date key, or null when not yet initialized. */
  activeDateKey: string | null;
  /** Navigate to the previous (older) day. */
  onPrev: () => void;
  /** Navigate to the next (newer) day. */
  onNext: () => void;
  /** Today's date in YYYY-MM-DD format. Defaults to the current local date. */
  today?: string;
  /** Activity days for the calendar picker. */
  activityDays?: ActivityDay[];
  /** Callback when a date is selected from the calendar. */
  onSelectDate?: (dateKey: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * DayNavigator renders a compact [←] label [→] row for day-by-day
 * scroll navigation between available session groups.
 * Clicking the label opens the calendar picker.
 */
export function DayNavigator({
  availableDateKeys,
  activeDateKey,
  onPrev,
  onNext,
  today,
  activityDays,
  onSelectDate,
}: DayNavigatorProps): React.ReactElement {
  const resolvedToday = useMemo(() => today ?? getTodayString(), [today]);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const label = activeDateKey
    ? formatDayLabel(activeDateKey, '', resolvedToday)
    : 'Today';

  const hasKeys = availableDateKeys.length > 0;
  const isAtOldest = activeDateKey !== null && activeDateKey === availableDateKeys[availableDateKeys.length - 1];
  const isAtNewest = !activeDateKey || activeDateKey === availableDateKeys[0];
  const prevDisabled = !hasKeys || isAtOldest;
  const nextDisabled = !hasKeys || isAtNewest;

  const handleLabelClick = useCallback(() => {
    setCalendarOpen(prev => !prev);
  }, []);

  const handleCalendarSelect = useCallback((dateKey: string) => {
    setCalendarOpen(false);
    onSelectDate?.(dateKey);
  }, [onSelectDate]);

  const handleCalendarClose = useCallback(() => {
    setCalendarOpen(false);
  }, []);

  return (
    <div className="day-navigator day-navigator__calendar-wrapper" data-testid="day-navigator">
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
        className="day-navigator__label"
        onClick={handleLabelClick}
        title={`${label} — click to open calendar`}
        aria-label={`${label} — click to open calendar`}
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

      {calendarOpen && activityDays && onSelectDate && (
        <CalendarPicker
          activityDays={activityDays}
          selectedDate={activeDateKey}
          onSelectDate={handleCalendarSelect}
          onClose={handleCalendarClose}
        />
      )}
    </div>
  );
}
