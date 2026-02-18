import React, { useState, useMemo, useEffect, useImperativeHandle, forwardRef, useRef, useCallback } from 'react';
import { SessionList } from './SessionList';
import type { SessionListHandle } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { ActivityBar } from './ActivityBar';
import { DayNavigator } from './DayNavigator';
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
  /** Session ID of an active (unsummarized) session from SSE, or null. */
  activeSessionId?: string | null;
  /** Observation count for the active session. */
  activeSessionObsCount?: number;
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
  activeSessionId,
  activeSessionObsCount,
}, ref) {
  const sessionList = useSessionList({ project, newSummary });
  const sessionListRef = useRef<SessionListHandle>(null);
  const [activeDateKey, setActiveDateKey] = useState<string | null>(null);

  // Available date keys from session groups (newest first)
  const availableDateKeys = useMemo(
    () => sessionList.sessionGroups.map(g => g.dateKey),
    [sessionList.sessionGroups],
  );

  // Build session groups with synthetic active session (Task #62)
  const sessionGroupsWithActive = useMemo(() => {
    if (!activeSessionId) return sessionList.sessionGroups;

    // Check if active session already has a summary in groups
    const exists = sessionList.sessionGroups.some(g =>
      g.sessions.some(s => s.session_id === activeSessionId)
    );
    if (exists) return sessionList.sessionGroups;

    const syntheticSession: SessionListItem = {
      id: -1,
      session_id: activeSessionId,
      project: project || '',
      request: undefined,
      observationCount: activeSessionObsCount ?? 0,
      created_at_epoch: Date.now(),
      status: 'active',
    };

    const todayKey = getTodayString();
    const todayGroupIndex = sessionList.sessionGroups.findIndex(g => g.dateKey === todayKey);

    if (todayGroupIndex !== -1) {
      return sessionList.sessionGroups.map((g, i) => {
        if (i !== todayGroupIndex) return g;
        return { ...g, sessions: [syntheticSession, ...g.sessions] };
      });
    }

    return [
      { label: 'Today', dateKey: todayKey, sessions: [syntheticSession] },
      ...sessionList.sessionGroups,
    ];
  }, [sessionList.sessionGroups, activeSessionId, activeSessionObsCount, project]);

  const selectedSession = useMemo(
    () => findSessionById(sessionGroupsWithActive, sessionList.selectedId),
    [sessionGroupsWithActive, sessionList.selectedId],
  );

  const { detail, isLoading: detailLoading } = useSessionDetail(
    selectedSession?.session_id ?? null,
    project,
    selectedSession?.id ?? null,
  );

  // Scroll selected session into view when it changes (Task #61)
  useEffect(() => {
    if (sessionList.selectedId !== null) {
      sessionListRef.current?.scrollToSession(sessionList.selectedId);
    }
  }, [sessionList.selectedId]);

  // Auto-select active session if nothing is selected (Task #62)
  useEffect(() => {
    if (activeSessionId && sessionList.selectedId === null) {
      sessionList.selectSession(-1);
    }
  }, [activeSessionId, sessionList.selectedId, sessionList.selectSession]);

  // Day navigation handlers (Task #60 — scroll-based, not filter-based)
  const handleDayPrev = useCallback((): void => {
    if (availableDateKeys.length === 0) return;
    if (activeDateKey === null) {
      // Start from the newest date
      setActiveDateKey(availableDateKeys[0]);
      sessionListRef.current?.scrollToDate(availableDateKeys[0]);
      return;
    }
    const currentIndex = availableDateKeys.indexOf(activeDateKey);
    if (currentIndex === -1 || currentIndex >= availableDateKeys.length - 1) return;
    const nextKey = availableDateKeys[currentIndex + 1];
    setActiveDateKey(nextKey);
    sessionListRef.current?.scrollToDate(nextKey);
  }, [availableDateKeys, activeDateKey]);

  const handleDayNext = useCallback((): void => {
    if (availableDateKeys.length === 0 || activeDateKey === null) return;
    const currentIndex = availableDateKeys.indexOf(activeDateKey);
    if (currentIndex <= 0) {
      // Back to "All sessions" — scroll to top
      setActiveDateKey(null);
      sessionListRef.current?.scrollToDate(availableDateKeys[0]);
      return;
    }
    const nextKey = availableDateKeys[currentIndex - 1];
    setActiveDateKey(nextKey);
    sessionListRef.current?.scrollToDate(nextKey);
  }, [availableDateKeys, activeDateKey]);

  const handleDayReset = useCallback((): void => {
    setActiveDateKey(null);
    if (availableDateKeys.length > 0) {
      sessionListRef.current?.scrollToDate(availableDateKeys[0]);
    }
  }, [availableDateKeys]);

  useImperativeHandle(ref, () => ({
    navigateNext: sessionList.navigateNext,
    navigatePrev: sessionList.navigatePrev,
    navigateDay: (direction: 'prev' | 'next') => {
      if (direction === 'prev') handleDayPrev();
      else handleDayNext();
    },
  }), [sessionList.navigateNext, sessionList.navigatePrev, handleDayPrev, handleDayNext]);

  return (
    <div className="two-panel" data-testid="two-panel">
      <aside className="two-panel__left" data-testid="two-panel-left" aria-label="Session list">
        <DayNavigator
          availableDateKeys={availableDateKeys}
          activeDateKey={activeDateKey}
          onPrev={handleDayPrev}
          onNext={handleDayNext}
          onReset={handleDayReset}
        />
        <SessionList
          ref={sessionListRef}
          sessionGroups={sessionGroupsWithActive}
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
