import { useState, useEffect, useCallback } from 'react';
import type { Stats } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { logger } from '../utils/logger';

export function useStats() {
  const [stats, setStats] = useState<Stats>({});

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.STATS);
      const data = await response.json() as Stats;
      setStats(data);
    } catch (error) {
      logger.error('stats', 'Failed to load stats');
    }
  }, []);

  useEffect(() => {
    // Load once on mount
    void loadStats();
  }, [loadStats]);

  return { stats, refreshStats: loadStats };
}
