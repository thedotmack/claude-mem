import { useState, useEffect, useCallback } from 'react';
import { Stats } from '../types';
import { API_ENDPOINTS } from '../constants/api';

export function useStats() {
  const [stats, setStats] = useState<Stats>({});

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.STATS);
      const data = await response.json();
      setStats(data);
    } catch (error: unknown) {
      console.error('Failed to load stats:', error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    // Load once on mount
    loadStats();
  }, [loadStats]);

  return { stats, refreshStats: loadStats };
}
