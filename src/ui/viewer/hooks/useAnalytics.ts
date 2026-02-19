import { useState, useEffect, useCallback, useRef } from 'react';
import type { AnalyticsData } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { logger } from '../utils/logger';

/**
 * Fetch analytics data from the API.
 * Exported for direct unit testing without React.
 */
export async function fetchAnalytics(
  project: string,
  days: number | null,
  signal?: AbortSignal,
): Promise<AnalyticsData> {
  const params = new URLSearchParams();
  if (project) {
    params.set('project', project);
  }
  if (days !== null) {
    params.set('days', String(days));
  }

  const query = params.toString();
  const url = query ? `${API_ENDPOINTS.ANALYTICS}?${query}` : API_ENDPOINTS.ANALYTICS;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Analytics fetch failed: ${response.statusText}`);
  }
  return response.json() as Promise<AnalyticsData>;
}

const POLL_INTERVAL = 60_000;

/**
 * Hook to fetch and manage token analytics data.
 * Polls every 60s, pausing when the tab is hidden.
 *
 * @param project - Project filter string (from filters.project); empty string = all projects
 * @returns Analytics data, loading state, and time range controls
 */
export function useAnalytics(project: string) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [timeRange, setTimeRange] = useState<number | null>(30);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (proj: string, days: number | null) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);

    try {
      const result = await fetchAnalytics(proj, days, controller.signal);
      if (!controller.signal.aborted) {
        setData(result);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      logger.error('analytics', 'Failed to load analytics data');
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(project, timeRange);

    let interval: ReturnType<typeof setInterval> | null = setInterval(() => {
      void load(project, timeRange);
    }, POLL_INTERVAL);

    const handleVisibility = () => {
      if (document.hidden) {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        abortRef.current?.abort();
      } else {
        void load(project, timeRange);
        interval = setInterval(() => {
          void load(project, timeRange);
        }, POLL_INTERVAL);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      abortRef.current?.abort();
    };
  }, [load, project, timeRange]);

  return { data, isLoading, timeRange, setTimeRange };
}
