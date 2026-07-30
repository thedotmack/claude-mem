import { useState, useCallback, useRef } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';

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
  currentSessionFilter: string
) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });

  const offsetRef = useRef(0);
  const lastSelectionKeyRef = useRef(`${currentFilter} ${currentSessionFilter}`);
  const stateRef = useRef(state);

  const loadMore = useCallback(async (): Promise<TItem[]> => {
    const selectionKey = `${currentFilter} ${currentSessionFilter}`;
    const filterChanged = lastSelectionKeyRef.current !== selectionKey;

    if (filterChanged) {
      offsetRef.current = 0;
      lastSelectionKeyRef.current = selectionKey;

      const newState = { isLoading: false, hasMore: true };
      setState(newState);
      stateRef.current = newState;
    }

    if (!filterChanged && (stateRef.current.isLoading || !stateRef.current.hasMore)) {
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
    if (currentSessionFilter) {
      params.append('contentSessionId', currentSessionFilter);
    }

    const response = await fetch(`${endpoint}?${params}`);

    if (!response.ok) {
      throw new Error(`Failed to load ${dataType}: ${response.statusText}`);
    }

    const data = await response.json() as { items: TItem[], hasMore: boolean };

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
  }, [currentFilter, currentSessionFilter, endpoint, dataType]);

  return {
    ...state,
    loadMore
  };
}

export function usePagination(currentFilter: string, currentSessionFilter: string) {
  const observations = usePaginationFor<Observation>(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, currentSessionFilter);
  const summaries = usePaginationFor<Summary>(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter, currentSessionFilter);
  const prompts = usePaginationFor<UserPrompt>(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter, currentSessionFilter);

  return {
    observations,
    summaries,
    prompts
  };
}
