import React, { useMemo, useImperativeHandle, forwardRef } from 'react';
import { SessionList } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { ActivityBar } from './ActivityBar';
import { DayNavigator, navigateDay } from './DayNavigator';
import { getTodayString } from '../utils/date';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionDetail } from '../hooks/useSessionDetail';
import type { SessionGroup, SessionListItem, Summary, ActivityDay } from '../types';

// ---------------------------------------------------------------------------
// Pure utility (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Finds a session in the groups by its numeric id.
 * Returns the session item or null if not found.
 */
export function findSessionById(
  groups: SessionGroup[],
  id: number | null,
): SessionListItem | null {
  if (id === null) return null;
  for (const group of groups) {
    for (const session of group.sessions) {
      if (session.id === id) return session;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TwoPanelProps {
  project: string;
  newSummary?: Summary | null;
  activityDays: ActivityDay[];
  activityLoading: boolean;
  dateStart: string;
  dateEnd: string;
  onDateRangeSelect: (start: string, end: string) => void;
}

export interface TwoPanelHandle {
  navigateNext: () => void;
  navigatePrev: () => void;
  /** Navigate the day filter by one step. */
  navigateDay: (direction: 'prev' | 'next') => void;
}

export const TwoPanel = forwardRef<TwoPanelHandle, TwoPanelProps>(function TwoPanel({
  project,
  newSummary,
  activityDays,
  activityLoading,
  dateStart,
  dateEnd,
  onDateRangeSelect,
}, ref) {
  const sessionList = useSessionList({ project, newSummary });

  const selectedSession = useMemo(
    () => findSessionById(sessionList.sessionGroups, sessionList.selectedId),
    [sessionList.sessionGroups, sessionList.selectedId],
  );

  const { detail, isLoading: detailLoading } = useSessionDetail(
    selectedSession?.session_id ?? null,
    project,
    selectedSession?.id ?? null,
  );

  function handleDayNavigate(direction: 'prev' | 'next'): void {
    const today = getTodayString();
    const newDate = navigateDay(dateStart, direction, today);
    onDateRangeSelect(newDate, newDate);
  }

  function handleDayNavigatorNavigate(date: string): void {
    onDateRangeSelect(date, date);
  }

  function handleDayNavigatorReset(): void {
    onDateRangeSelect('', '');
  }

  useImperativeHandle(ref, () => ({
    navigateNext: sessionList.navigateNext,
    navigatePrev: sessionList.navigatePrev,
    navigateDay: handleDayNavigate,
  }), [sessionList.navigateNext, sessionList.navigatePrev, dateStart, onDateRangeSelect]);

  return (
    <div className="two-panel" data-testid="two-panel">
      <aside className="two-panel__left" data-testid="two-panel-left" aria-label="Session list">
        <DayNavigator
          dateStart={dateStart}
          dateEnd={dateEnd}
          onNavigate={handleDayNavigatorNavigate}
          onReset={handleDayNavigatorReset}
        />
        <SessionList
          sessionGroups={sessionList.sessionGroups}
          selectedId={sessionList.selectedId}
          onSelectSession={sessionList.selectSession}
          onLoadMore={sessionList.loadMore}
          hasMore={sessionList.hasMore}
          isLoading={sessionList.isLoading}
        />
        <div className="two-panel__activity" data-testid="two-panel-activity">
          <ActivityBar
            days={activityDays}
            dateStart={dateStart}
            dateEnd={dateEnd}
            onDateRangeSelect={onDateRangeSelect}
            isLoading={activityLoading}
          />
        </div>
      </aside>
      <main className="two-panel__right" data-testid="two-panel-right" aria-label="Session detail">
        <SessionDetail
          detail={detail}
          isLoading={detailLoading}
          hasSelection={sessionList.selectedId !== null}
        />
      </main>
    </div>
  );
});
