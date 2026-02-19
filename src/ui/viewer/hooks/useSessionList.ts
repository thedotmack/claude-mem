import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Summary, SessionListItem, SessionGroup } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────
// Pure utility functions (exported for unit testing)
// ─────────────────────────────────────────────────────────

const SESSION_LIST_LIMIT = 50;

/**
 * Returns the local date string "YYYY-MM-DD" for a given epoch (ms).
 * Uses local time so that "Today" / "Yesterday" match the user's timezone.
 */
function epochToLocalDateKey(epoch: number): string {
  const d = new Date(epoch);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the local date key for today ("YYYY-MM-DD").
 */
function todayKey(): string {
  return epochToLocalDateKey(Date.now());
}

/**
 * Returns the local date key for yesterday ("YYYY-MM-DD").
 */
function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return epochToLocalDateKey(d.getTime());
}

/**
 * Formats a date key like "2026-02-15" to a short label like "Feb 15".
 */
function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Returns a human-friendly group label for a given dateKey.
 * "Today", "Yesterday", or "Feb 15" style.
 */
function dateKeyToLabel(dateKey: string): string {
  const today = todayKey();
  const yesterday = yesterdayKey();
  if (dateKey === today) return 'Today';
  if (dateKey === yesterday) return 'Yesterday';
  return formatDateLabel(dateKey);
}

/**
 * Maps a Summary to a SessionListItem.
 *
 * When `observationCountOverride` is provided it is used in place of
 * `summary.observation_count`.  This is needed for SSE-delivered summaries
 * whose payload does not carry an `observation_count` field — in that case the
 * caller can supply the count derived from the in-memory SSE observations array
 * so the session list item shows a non-zero count immediately.
 */
export function mapSummaryToSessionListItem(summary: Summary, observationCountOverride?: number): SessionListItem {
  return {
    id: summary.id,
    session_id: summary.session_id,
    project: summary.project,
    request: summary.request,
    observationCount: summary.observation_count ?? observationCountOverride ?? 0,
    created_at_epoch: summary.created_at_epoch,
    status: 'completed',
  };
}

/**
 * Groups a flat list of SessionListItems into day-based SessionGroups.
 * Preserves insertion order within each group.
 */
