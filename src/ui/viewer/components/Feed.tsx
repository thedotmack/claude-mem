import React, { useMemo, useRef, useEffect } from 'react';
import { Observation, Summary, UserPrompt, FeedItem } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { SummarySkeleton } from './SummarySkeleton';
import { PromptCard } from './PromptCard';
import { UI } from '../constants/ui';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  processingSessions: Set<string>;
  onLoadMore: () => void;
  isLoading: boolean;
  hasMore: boolean;
}

export function Feed({ observations, summaries, prompts, processingSessions, onLoadMore, isLoading, hasMore }: FeedProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  // Keep the callback ref up to date
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  // Set up intersection observer for infinite scroll
  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first.isIntersecting && hasMore && !isLoading) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD }
    );

    observer.observe(element);

    return () => {
      if (element) {
        observer.unobserve(element);
      }
      observer.disconnect();
    };
  }, [hasMore, isLoading]);

  const items = useMemo<FeedItem[]>(() => {
    // Create a set of session IDs that already have summaries
    const sessionsWithSummaries = new Set(summaries.map(s => s.session_id));

    // Find the most recent prompt for each processing session
    const sessionPrompts = new Map<string, UserPrompt>();
    prompts.forEach(p => {
      const existing = sessionPrompts.get(p.claude_session_id);
      if (!existing || p.created_at_epoch > existing.created_at_epoch) {
        sessionPrompts.set(p.claude_session_id, p);
      }
    });

    // Create skeleton items for sessions being processed that don't have summaries yet
    const skeletons: FeedItem[] = [];
    processingSessions.forEach(sessionId => {
      if (!sessionsWithSummaries.has(sessionId)) {
        const prompt = sessionPrompts.get(sessionId);
        skeletons.push({
          itemType: 'skeleton',
          id: sessionId, // Don't add prefix - key construction adds itemType already
          session_id: sessionId,
          project: prompt?.project,
          // Always use current time so skeletons appear at top of feed
          created_at_epoch: Date.now()
        });
      }
    });

    // Data is already filtered by App.tsx - no need to filter again
    const combined = [
      ...observations.map(o => ({ ...o, itemType: 'observation' as const })),
      ...summaries.map(s => ({ ...s, itemType: 'summary' as const })),
      ...prompts.map(p => ({ ...p, itemType: 'prompt' as const })),
      ...skeletons
    ];

    return combined
      .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  }, [observations, summaries, prompts, processingSessions]);

  return (
    <div className="feed">
      <div className="feed-content">
        {items.map(item => {
          const key = `${item.itemType}-${item.id}`;
          if (item.itemType === 'observation') {
            return <ObservationCard key={key} observation={item} />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard key={key} summary={item} />;
          } else if (item.itemType === 'skeleton') {
            return <SummarySkeleton key={key} sessionId={item.session_id} project={item.project} />;
          } else {
            return <PromptCard key={key} prompt={item} />;
          }
        })}
        {items.length === 0 && !isLoading && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
            No items to display
          </div>
        )}
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8b949e' }}>
            <div className="spinner" style={{ display: 'inline-block', marginRight: '10px' }}></div>
            Loading more...
          </div>
        )}
        {hasMore && !isLoading && items.length > 0 && (
          <div ref={loadMoreRef} style={{ height: '20px', margin: '10px 0' }} />
        )}
        {!hasMore && items.length > 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8b949e', fontSize: '14px' }}>
            No more items to load
          </div>
        )}
      </div>
    </div>
  );
}
