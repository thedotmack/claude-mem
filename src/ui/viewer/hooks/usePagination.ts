import { useState, useCallback, useRef } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';
import { authFetch } from '../utils/api';

interface PaginationState {
  isLoading: boolean;
  hasMore: boolean;
}

type DataType = 'observations' | 'summaries' | 'prompts';
type DataItem = Observation | Summary | UserPrompt;

function usePaginationFor<TItem extends DataItem>(endpoint: string, dataType: DataType, currentFilter: string, platformFilter: string) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });

  const offsetRef = useRef(0);
  const lastSelectionRef = useRef(`${currentFilter}|${platformFilter}`);
  const stateRef = useRef(state);

  const loadMore = useCallback(async (): Promise<TItem[]> => {
    const selectionKey = `${currentFilter}|${platformFilter}`;
    const filterChanged = lastSelectionRef.current !== selectionKey;

    if (filterChanged) {
      offsetRef.current = 0;
      lastSelectionRef.current = selectionKey;

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

    if (platformFilter) {
      params.append('platformSource', platformFilter);
    }

    const response = await authFetch(`${endpoint}?${params}`);

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
  }, [currentFilter, platformFilter, endpoint, dataType]);

  return {
    ...state,
    loadMore
  };
}

export function usePagination(currentFilter: string, platformFilter: string = '') {
  const observations = usePaginationFor<Observation>(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, platformFilter);
  const summaries = usePaginationFor<Summary>(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter, platformFilter);
  const prompts = usePaginationFor<UserPrompt>(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter, platformFilter);

  return {
    observations,
    summaries,
    prompts
  };
}
