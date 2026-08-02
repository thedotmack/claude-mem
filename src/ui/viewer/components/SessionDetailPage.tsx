import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Feed } from './Feed';
import { usePagination } from '../hooks/usePagination';
import { Observation, Summary, UserPrompt } from '../types';
import { mergeAndDeduplicateByProject } from '../utils/data';

interface SessionDetailPageProps {
  contentSessionId: string;
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  onBack: () => void;
}

export function SessionDetailPage({ contentSessionId, observations, summaries, prompts, onBack }: SessionDetailPageProps) {
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const pagination = usePagination('', contentSessionId);

  const matchesSession = useCallback((item: { content_session_id?: string; session_id?: string }) => {
    const itemSessionId = item.content_session_id ?? item.session_id;
    return itemSessionId === contentSessionId;
  }, [contentSessionId]);

  const allObservations = useMemo(() => {
    const live = observations.filter(matchesSession);
    const paginated = paginatedObservations.filter(matchesSession);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesSession]);

  const allSummaries = useMemo(() => {
    const live = summaries.filter(matchesSession);
    const paginated = paginatedSummaries.filter(matchesSession);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesSession]);

  const allPrompts = useMemo(() => {
    const live = prompts.filter(matchesSession);
    const paginated = paginatedPrompts.filter(matchesSession);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesSession]);

  const handleLoadMore = useCallback(async () => {
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

  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentSessionId]);

  return (
    <>
      <div className="session-detail-header">
        <button className="session-detail-back" onClick={onBack}>
          ← Back to sessions
        </button>
        <span className="session-detail-id" title={contentSessionId}>{contentSessionId}</span>
      </div>
      <Feed
        observations={allObservations}
        summaries={allSummaries}
        prompts={allPrompts}
        onLoadMore={handleLoadMore}
        isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
        hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
      />
    </>
  );
}
