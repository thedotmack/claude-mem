import { useState, useCallback, useRef } from 'react';
import type { Observation, Summary, UserPrompt } from '../types';
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
function usePaginationFor(endpoint: string, dataType: DataType, currentFilter: string, resetKey: number) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });

  // Track offset and filter in refs to handle synchronous resets
  const offsetRef = useRef(0);
  const lastFilterRef = useRef(currentFilter);
  const lastResetKeyRef = useRef(resetKey);
  const stateRef = useRef(state);

  /**
   * Load more items from the API
   * Automatically resets offset to 0 if filter or resetKey has changed
   */
  const loadMore = useCallback(async (): Promise<DataItem[]> => {
    // Check if filter or reset key changed - if so, reset pagination synchronously
    const filterChanged = lastFilterRef.current !== currentFilter || lastResetKeyRef.current !== resetKey;

    if (filterChanged) {
      offsetRef.current = 0;
      lastFilterRef.current = currentFilter;
      lastResetKeyRef.current = resetKey;

      // Reset state both in React state and ref synchronously
      const newState = { isLoading: false, hasMore: true };
      setState(newState);
      stateRef.current = newState;  // Update ref immediately to avoid stale checks
    }

    // Prevent concurrent requests using ref (always current)
    // Skip this check if we just reset the filter - we want to load the first page
    if (!filterChanged && (stateRef.current.isLoading || !stateRef.current.hasMore)) {
      return [];
    }

    setState(prev => ({ ...prev, isLoading: true }));

    // Build query params using current offset from ref
    const params = new URLSearchParams({
      offset: offsetRef.current.toString(),
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

    const data = await response.json() as { items: DataItem[], hasMore: boolean };

    setState(prev => ({
      ...prev,
      isLoading: false,
      hasMore: data.hasMore
    }));

    // Increment offset after successful load
    offsetRef.current += UI.PAGINATION_PAGE_SIZE;

    return data.items;
  }, [currentFilter, endpoint, dataType, resetKey]);

  return {
    ...state,
    loadMore
  };
}

/**
 * Hook for paginating observations
 */
export function usePagination(currentFilter: string, resetKey: number) {
  const observations = usePaginationFor(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, resetKey);
  const summaries = usePaginationFor(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter, resetKey);
  const prompts = usePaginationFor(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter, resetKey);

  return {
    observations,
    summaries,
    prompts
  };
}
