import { useState, useEffect, useCallback, useRef } from 'react';
import { Stats } from '../types';
import { API_ENDPOINTS } from '../constants/api';

interface StatsState {
  data: Stats;
  isLoading: boolean;
  error?: string;
  lastUpdated?: number;
}

const CACHE_DURATION_MS = 30_000; // 30 seconds

export function useStats() {
  const [state, setState] = useState<StatsState>({
    data: {},
    isLoading: false
  });

  const abortControllerRef = useRef<AbortController>();
  const cacheValidUntilRef = useRef<number>(0);

  const loadStats = useCallback(async (force = false) => {
    // Check cache validity
    const now = Date.now();
    if (!force && now < cacheValidUntilRef.current && !state.isLoading) {
      return state.data;
    }

    // Cancel any pending request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: undefined }));

    try {
      const response = await fetch(API_ENDPOINTS.STATS, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch stats: ${response.status}`);
      }

      const data: Stats = await response.json();
      const timestamp = Date.now();
      
      setState({
        data,
        isLoading: false,
        lastUpdated: timestamp
      });

      cacheValidUntilRef.current = timestamp + CACHE_DURATION_MS;
      return data;
    } catch (error) {
      // Ignore AbortError from cancelled requests
      if (error instanceof Error && error.name === 'AbortError') {
        return state.data;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({ 
        ...prev, 
        isLoading: false, 
        error: errorMessage 
      }));
      
      return prev.data;
    }
  }, [state.data, state.isLoading]);

  // Auto-load on mount
  useEffect(() => {
    loadStats();
    return () => abortControllerRef.current?.abort();
  }, [loadStats]);

  return {
    stats: state.data,
    isLoading: state.isLoading,
    error: state.error,
    lastUpdated: state.lastUpdated,
    refresh: loadStats
  };
}