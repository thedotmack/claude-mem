import { useState, useEffect } from 'react';
import { Stats } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export function useStats() {
  const [stats, setStats] = useState<Stats>({});

  useEffect(() => {
    const loadStats = async () => {
      try {
        const response = await fetch(API_ENDPOINTS.STATS);
        const data = await response.json();
        setStats(data);
      } catch (error) {
        console.error('Failed to load stats:', error);
      }
    };

    // Load immediately
    loadStats();

    // Refresh periodically
    const interval = setInterval(loadStats, TIMING.STATS_REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return { stats };
}
