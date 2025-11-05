import React, { useMemo, useRef, useEffect } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { PromptCard } from './PromptCard';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  processingSessions: Set<string>;
  currentFilter: string;
  onLoadMore?: () => void;
  isLoading?: boolean;
  hasMore?: boolean;
}

type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export function Feed({ observations, summaries, prompts, processingSessions, currentFilter, onLoadMore, isLoading = false, hasMore = true }: FeedProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Set up intersection observer for infinite scroll
  useEffect(() => {
    if (!onLoadMore || !loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first.isIntersecting && hasMore && !isLoading) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadMoreRef.current);

    return () => {
      observer.disconnect();
    };
  }, [onLoadMore, hasMore, isLoading]);

  const items = useMemo<FeedItem[]>(() => {
    const filtered = currentFilter
      ? observations.filter(o => o.project === currentFilter)
      : observations;

    const filteredSummaries = currentFilter
      ? summaries.filter(s => s.project === currentFilter)
      : summaries;

    // For now, don't filter prompts by project since they don't have a project field directly
    // We can enhance this later if needed
    const filteredPrompts = prompts;

    // Combine and sort by timestamp
    const combined = [
      ...filtered.map(o => ({ ...o, itemType: 'observation' as const })),
      ...filteredSummaries.map(s => ({ ...s, itemType: 'summary' as const })),
      ...filteredPrompts.map(p => ({ ...p, itemType: 'prompt' as const }))
    ];

    return combined
      .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  }, [observations, summaries, prompts, currentFilter]);

  return (
    <div className="feed">
      <div className="feed-content">
        {items.map(item => {
          if (item.itemType === 'observation') {
            return <ObservationCard key={`obs-${item.id}`} observation={item} />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard key={`sum-${item.id}`} summary={item} />;
          } else {
            return <PromptCard key={`prompt-${item.id}`} prompt={item} />;
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
