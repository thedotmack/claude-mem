import { useState, useEffect, useCallback, useRef } from 'react';
import type { Stats } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { logger } from '../utils/logger';

export function useStats() {
  const [stats, setStats] = useState<Stats>({});
  const abortRef = useRef<AbortController | null>(null);

  const loadStats = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(API_ENDPOINTS.STATS, { signal: controller.signal });
      if (!response.ok) throw new Error('Stats fetch failed');
      const data = await response.json() as Stats;
      if (!controller.signal.aborted) {
        setStats(data);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      logger.error('stats', 'Failed to load stats');
    }
  }, []);

  useEffect(() => {
    // Load once on mount
    void loadStats();

    return () => {
      abortRef.current?.abort();
    };
  }, [loadStats]);

  return { stats, refreshStats: loadStats };
}
