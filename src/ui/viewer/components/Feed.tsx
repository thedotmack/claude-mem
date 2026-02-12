import React, { useMemo, useRef, useEffect, useCallback } from 'react';
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
}

// Component renderer mapping for clean switch logic
const ITEM_RENDERERS = {
  observation: (item: FeedItem, key: string) => <ObservationCard key={key} observation={item} />,
  summary: (item: FeedItem, key: string) => <SummaryCard key={key} summary={item} />,
  prompt: (item: FeedItem, key: string) => <PromptCard key={key} prompt={item} />,
} as const;

// Status message components for consistent styling
const StatusMessage = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`feed-status ${className}`} style={{ textAlign: 'center', padding: '20px', color: '#8b949e' }}>
    {children}
  </div>
);

export function Feed({ observations, summaries, prompts, onLoadMore, isLoading, hasMore }: FeedProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver>();
  const onLoadMoreRef = useRef(onLoadMore);

  // Keep callback ref current
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  // Optimized intersection observer with proper cleanup
  const setupIntersectionObserver = useCallback(() => {
    const element = loadMoreRef.current;
    if (!element || !hasMore) return;

    // Clean up existing observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !isLoading) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD }
    );

    observerRef.current.observe(element);
  }, [hasMore, isLoading]);

  useEffect(() => {
    setupIntersectionObserver();
    return () => observerRef.current?.disconnect();
  }, [setupIntersectionObserver]);

  // Efficiently combine and sort feed items
  const feedItems = useMemo<FeedItem[]>(() => {
    const itemMappers = [
      { items: observations, type: 'observation' as const },
      { items: summaries, type: 'summary' as const },
      { items: prompts, type: 'prompt' as const },
    ];

    return itemMappers
      .flatMap(({ items, type }) => items.map(item => ({ ...item, itemType: type })))
      .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  }, [observations, summaries, prompts]);

  // Render feed item with optimized component lookup
  const renderFeedItem = useCallback((item: FeedItem) => {
    const key = `${item.itemType}-${item.id}`;
    const renderer = ITEM_RENDERERS[item.itemType];
    return renderer(item, key);
  }, []);

  return (
    <div className="feed" ref={feedRef}>
      <ScrollToTop targetRef={feedRef} />
      <div className="feed-content">
        {feedItems.map(renderFeedItem)}
        
        {/* Empty state */}
        {feedItems.length === 0 && !isLoading && (
          <StatusMessage className="empty-state" style={{ padding: '40px' }}>
            No items to display
          </StatusMessage>
        )}

        {/* Loading indicator */}
        {isLoading && (
          <StatusMessage className="loading-state">
            <div className="spinner" style={{ display: 'inline-block', marginRight: '10px' }} />
            Loading more...
          </StatusMessage>
        )}

        {/* Load more trigger */}
        {hasMore && !isLoading && feedItems.length > 0 && (
          <div ref={loadMoreRef} className="load-more-trigger" style={{ height: '20px', margin: '10px 0' }} />
        )}

        {/* End of feed indicator */}
        {!hasMore && feedItems.length > 0 && (
          <StatusMessage className="end-of-feed" style={{ fontSize: '14px' }}>
            No more items to load
          </StatusMessage>
        )}
      </div>
    </div>
  );
}