export function groupSessionsByDay(items: SessionListItem[]): SessionGroup[] {
  const groupMap = new Map<string, SessionGroup>();
  const order: string[] = [];

  for (const item of items) {
    const dateKey = epochToLocalDateKey(item.created_at_epoch);
    if (!groupMap.has(dateKey)) {
      groupMap.set(dateKey, {
        label: dateKeyToLabel(dateKey),
        dateKey,
        sessions: [],
      });
      order.push(dateKey);
    }
    groupMap.get(dateKey)!.sessions.push(item);
  }

  // Sort groups by dateKey descending (newest first) to ensure correct
  // chronological order even when loadForDate inserts groups out-of-order.
  return order.map(key => groupMap.get(key)!).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

/**
 * Converts an array of Summary objects into grouped SessionGroups.
 */
export function buildSessionGroups(summaries: Summary[]): SessionGroup[] {
  const items = summaries.map(mapSummaryToSessionListItem);
  return groupSessionsByDay(items);
}

interface FetchSessionPageOptions {
  offset: number;
  limit: number;
  project: string;
}

interface FetchSessionPageResult {
  items: SessionListItem[];
  hasMore: boolean;
}

/**
 * Fetches a page of sessions from the summaries API endpoint.
 * Exported for unit testing.
 */
export async function fetchSessionPage(opts: FetchSessionPageOptions): Promise<FetchSessionPageResult> {
  const params = new URLSearchParams({
    offset: opts.offset.toString(),
    limit: opts.limit.toString(),
  });

  if (opts.project) {
    params.set('project', opts.project);
  }

  const response = await fetch(`${API_ENDPOINTS.SUMMARIES}?${params}`);

  if (!response.ok) {
    throw new Error(`Failed to load sessions: ${response.statusText}`);
  }

  const data = await response.json() as {
    items: Summary[];
    hasMore: boolean;
    offset: number;
    limit: number;
  };

  return {
    items: data.items.map(mapSummaryToSessionListItem),
    hasMore: data.hasMore,
  };
}

/**
 * Prepends a new Summary to the existing session groups.
 * If the summary belongs to an existing day group, it is inserted at the front of that group.
 * If not, a new group is created and inserted at the front of the groups array.
 *
 * `sseObservationCount` is used as a fallback when `summary.observation_count` is absent
 * (e.g. for SSE-delivered summaries whose payload omits that field).
 *
 * Exported for unit testing.
 */
export function prependSession(groups: SessionGroup[], summary: Summary, sseObservationCount?: number): SessionGroup[] {
  const item = mapSummaryToSessionListItem(summary, sseObservationCount);
  const dateKey = epochToLocalDateKey(item.created_at_epoch);

  const existingIndex = groups.findIndex(g => g.dateKey === dateKey);

  if (existingIndex !== -1) {
    return groups.map((g, i) => {
      if (i !== existingIndex) return g;
      return { ...g, sessions: [item, ...g.sessions] };
    });
  }

  const newGroup: SessionGroup = {
    label: dateKeyToLabel(dateKey),
    dateKey,
    sessions: [item],
  };

  return [newGroup, ...groups];
}

/**
 * Computes the day after a given YYYY-MM-DD date string.
 * Uses local calendar arithmetic to handle month/year rollovers.
 * Exported for unit testing.
 */
export function nextDayString(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const d = new Date(year, month - 1, day + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Fetches sessions for a specific date by querying the search API.
 * Returns SessionListItems mapped from the search response summaries.
 *
 * Note: The search API's date filter converts YYYY-MM-DD strings to UTC
 * midnight epoch, so dateEnd must be the *next* day to cover the full 24h
 * window.  The search API returns `memory_session_id` (from session_summaries
 * table), so we map it to `session_id` expected by the viewer types.
 *
 * Exported for unit testing.
 */
export async function fetchSessionsByDate(dateKey: string, project: string): Promise<SessionListItem[]> {
  const params = new URLSearchParams({
    dateStart: dateKey,
    dateEnd: nextDayString(dateKey),
    format: 'json',
    type: 'sessions',
  });
  if (project) {
    params.set('project', project);
  }

  const response = await fetch(`${API_ENDPOINTS.SEARCH}?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to load sessions for date ${dateKey}: ${response.statusText}`);
  }

  interface SearchSessionResult {
    id: number;
    memory_session_id: string;
    session_id?: string;
    project: string;
    request: string | null;
    created_at_epoch: number;
    observation_count?: number;
  }

  const data = await response.json() as {
    sessions: SearchSessionResult[];
    observations: unknown[];
    prompts: unknown[];
    totalResults: number;
    query: string;
  };

  return data.sessions.map(s => ({
    id: s.id,
    session_id: s.session_id ?? s.memory_session_id,
    project: s.project,
    request: s.request ?? undefined,
    observationCount: s.observation_count ?? 0,
    created_at_epoch: s.created_at_epoch,
    status: 'completed' as const,
  }));
}

// ─────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────

interface UseSessionListOptions {
  /** Current project filter. Re-fetches and resets pagination when changed. */
  project: string;
  /** New summary from SSE to prepend to the list. */
  newSummary?: Summary | null;
}

interface UseSessionListResult {
  sessionGroups: SessionGroup[];
  isLoading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Load sessions for a specific date if not already present in groups. Returns true if sessions were found. */
  loadForDate: (dateKey: string) => Promise<boolean>;
  selectedId: number | null;
  selectSession: (id: number) => void;
  navigateNext: () => void;
  navigatePrev: () => void;
}

export function useSessionList({ project, newSummary }: UseSessionListOptions): UseSessionListResult {
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const offsetRef = useRef(0);
  const lastProjectRef = useRef(project);
  const isLoadingRef = useRef(false);
  const sessionGroupsRef = useRef(sessionGroups);

  const loadPage = useCallback(async (reset: boolean): Promise<void> => {
    if (isLoadingRef.current) return;

    isLoadingRef.current = true;
    setIsLoading(true);

    try {
      const offset = reset ? 0 : offsetRef.current;
      const result = await fetchSessionPage({ offset, limit: SESSION_LIST_LIMIT, project });

      setSessionGroups(prev => {
        const allItems = reset
          ? result.items
          : [...prev.flatMap(g => g.sessions), ...result.items];
        return groupSessionsByDay(allItems);
      });

      setHasMore(result.hasMore);
      offsetRef.current = offset + result.items.length;
    } catch (error) {
      logger.error('sessionList', 'Failed to load sessions');
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
    }
  }, [project]);

  // Initial load and re-fetch when project filter changes
  useEffect(() => {
    const projectChanged = lastProjectRef.current !== project;
    lastProjectRef.current = project;

    if (projectChanged) {
      offsetRef.current = 0;
      setSelectedId(null);
    }

    void loadPage(true);
  }, [project, loadPage]);

  // React to new_summary SSE events
  useEffect(() => {
    if (!newSummary) return;
    setSessionGroups(prev => prependSession(prev, newSummary));
    setSelectedId(current => current === null ? newSummary.id : current);
    // SSE-delivered summaries omit `observation_count`.  Reload the first page
    // immediately after prepending so the DB-computed count replaces the
    // placeholder 0 shown while the prepended item is live.
    if (newSummary.observation_count === undefined) {
      void loadPage(true);
    }
  }, [newSummary, loadPage]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (isLoading || !hasMore) return;
    await loadPage(false);
  }, [isLoading, hasMore, loadPage]);

  const selectSession = useCallback((id: number): void => {
    setSelectedId(id);
  }, []);

  const flatSessions = useMemo(
    () => sessionGroups.flatMap(g => g.sessions),
    [sessionGroups],
  );

  const navigateNext = useCallback((): void => {
    if (flatSessions.length === 0) return;
    if (selectedId === null || selectedId === -1) {
      // From no selection or active session → first real session
      setSelectedId(flatSessions[0].id);
      return;
    }
    const currentIndex = flatSessions.findIndex(s => s.id === selectedId);
    if (currentIndex === -1 || currentIndex >= flatSessions.length - 1) return;
    setSelectedId(flatSessions[currentIndex + 1].id);
  }, [flatSessions, selectedId]);

  const navigatePrev = useCallback((): void => {
    if (flatSessions.length === 0) return;
    if (selectedId === null) {
      setSelectedId(flatSessions[flatSessions.length - 1].id);
      return;
    }
    const currentIndex = flatSessions.findIndex(s => s.id === selectedId);
    if (currentIndex <= 0) {
      // At first real session → go to active session if it exists
      setSelectedId(-1);
      return;
    }
    setSelectedId(flatSessions[currentIndex - 1].id);
  }, [flatSessions, selectedId]);

  // Keep ref in sync so loadForDate avoids stale closure over sessionGroups
  useEffect(() => { sessionGroupsRef.current = sessionGroups; }, [sessionGroups]);

  const loadForDate = useCallback(async (dateKey: string): Promise<boolean> => {
    // Use ref to check latest groups without capturing state in deps
    const exists = sessionGroupsRef.current.some(g => g.dateKey === dateKey);
    if (exists) return true;

    try {
      const items = await fetchSessionsByDate(dateKey, project);
      if (items.length === 0) return false;

      setSessionGroups(prev => {
        // Double-check after async gap
        if (prev.some(g => g.dateKey === dateKey)) return prev;
        const allItems = [...prev.flatMap(g => g.sessions), ...items];
        return groupSessionsByDay(allItems);
      });
      return true;
    } catch (error) {
      logger.error('sessionList', `Failed to load sessions for date ${dateKey}`);
      return false;
    }
  }, [project]);

  return {
    sessionGroups,
    isLoading,
    hasMore,
    loadMore,
    loadForDate,
    selectedId,
    selectSession,
    navigateNext,
    navigatePrev,
  };
}
