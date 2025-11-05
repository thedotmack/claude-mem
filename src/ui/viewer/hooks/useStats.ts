import { useState, useEffect } from 'react';
import { Stats } from '../types';

export function useStats() {
  const [stats, setStats] = useState<Stats>({});

  useEffect(() => {
    const loadStats = async () => {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        setStats(data);
      } catch (error) {
        console.error('Failed to load stats:', error);
      }
    };

    // Load immediately
    loadStats();

    // Refresh every 10 seconds
    const interval = setInterval(loadStats, 10000);

    return () => clearInterval(interval);
  }, []);

  return { stats };
}
