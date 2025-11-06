import { useState, useEffect, useCallback, useRef } from 'react';
import { Observation } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';

interface PaginationState {
  isLoading: boolean;
  hasMore: boolean;
}

export function usePagination() {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });
  const [offset, setOffset] = useState(0);

  /**
   * Load more observations from the API
   */
  const loadMore = useCallback(async (): Promise<Observation[]> => {
    // Prevent concurrent requests using state
    if (state.isLoading || !state.hasMore) {
      return [];
    }

    setState(prev => ({ ...prev, isLoading: true }));

    try {
      const response = await fetch(`${API_ENDPOINTS.OBSERVATIONS}?offset=${offset}&limit=${UI.PAGINATION_PAGE_SIZE}`);

      if (!response.ok) {
        throw new Error(`Failed to load observations: ${response.statusText}`);
      }

      const data = await response.json();

      setState(prev => ({
        ...prev,
        isLoading: false,
        hasMore: data.hasMore
      }));

      setOffset(prev => prev + UI.PAGINATION_PAGE_SIZE);
      return data.observations as Observation[];
    } catch (error) {
      console.error('Failed to load observations:', error);
      setState(prev => ({ ...prev, isLoading: false }));
      return [];
    }
  }, [offset, state.hasMore, state.isLoading]);

  return {
    ...state,
    loadMore
  };
}
