import { useState, useCallback, useMemo, useRef } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';

type DataItem = Observation | Summary | UserPrompt;

interface PaginationState {
  offset: number;
  isLoading: boolean;
  hasMore: boolean;
  error?: string;
}

const INITIAL_STATE: PaginationState = {
  offset: 0,
  isLoading: false,
  hasMore: true,
  error: undefined
};

/**
 * Generic pagination hook with automatic filter reset
 */
function usePaginationFor(endpoint: string, filter: string) {
  const [state, setState] = useState<PaginationState>(INITIAL_STATE);

  // Reset pagination when filter changes
  const prevFilterRef = useRef(filter);
  
  const currentState = useMemo(() => {
    if (prevFilterRef.current !== filter) {
      prevFilterRef.current = filter;
      setState(INITIAL_STATE);
      return INITIAL_STATE;
    }
    return state;
  }, [state, filter]);

  const loadMore = useCallback(async (): Promise<DataItem[]> => {
    if (currentState.isLoading || !currentState.hasMore) {
      return [];
    }

    setState(prev => ({ ...prev, isLoading: true, error: undefined }));

    try {
      const params = new URLSearchParams({
        offset: currentState.offset.toString(),
        limit: UI.PAGINATION_PAGE_SIZE.toString(),
        ...(filter && { project: filter })
      });

      const response = await fetch(`${endpoint}?${params}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { items: DataItem[], hasMore: boolean };

      setState(prev => ({
        ...prev,
        offset: prev.offset + UI.PAGINATION_PAGE_SIZE,
        isLoading: false,
        hasMore: data.hasMore
      }));

      return data.items;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({ 
        ...prev, 
        isLoading: false, 
        error: errorMessage 
      }));
      return [];
    }
  }, [endpoint, filter, currentState.offset, currentState.isLoading, currentState.hasMore]);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    ...currentState,
    loadMore,
    reset
  };
}

export function usePagination(filter: string) {
  return {
    observations: usePaginationFor(API_ENDPOINTS.OBSERVATIONS, filter),
    summaries: usePaginationFor(API_ENDPOINTS.SUMMARIES, filter),
    prompts: usePaginationFor(API_ENDPOINTS.PROMPTS, filter)
  };
}