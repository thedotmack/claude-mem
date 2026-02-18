import { useState, useEffect, useCallback, useRef } from 'react';
import type { FilterState, SearchResponse } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { UI } from '../constants/ui';
import { logger } from '../utils/logger';

interface UseSearchResult {
  results: SearchResponse | null;
  isSearching: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  totalResults: number;
}

/**
 * Make dateEnd inclusive by advancing to end-of-day.
 * The API compares `created_at_epoch <= new Date(dateEnd).getTime()` which
 * resolves to midnight (start of day). Adding T23:59:59.999Z ensures the
 * entire day is included.
 */
function inclusiveDateEnd(dateEnd: string): string {
  return `${dateEnd}T23:59:59.999Z`;
}

function buildSearchParams(filters: FilterState, offset: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('format', 'json');
  params.set('limit', UI.SEARCH_PAGE_SIZE.toString());
  params.set('offset', offset.toString());

  if (filters.query) params.set('query', filters.query);
  if (filters.project) params.set('project', filters.project);
  if (filters.obsTypes.length > 0) params.set('obs_type', filters.obsTypes.join(','));
  if (filters.concepts.length > 0) params.set('concepts', filters.concepts.join(','));
  if (filters.dateStart) params.set('dateStart', filters.dateStart);
  if (filters.dateEnd) params.set('dateEnd', inclusiveDateEnd(filters.dateEnd));

  // obs_type and concepts are observation-specific filters — the API errors if
  // these are applied to sessions/prompts. When they're active, restrict the
  // search to observations only (unless the user explicitly picked item kinds).
  const hasObsOnlyFilters = filters.obsTypes.length > 0 || filters.concepts.length > 0;
  if (filters.itemKinds.length > 0) {
    params.set('type', filters.itemKinds.join(','));
  } else if (hasObsOnlyFilters) {
    params.set('type', 'observations');
  }

  // The API's `type` param controls which tables to query (routing), not a
  // column filter. If itemKinds is the only active filter, the API rejects it
  // with "Either query or filters required". Add a broad date range so the API
  // has a valid column filter to work with.
  const hasColumnFilter = filters.query || filters.project || filters.obsTypes.length > 0 ||
    filters.concepts.length > 0 || filters.dateStart || filters.dateEnd;
  if (!hasColumnFilter && filters.itemKinds.length > 0) {
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    params.set('dateStart', yearAgo.toISOString().slice(0, 10));
    params.set('dateEnd', inclusiveDateEnd(new Date().toISOString().slice(0, 10)));
  }

  return params;
}

export function useSearch(filters: FilterState, isFilterMode: boolean): UseSearchResult {
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeSearch = useCallback(async (offset: number, append: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);

    try {
      const params = buildSearchParams(filters, offset);
      const response = await fetch(`${API_ENDPOINTS.SEARCH}?${params}`, {
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json() as SearchResponse;

      setResults(prev => {
        if (append && prev) {
          return {
            observations: [...prev.observations, ...data.observations],
            sessions: [...prev.sessions, ...data.sessions],
            prompts: [...prev.prompts, ...data.prompts],
            totalResults: data.totalResults,
            query: data.query,
          };
        }
        return data;
      });

      const returnedCount = data.observations.length + data.sessions.length + data.prompts.length;
      setHasMore(returnedCount >= UI.SEARCH_PAGE_SIZE);
      offsetRef.current = offset + UI.SEARCH_PAGE_SIZE;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      logger.error('search', 'Search request failed');
    } finally {
      if (!controller.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, [filters]);

  // Debounced search trigger when filters change
  useEffect(() => {
    if (!isFilterMode) {
      setResults(null);
      setHasMore(false);
      offsetRef.current = 0;
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      offsetRef.current = 0;
      void executeSearch(0, false);
    }, filters.query ? UI.SEARCH_DEBOUNCE_MS : 0);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      abortRef.current?.abort();
    };
  }, [filters, isFilterMode, executeSearch]);

  const loadMore = useCallback(async () => {
    if (isSearching || !hasMore || !isFilterMode) return;
    await executeSearch(offsetRef.current, true);
  }, [isSearching, hasMore, isFilterMode, executeSearch]);

  return {
    results,
    isSearching,
    hasMore,
    loadMore,
    totalResults: (results?.observations.length ?? 0) + (results?.sessions.length ?? 0) + (results?.prompts.length ?? 0),
  };
}
