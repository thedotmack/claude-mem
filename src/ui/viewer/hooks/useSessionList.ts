import { useState, useCallback, useRef, useEffect } from 'react';
import type { Summary, SessionListItem, SessionGroup } from '../types';
import { API_ENDPOINTS } from '../constants/api';

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
 * observationCount is hardcoded to 0 until a count endpoint is available.
 */
export function mapSummaryToSessionListItem(summary: Summary): SessionListItem {
  return {
    id: summary.id,
    session_id: summary.session_id,
    project: summary.project,
    request: summary.request,
    observationCount: 0,
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

  return order.map(key => groupMap.get(key)!);
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
 * Exported for unit testing.
 */
export function prependSession(groups: SessionGroup[], summary: Summary): SessionGroup[] {
  const item = mapSummaryToSessionListItem(summary);
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
        return buildSessionGroups(allItems);
      });

      setHasMore(result.hasMore);
      offsetRef.current = offset + result.items.length;

      if (reset && result.items.length > 0) {
        setSelectedId(current => current === null ? result.items[0].id : current);
      }
    } catch (error) {
      console.error('[useSessionList] Failed to load sessions:', error);
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
  }, [newSummary]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (isLoading || !hasMore) return;
    await loadPage(false);
  }, [isLoading, hasMore, loadPage]);

  const selectSession = useCallback((id: number): void => {
    setSelectedId(id);
  }, []);

  const navigateNext = useCallback((): void => {
    const flatSessions = sessionGroups.flatMap(g => g.sessions);
    if (flatSessions.length === 0) return;
    if (selectedId === null) {
      setSelectedId(flatSessions[0].id);
      return;
    }
    const currentIndex = flatSessions.findIndex(s => s.id === selectedId);
    if (currentIndex === -1 || currentIndex >= flatSessions.length - 1) return;
    setSelectedId(flatSessions[currentIndex + 1].id);
  }, [sessionGroups, selectedId]);

  const navigatePrev = useCallback((): void => {
    const flatSessions = sessionGroups.flatMap(g => g.sessions);
    if (flatSessions.length === 0) return;
    if (selectedId === null) {
      setSelectedId(flatSessions[flatSessions.length - 1].id);
      return;
    }
    const currentIndex = flatSessions.findIndex(s => s.id === selectedId);
    if (currentIndex <= 0) return;
    setSelectedId(flatSessions[currentIndex - 1].id);
  }, [sessionGroups, selectedId]);

  return {
    sessionGroups,
    isLoading,
    hasMore,
    loadMore,
    selectedId,
    selectSession,
    navigateNext,
    navigatePrev,
  };
}
