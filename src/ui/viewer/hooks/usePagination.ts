import { useState, useCallback, useRef } from 'react';
import { Observation, Summary, UserPrompt, OBSERVATION_TYPES } from '../types';
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
 * @param selectedTypes - For observations endpoint, filter by these types (only applied to observations)
 */
function usePaginationFor(
  endpoint: string,
  dataType: DataType,
  currentFilter: string,
  selectedTypes?: string[]
) {
  const [state, setState] = useState<PaginationState>({
    isLoading: false,
    hasMore: true
  });

  // Track offset and filters in refs to handle synchronous resets
  const offsetRef = useRef(0);
  const lastFilterRef = useRef(currentFilter);
  const lastTypesRef = useRef(selectedTypes?.join(',') || '');
  const stateRef = useRef(state);

  /**
   * Load more items from the API
   * Automatically resets offset to 0 if filter has changed
   */
  const loadMore = useCallback(async (): Promise<DataItem[]> => {
    const currentTypesKey = selectedTypes?.join(',') || '';

    // Check if filter changed - if so, reset pagination synchronously
    const filterChanged = lastFilterRef.current !== currentFilter ||
                          lastTypesRef.current !== currentTypesKey;

    if (filterChanged) {
      offsetRef.current = 0;
      lastFilterRef.current = currentFilter;
      lastTypesRef.current = currentTypesKey;

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

    try {
      // Build query params using current offset from ref
      const params = new URLSearchParams({
        offset: offsetRef.current.toString(),
        limit: UI.PAGINATION_PAGE_SIZE.toString()
      });

      // Add project filter if present
      if (currentFilter) {
        params.append('project', currentFilter);
      }

      // Add type filter for observations endpoint (only if not all types selected)
      if (dataType === 'observations' && selectedTypes && selectedTypes.length > 0) {
        // Only add type param if not all types are selected
        if (selectedTypes.length < OBSERVATION_TYPES.length) {
          params.append('type', selectedTypes.join(','));
        }
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
    } catch (error) {
      console.error(`Failed to load ${dataType}:`, error);
      setState(prev => ({ ...prev, isLoading: false }));
      return [];
    }
  }, [currentFilter, endpoint, dataType, selectedTypes]);

  return {
    ...state,
    loadMore
  };
}

/**
 * Hook for paginating observations, summaries, and prompts
 * @param currentFilter - Project filter
 * @param selectedTypes - Array of observation types to filter by (only applies to observations)
 */
export function usePagination(currentFilter: string, selectedTypes?: string[]) {
  const observations = usePaginationFor(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, selectedTypes);
  const summaries = usePaginationFor(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter);
  const prompts = usePaginationFor(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter);

  return {
    observations,
    summaries,
    prompts
  };
}
