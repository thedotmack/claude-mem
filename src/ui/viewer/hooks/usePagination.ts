import { useState, useEffect, useCallback } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';

interface PaginationState {
  isLoading: boolean;
  hasMore: boolean;
}

type DataType = 'observations' | 'summaries' | 'prompts';
type DataItem = Observation | Summary | UserPrompt;

/**
 * Generic pagination hook for observations, summaries, and prompts
 */
function usePaginationFor(endpoint: string, dataType: DataType, currentFilter: string) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });
  const [offset, setOffset] = useState(0);

  // Reset pagination when filter changes
  useEffect(() => {
    setOffset(0);
    setState({
      isLoading: false,
      hasMore: true
    });
  }, [currentFilter]);

  /**
   * Load more items from the API
   */
  const loadMore = useCallback(async (): Promise<DataItem[]> => {
    // Prevent concurrent requests using state
    if (state.isLoading || !state.hasMore) {
      return [];
    }

    setState(prev => ({ ...prev, isLoading: true }));

    try {
      // Build query params
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: UI.PAGINATION_PAGE_SIZE.toString()
      });

      // Add project filter if present
      if (currentFilter) {
        params.append('project', currentFilter);
      }

      const response = await fetch(`${endpoint}?${params}`);

      if (!response.ok) {
        throw new Error(`Failed to load ${dataType}: ${response.statusText}`);
      }

      const data = await response.json();

      setState(prev => ({
        ...prev,
        isLoading: false,
        hasMore: data.hasMore
      }));

      setOffset(prev => prev + UI.PAGINATION_PAGE_SIZE);
      return data.items as DataItem[];
    } catch (error) {
      console.error(`Failed to load ${dataType}:`, error);
      setState(prev => ({ ...prev, isLoading: false }));
      return [];
    }
  }, [offset, state.hasMore, state.isLoading, currentFilter, endpoint, dataType]);

  return {
    ...state,
    loadMore
  };
}

/**
 * Hook for paginating observations
 */
export function usePagination(currentFilter: string) {
  const observations = usePaginationFor(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter);
  const summaries = usePaginationFor(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter);
  const prompts = usePaginationFor(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter);

  return {
    observations,
    summaries,
    prompts
  };
}
