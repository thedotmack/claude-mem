import { useState, useEffect, useCallback, useRef } from 'react';
import { Observation } from '../types';

interface PaginationState {
  isLoading: boolean;
  hasMore: boolean;
  error: string | null;
}

export function usePagination() {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true,
    error: null
  });
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;
  const loadingRef = useRef(false);

  /**
   * Load more observations from the API
   */
  const loadMore = useCallback(async (): Promise<Observation[]> => {
    // Prevent concurrent requests
    if (loadingRef.current || !state.hasMore) {
      return [];
    }

    loadingRef.current = true;
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await fetch(`/api/observations?offset=${offset}&limit=${LIMIT}`);

      if (!response.ok) {
        throw new Error(`Failed to load observations: ${response.statusText}`);
      }

      const data = await response.json();

      setState(prev => ({
        ...prev,
        isLoading: false,
        hasMore: data.hasMore
      }));

      setOffset(prev => prev + LIMIT);
      return data.observations as Observation[];
    } catch (error: any) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to load observations'
      }));
      return [];
    } finally {
      loadingRef.current = false;
    }
  }, [offset, state.hasMore]);

  /**
   * Reset pagination state
   */
  const reset = useCallback(() => {
    setOffset(0);
    setState({
      isLoading: false,
      hasMore: true,
      error: null
    });
    loadingRef.current = false;
  }, []);

  return {
    ...state,
    loadMore,
    reset
  };
}
