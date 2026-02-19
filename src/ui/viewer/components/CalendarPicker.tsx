import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ActivityDay } from '../types';
import { getTodayString } from '../utils/date';

// ---------------------------------------------------------------------------
// Pure functions (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Returns the number of days in a month.
 * @param year  Full year (e.g. 2026)
 * @param month Zero-based month (0 = January, 11 = December)
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export interface CalendarCell {
  date: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
}

/**
 * Builds a 6×7 calendar grid (weeks start Monday).
 * @param year  Full year
 * @param month Zero-based month
 */
export function buildMonthGrid(year: number, month: number): CalendarCell[][] {
  const daysInMonth = getDaysInMonth(year, month);

  // Day of week for the 1st (0=Sun, 1=Mon, ..., 6=Sat)
  const firstDow = new Date(year, month, 1).getDay();
  // Convert to Monday-start: Mon=0, Tue=1, ..., Sun=6
  const mondayOffset = firstDow === 0 ? 6 : firstDow - 1;

  const grid: CalendarCell[][] = [];
  let currentDate = new Date(year, month, 1 - mondayOffset);

  for (let week = 0; week < 6; week++) {
    const row: CalendarCell[] = [];
    for (let day = 0; day < 7; day++) {
      const y = currentDate.getFullYear();
      const m = String(currentDate.getMonth() + 1).padStart(2, '0');
      const d = String(currentDate.getDate()).padStart(2, '0');
      row.push({
        date: `${y}-${m}-${d}`,
        dayOfMonth: currentDate.getDate(),
        isCurrentMonth: currentDate.getMonth() === month && currentDate.getFullYear() === year,
      });
      currentDate = new Date(y, currentDate.getMonth(), currentDate.getDate() + 1);
    }
    grid.push(row);
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CalendarPickerProps {
  activityDays: ActivityDay[];
  selectedDate: string | null;
  onSelectDate: (dateKey: string) => void;
  onClose: () => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatMonthYear(year: number, month: number): string {
  const d = new Date(year, month, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function CalendarPicker({
  activityDays,
  selectedDate,
  onSelectDate,
  onClose,
}: CalendarPickerProps): React.ReactElement {
  const today = getTodayString();
  const [year, month] = selectedDate
    ? selectedDate.split('-').map(Number)
    : today.split('-').map(Number);
  const [viewYear, setViewYear] = useState(year);
  const [viewMonth, setViewMonth] = useState(month - 1); // Convert to 0-based
  const containerRef = useRef<HTMLDivElement>(null);

  const activitySet = useMemo(
    () => new Set(activityDays.filter(d => d.count > 0).map(d => d.date)),
    [activityDays],
  );
  const grid = buildMonthGrid(viewYear, viewMonth);

  const handlePrevMonth = useCallback(() => {
    setViewMonth(m => {
      if (m === 0) {
        setViewYear(y => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const handleNextMonth = useCallback(() => {
    setViewMonth(m => {
      if (m === 11) {
        setViewYear(y => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    // Use 'click' (not 'mousedown') so the event fires after the parent's
    // onClick toggle — preventing the calendar from re-opening immediately
    // when the user clicks the DayNavigator label to dismiss it.
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div className="calendar-picker" data-testid="calendar-picker" ref={containerRef}>
      <div className="calendar-picker__header">
        <button
          className="calendar-picker__nav-btn"
          onClick={handlePrevMonth}
          aria-label="Previous month"
          type="button"
        >
          &larr;
        </button>
        <span className="calendar-picker__month-label">
          {formatMonthYear(viewYear, viewMonth)}
        </span>
        <button
          className="calendar-picker__nav-btn"
          onClick={handleNextMonth}
          aria-label="Next month"
          type="button"
        >
          &rarr;
        </button>
      </div>

      <div className="calendar-picker__grid" role="grid">
        {WEEKDAYS.map(day => (
          <div key={day} className="calendar-picker__weekday" role="columnheader">
            {day}
          </div>
        ))}

        {grid.flat().map(cell => {
          const hasActivity = activitySet.has(cell.date);
          const isToday = cell.date === today;
          const isSelected = cell.date === selectedDate;
          const isDisabled = !hasActivity;

          const classNames = [
            'calendar-picker__day',
            hasActivity ? 'calendar-picker__day--active' : 'calendar-picker__day--disabled',
            isToday ? 'calendar-picker__day--today' : '',
            isSelected ? 'calendar-picker__day--selected' : '',
            !cell.isCurrentMonth ? 'calendar-picker__day--other-month' : '',
          ].filter(Boolean).join(' ');

          return (
            <button
              key={cell.date}
              className={classNames}
              onClick={() => { if (hasActivity) onSelectDate(cell.date); }}
              disabled={isDisabled}
              aria-label={`${cell.date}${hasActivity ? ' — has activity' : ''}`}
              type="button"
            >
              <span>{cell.dayOfMonth}</span>
              {hasActivity && <span className="calendar-picker__dot" />}
            </button>
          );
        })}
      </div>

      <button
        className="calendar-picker__reset"
        onClick={() => onSelectDate(today)}
        type="button"
      >
        Today
      </button>
    </div>
  );
}
