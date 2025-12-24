import { useState, useEffect, useRef, useCallback } from 'react';
import { Observation, Summary, UserPrompt, OBSERVATION_TYPES } from '../types';
import { API_ENDPOINTS } from '../constants/api';

interface SearchResults {
  observations: Observation[];
  sessions: Summary[];
  prompts: UserPrompt[];
  total: number;
  query: string;
}

interface SearchState {
  results: SearchResults | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for semantic search with debouncing
 * @param query - Search query text
 * @param project - Optional project filter
 * @param selectedTypes - Optional observation type filter
 * @param debounceMs - Debounce delay in milliseconds (default 300)
 */
export function useSearch(
  query: string,
  project?: string,
  selectedTypes?: string[],
  debounceMs: number = 300
) {
  const [state, setState] = useState<SearchState>({
    results: null,
    isLoading: false,
    error: null
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const performSearch = useCallback(async (searchQuery: string) => {
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Empty query = no search
    if (!searchQuery.trim()) {
      setState({ results: null, isLoading: false, error: null });
      return;
    }

    // Create new abort controller
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Build query params
      const params = new URLSearchParams({
        query: searchQuery,
        format: 'raw', // Get JSON, not MCP text format
        limit: '50',
        type: 'observations' // Focus on observations for now
      });

      // Add project filter if present
      if (project) {
        params.append('project', project);
      }

      // Add observation type filter if not all types selected
      if (selectedTypes && selectedTypes.length > 0 && selectedTypes.length < OBSERVATION_TYPES.length) {
        params.append('obs_type', selectedTypes.join(','));
      }

      const response = await fetch(`${API_ENDPOINTS.SEARCH}?${params}`, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json() as SearchResults;

      setState({
        results: data,
        isLoading: false,
        error: null
      });
    } catch (error: any) {
      // Ignore abort errors
      if (error.name === 'AbortError') {
        return;
      }

      setState({
        results: null,
        isLoading: false,
        error: error.message || 'Search failed'
      });
    }
  }, [project, selectedTypes]);

  // Debounced search effect
  useEffect(() => {
    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Empty query = clear results immediately
    if (!query.trim()) {
      setState({ results: null, isLoading: false, error: null });
      return;
    }

    // Set loading state immediately for visual feedback
    setState(prev => ({ ...prev, isLoading: true }));

    // Debounce the actual search
    debounceTimerRef.current = setTimeout(() => {
      performSearch(query);
    }, debounceMs);

    // Cleanup
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [query, performSearch, debounceMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    results: state.results,
    isLoading: state.isLoading,
    error: state.error,
    isSearchActive: query.trim().length > 0
  };
}
