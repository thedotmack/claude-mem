import React, { useState, useMemo, useEffect, useImperativeHandle, forwardRef, useRef, useCallback } from 'react';
import { SessionList, ActiveSessionRow } from './SessionList';
import type { SessionListHandle, ActiveSessionEntry } from './SessionList';
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
  const sessionGroupsRef = useRef(sessionList.sessionGroups);
  useEffect(() => { sessionGroupsRef.current = sessionList.sessionGroups; }, [sessionList.sessionGroups]);
  const [activeDateKey, setActiveDateKey] = useState<string | null>(getTodayString());
  const [pendingScrollDate, setPendingScrollDate] = useState<string | null>(null);

  // Available date keys from activity days (newest first), fallback to loaded groups
  const availableDateKeys = useMemo(() => {
    const fromActivity = activityDays.filter(d => d.count > 0).map(d => d.date);
    if (fromActivity.length > 0) return fromActivity.sort((a, b) => b.localeCompare(a));
    // Fallback while activity data loads
    return sessionList.sessionGroups.map(g => g.dateKey);
  }, [activityDays, sessionList.sessionGroups]);

  const selectedSession = useMemo(() => {
    // Check if the active session is selected
    if (sessionList.selectedId === -1 && activeSessionId) {
      return {
        id: -1,
        session_id: activeSessionId,
        project: project || '',
        request: undefined,
        observationCount: activeSessionObsCount ?? 0,
        created_at_epoch: Date.now(),
        status: 'active' as const,
      } satisfies SessionListItem;
    }
    return findSessionById(sessionList.sessionGroups, sessionList.selectedId);
  }, [sessionList.sessionGroups, sessionList.selectedId, activeSessionId, activeSessionObsCount, project]);

  // Pass summaryId only for real sessions (id > 0); synthetic active session (id=-1) has no summary
  const summaryId = selectedSession && selectedSession.id > 0 ? selectedSession.id : null;
  const { detail, isLoading: detailLoading } = useSessionDetail(
    selectedSession?.session_id ?? null,
    project,
    summaryId,
  );

  // Active session entry for the fixed top row in SessionList.
  // When detail data is loaded for the active session, use the API's observation
  // count (accurate) instead of the SSE-derived count (which only tracks SSE events).
  const activeSessionEntry: ActiveSessionEntry | null = useMemo(() => {
    if (!activeSessionId) return null;
    const apiObsCount = (sessionList.selectedId === -1 && detail?.observations)
      ? detail.observations.length
      : null;
    return {
      id: -1,
      sessionId: activeSessionId,
      observationCount: apiObsCount ?? activeSessionObsCount ?? 0,
    };
  }, [activeSessionId, activeSessionObsCount, sessionList.selectedId, detail]);

  // Scroll selected session into view when it changes (Task #61)
  useEffect(() => {
    if (sessionList.selectedId !== null) {
      sessionListRef.current?.scrollToSession(sessionList.selectedId);
    }
  }, [sessionList.selectedId]);

  // Auto-select active session when nothing is selected.
  // No fallback to completed sessions — user picks those manually.
  useEffect(() => {
    if (activeSessionId && sessionList.selectedId === null) {
      sessionList.selectSession(-1);
    }
  }, [activeSessionId, sessionList.selectedId, sessionList.selectSession]);

  // Scroll to a pending date once it appears in the rendered groups
  useEffect(() => {
    if (pendingScrollDate === null) return;
    const groupExists = sessionList.sessionGroups.some(g => g.dateKey === pendingScrollDate);
    if (groupExists) {
      sessionListRef.current?.scrollToDate(pendingScrollDate);
      setPendingScrollDate(null);
    }
  }, [pendingScrollDate, sessionList.sessionGroups]);

  // Find the nearest loaded date group to a target date key.
  // Groups are sorted newest-first; prefers the next older date with sessions.
  const findNearestLoadedDate = useCallback((targetDate: string): string | null => {
    const groups = sessionList.sessionGroups;
    if (groups.length === 0) return null;
    // Groups sorted descending — first group with dateKey <= target is the nearest older date
    for (const group of groups) {
      if (group.dateKey <= targetDate) return group.dateKey;
    }
    // All groups are newer — return the oldest (last) group
    return groups[groups.length - 1].dateKey;
  }, [sessionList.sessionGroups]);

  // Scroll to a date immediately if the group is already loaded,
  // otherwise load the data and use pendingScrollDate for async scroll.
  // Falls back to the nearest available date when no sessions exist for the target.
  const scrollOrLoadDate = useCallback((dateKey: string): void => {
    const alreadyLoaded = sessionGroupsRef.current.some(g => g.dateKey === dateKey);
    if (alreadyLoaded) {
      sessionListRef.current?.scrollToDate(dateKey);
    } else {
      // Group not loaded — fetch and defer scroll to the pendingScrollDate effect
      setPendingScrollDate(dateKey);
      void sessionList.loadForDate(dateKey).then((found) => {
        if (!found) {
          // No sessions for this date — scroll to nearest available group instead
          setPendingScrollDate(null);
          const nearest = findNearestLoadedDate(dateKey);
          if (nearest) {
            sessionListRef.current?.scrollToDate(nearest);
          }
        }
        // If found, the pendingScrollDate effect handles the scroll
      });
    }
  }, [sessionList.loadForDate, findNearestLoadedDate]);

  // Day navigation handlers (Task #60 — scroll-based, not filter-based)
  const handleDayPrev = useCallback((): void => {
    if (availableDateKeys.length === 0 || activeDateKey === null) return;
    const currentIndex = availableDateKeys.indexOf(activeDateKey);
    // At oldest date or not found — do nothing (button is disabled)
    if (currentIndex === -1 || currentIndex >= availableDateKeys.length - 1) return;
    const nextKey = availableDateKeys[currentIndex + 1];
    setActiveDateKey(nextKey);
    scrollOrLoadDate(nextKey);
  }, [availableDateKeys, activeDateKey, scrollOrLoadDate]);

  const handleDayNext = useCallback((): void => {
    if (availableDateKeys.length === 0 || activeDateKey === null) return;
    const currentIndex = availableDateKeys.indexOf(activeDateKey);
    // At newest date (index 0) or not found — do nothing (button is disabled)
    if (currentIndex <= 0) return;
    const nextKey = availableDateKeys[currentIndex - 1];
    setActiveDateKey(nextKey);
    scrollOrLoadDate(nextKey);
  }, [availableDateKeys, activeDateKey, scrollOrLoadDate]);

  const handleSelectDate = useCallback((dateKey: string): void => {
    setActiveDateKey(dateKey);
    scrollOrLoadDate(dateKey);
  }, [scrollOrLoadDate]);

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
          activityDays={activityDays}
          onSelectDate={handleSelectDate}
        />
        {activeSessionEntry && (
          <ActiveSessionRow
            entry={activeSessionEntry}
            isSelected={sessionList.selectedId === activeSessionEntry.id}
            onSelect={sessionList.selectSession}
          />
        )}
        <SessionList
          ref={sessionListRef}
          sessionGroups={sessionList.sessionGroups}
          selectedId={sessionList.selectedId}
          onSelectSession={sessionList.selectSession}
          onLoadMore={sessionList.loadMore}
          hasMore={sessionList.hasMore}
          isLoading={sessionList.isLoading}
          activeSession={activeSessionEntry}
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
