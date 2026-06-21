import { useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { authFetch } from '../utils/api';

export function useStats() {
  const refreshStats = useCallback(() => {
    authFetch(API_ENDPOINTS.STATS).catch((error: unknown) => {
      console.error('Failed to refresh stats:', error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  return { refreshStats };
}
