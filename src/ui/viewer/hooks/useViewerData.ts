// CMEM Viewer — normalized data hook.
// Composes the existing fetch/stream hooks (useSSE + usePagination), merges
// live + paginated rows per type (deduped, project-filtered), normalizes the
// raw DB rows, and shapes them into the redesign's ViewerData.
//
// IMPORTANT: this hook does NOT call fetch/EventSource directly — all I/O is
// delegated to useSSE() and usePagination(). Project filtering happens here;
// type/concept/file filtering happens later in buildTimeline.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { useSSE } from './useSSE';
import { usePagination } from './usePagination';
import { mergeAndDeduplicateByProject } from '../utils/data';
import { normObservation, normSummary, normPrompt, buildData } from '../data/normalize';
import type { ViewerData } from '../data/viewer-types';

export interface UseViewerDataResult {
  data: ViewerData;
  projects: string[];
  isProcessing: boolean;
  queueDepth: number;
  isConnected: boolean;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  isLoading: boolean;
}

export function useViewerData(currentFilter: string): UseViewerDataResult {
  // Live rows + connection state (SSE). Paginated rows (REST). No direct I/O here.
  const { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected } = useSSE();
  const pagination = usePagination(currentFilter);

  // Paginated state arrays (ported from App.tsx) — appended to on loadMore,
  // reset whenever the project filter changes.
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const matchesSelection = useCallback(
    (item: { project: string }) => !currentFilter || item.project === currentFilter,
    [currentFilter]
  );

  const loadMore = useCallback(async () => {
    try {
      const [newObservations, newSummaries, newPrompts] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore()
      ]);

      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations]);
      }
      if (newSummaries.length > 0) {
        setPaginatedSummaries(prev => [...prev, ...newSummaries]);
      }
      if (newPrompts.length > 0) {
        setPaginatedPrompts(prev => [...prev, ...newPrompts]);
      }
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [pagination.observations, pagination.summaries, pagination.prompts]);

  // Reset paginated state and reload the first page when the filter changes.
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter]);

  // Merge live + paginated per type, filtered by project (mirrors App.tsx).
  const mergedObservations = useMemo(() => {
    const live = observations.filter(matchesSelection);
    const paginated = paginatedObservations.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesSelection]);

  const mergedSummaries = useMemo(() => {
    const live = summaries.filter(matchesSelection);
    const paginated = paginatedSummaries.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesSelection]);

  const mergedPrompts = useMemo(() => {
    const live = prompts.filter(matchesSelection);
    const paginated = paginatedPrompts.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesSelection]);

  // Normalize raw DB rows → viewer shape, then build the timeline-ready data.
  const data = useMemo<ViewerData>(() => {
    return buildData({
      observations: mergedObservations.map(normObservation),
      summaries: mergedSummaries.map(normSummary),
      prompts: mergedPrompts.map(normPrompt)
    });
  }, [mergedObservations, mergedSummaries, mergedPrompts]);

  const hasMore =
    pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore;
  const isLoading =
    pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading;

  return {
    data,
    projects,
    isProcessing,
    queueDepth,
    isConnected,
    loadMore,
    hasMore,
    isLoading
  };
}
