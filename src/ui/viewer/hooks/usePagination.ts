import { useState, useCallback, useRef } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';
import { sessionKey, type SessionRef } from '../utils/sessions';

interface PaginationState {
  isLoading: boolean;
  hasMore: boolean;
}

type DataType = 'observations' | 'summaries' | 'prompts';
type DataItem = Observation | Summary | UserPrompt;

function usePaginationFor<TItem extends DataItem>(
  endpoint: string,
  dataType: DataType,
  currentFilter: string,
  currentSession: SessionRef | null
) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });

  const selectionKey = `${currentFilter}|${currentSession ? sessionKey(currentSession) : ''}`;
  const offsetRef = useRef(0);
  const selectionRef = useRef({ key: selectionKey, version: 0 });
  if (selectionRef.current.key !== selectionKey) {
    selectionRef.current = { key: selectionKey, version: selectionRef.current.version + 1 };
  }
  const selectionVersion = selectionRef.current.version;
  const lastLoadedVersionRef = useRef(selectionVersion);
  const stateRef = useRef(state);

  const loadMore = useCallback(async (): Promise<TItem[]> => {
    if (selectionRef.current.version !== selectionVersion) return [];
    const selectionChanged = lastLoadedVersionRef.current !== selectionVersion;

    if (selectionChanged) {
      offsetRef.current = 0;
      lastLoadedVersionRef.current = selectionVersion;

      const newState = { isLoading: false, hasMore: true };
      setState(newState);
      stateRef.current = newState;
    }

    if (!selectionChanged && (stateRef.current.isLoading || !stateRef.current.hasMore)) {
      return [];
    }

    stateRef.current = { ...stateRef.current, isLoading: true };
    setState(prev => ({ ...prev, isLoading: true }));

    const params = new URLSearchParams({
      offset: offsetRef.current.toString(),
      limit: UI.PAGINATION_PAGE_SIZE.toString()
    });

    if (currentFilter) {
      params.append('project', currentFilter);
    }
    if (currentSession) {
      // Both halves of the session identity: the same content session id can
      // exist under two platforms.
      params.append('contentSessionId', currentSession.contentSessionId);
      params.append('platformSource', currentSession.platformSource);
    }

    // Each visit owns its cursor and loading state. Returning to the same
    // project or session must not revive requests from its previous visit.
    const isStale = () => selectionRef.current.version !== selectionVersion;

    try {
      const response = await fetch(`${endpoint}?${params}`);
      if (isStale()) return [];

      if (!response.ok) {
        throw new Error(`Failed to load ${dataType}: ${response.statusText}`);
      }

      const data = await response.json() as { items: TItem[], hasMore: boolean };
      if (isStale()) return [];

      const nextState = {
        ...stateRef.current,
        isLoading: false,
        hasMore: data.hasMore
      };
      stateRef.current = nextState;

      setState(prev => ({
        ...prev,
        isLoading: false,
        hasMore: data.hasMore
      }));

      offsetRef.current += UI.PAGINATION_PAGE_SIZE;

      return data.items;
    } finally {
      // The loading flag belongs to this request, even when fetch/JSON fails.
      // Do not release loading for a different current selection.
      if (!isStale() && stateRef.current.isLoading) {
        stateRef.current = { ...stateRef.current, isLoading: false };
        setState(prev => ({ ...prev, isLoading: false }));
      }
    }
    // selectionKey covers currentFilter and currentSession.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, selectionVersion, endpoint, dataType]);

  // Rows from a loaded page were deleted: the server's list moved up by that
  // many, so the next page starts that much earlier or it would skip rows.
  const noteRemoved = useCallback((count: number = 1) => {
    offsetRef.current = Math.max(0, offsetRef.current - count);
  }, []);

  return {
    ...state,
    loadMore,
    noteRemoved
  };
}

export function usePagination(currentFilter: string, currentSession: SessionRef | null = null) {
  const observations = usePaginationFor<Observation>(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, currentSession);
  const summaries = usePaginationFor<Summary>(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter, currentSession);
  const prompts = usePaginationFor<UserPrompt>(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter, currentSession);

  return {
    observations,
    summaries,
    prompts
  };
}
