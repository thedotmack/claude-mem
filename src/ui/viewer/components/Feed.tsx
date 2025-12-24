import React, { useMemo, useRef, useEffect } from 'react';
import { Observation, Summary, UserPrompt, FeedItem } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { PromptCard } from './PromptCard';
import { ScrollToTop } from './ScrollToTop';
import { UI } from '../constants/ui';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  onLoadMore: () => void;
  isLoading: boolean;
  hasMore: boolean;
  isSearchMode?: boolean;
  searchQuery?: string;
  searchTotal?: number;
}

export function Feed({ observations, summaries, prompts, onLoadMore, isLoading, hasMore, isSearchMode, searchQuery, searchTotal }: FeedProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
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
    const combined = [
      ...observations.map(o => ({ ...o, itemType: 'observation' as const })),
      ...summaries.map(s => ({ ...s, itemType: 'summary' as const })),
      ...prompts.map(p => ({ ...p, itemType: 'prompt' as const }))
    ];

    return combined.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  }, [observations, summaries, prompts]);

  return (
    <div className="feed" ref={feedRef}>
      <ScrollToTop targetRef={feedRef} />
      <div className="feed-content">
        {/* Search results header */}
        {isSearchMode && (
          <div className="search-results-header">
            {searchTotal !== undefined ? (
              <>Found <strong>{searchTotal}</strong> result{searchTotal !== 1 ? 's' : ''} for "<em>{searchQuery}</em>"</>
            ) : (
              <>Searching for "<em>{searchQuery}</em>"...</>
            )}
          </div>
        )}

        {items.map(item => {
          const key = `${item.itemType}-${item.id}`;
          if (item.itemType === 'observation') {
            return <ObservationCard key={key} observation={item} />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard key={key} summary={item} />;
          } else {
            return <PromptCard key={key} prompt={item} />;
          }
        })}

        {/* Empty state */}
        {items.length === 0 && !isLoading && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
            {isSearchMode ? 'No results found' : 'No items to display'}
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8b949e' }}>
            <div className="spinner" style={{ display: 'inline-block', marginRight: '10px' }}></div>
            {isSearchMode ? 'Searching...' : 'Loading more...'}
          </div>
        )}

        {/* Load more trigger (only in feed mode, not search mode) */}
        {!isSearchMode && hasMore && !isLoading && items.length > 0 && (
          <div ref={loadMoreRef} style={{ height: '20px', margin: '10px 0' }} />
        )}

        {/* End of results (only in feed mode) */}
        {!isSearchMode && !hasMore && items.length > 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8b949e', fontSize: '14px' }}>
            No more items to load
          </div>
        )}
      </div>
    </div>
  );
}
