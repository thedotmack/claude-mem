import { useState, useEffect, useCallback } from 'react';
import { Stats } from '../types';
import { API_ENDPOINTS, authenticatedFetch } from '../constants/api';

export function useStats() {
  const [stats, setStats] = useState<Stats>({});

  const loadStats = useCallback(async () => {
    try {
      const response = await authenticatedFetch(API_ENDPOINTS.STATS);
      const data = await response.json();
      setStats(data);
    } catch (error) {
      if (error instanceof Error) {
        console.error('Failed to load stats:', error);
      }
    }
  }, []);

  useEffect(() => {
    // Load once on mount
    loadStats();
  }, [loadStats]);

  return { stats, refreshStats: loadStats };
}
