import { useState, useEffect, useRef } from 'react';
import type { ActivityDay, SearchResponse } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { UI } from '../constants/ui';
import { logger } from '../utils/logger';
import { inclusiveDateStart, inclusiveDateEnd } from './useSearch';

interface UseActivityDensityResult {
  days: ActivityDay[];
  isLoading: boolean;
}

function bucketByDay(data: SearchResponse): ActivityDay[] {
  const buckets = new Map<string, ActivityDay>();

  const addItem = (epoch: number, type: 'observations' | 'summaries' | 'prompts') => {
    const date = new Date(epoch).toISOString().slice(0, 10);
    const existing = buckets.get(date) ?? { date, count: 0, observations: 0, summaries: 0, prompts: 0 };
    buckets.set(date, { ...existing, count: existing.count + 1, [type]: existing[type] + 1 });
  };

  for (const obs of data.observations) {
    addItem(obs.created_at_epoch, 'observations');
  }
  for (const session of data.sessions) {
    addItem(session.created_at_epoch, 'summaries');
  }
  for (const prompt of data.prompts) {
    addItem(prompt.created_at_epoch, 'prompts');
  }

  // Fill in missing days with zeros
  const allDates = [...buckets.keys()].sort();
  if (allDates.length === 0) return [];

  const result: ActivityDay[] = [];
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - UI.ACTIVITY_BAR_DAYS);

  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dateStr = cursor.toISOString().slice(0, 10);
    result.push(buckets.get(dateStr) ?? { date: dateStr, count: 0, observations: 0, summaries: 0, prompts: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  return result;
}

export function useActivityDensity(project: string): UseActivityDensityResult {
  const [days, setDays] = useState<ActivityDay[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const cacheKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const cacheKey = project;
    if (cacheKeyRef.current === cacheKey) return;

    const controller = new AbortController();
    setIsLoading(true);

    const endDateStr = new Date().toISOString().slice(0, 10);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - UI.ACTIVITY_BAR_DAYS);
    const startStr = startDate.toISOString().slice(0, 10);

    const params = new URLSearchParams({
      format: 'json',
      limit: UI.ACTIVITY_DENSITY_LIMIT.toString(),
      dateStart: inclusiveDateStart(startStr),
      dateEnd: inclusiveDateEnd(endDateStr),
    });
    if (project) params.set('project', project);

    fetch(`${API_ENDPOINTS.SEARCH}?${params}`, { signal: controller.signal })
      .then(res => res.json() as Promise<SearchResponse>)
      .then(data => {
        setDays(bucketByDay(data));
        cacheKeyRef.current = cacheKey;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        logger.error('activityDensity', 'Failed to load activity data');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => { controller.abort(); };
  }, [project]);

  return { days, isLoading };
}
