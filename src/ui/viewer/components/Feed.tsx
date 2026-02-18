import React, { useMemo, useRef, useEffect } from 'react';
import type { Observation, Summary, UserPrompt, FeedItem } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { PromptCard } from './PromptCard';
import { TaskNotificationCard } from './TaskNotificationCard';
import { ScrollToTop } from './ScrollToTop';
import { isTaskNotification } from '../utils/taskNotification';
import { UI } from '../constants/ui';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  onLoadMore: () => void;
  isLoading: boolean;
  hasMore: boolean;
}

export function Feed({ observations, summaries, prompts, onLoadMore, isLoading, hasMore }: FeedProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  // Keep the callback ref up to date
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  // Set up intersection observer for infinite scroll.
  // Root must be the scrollable feed container (not the viewport) because
  // .feed has overflow-y: scroll, so the sentinel only scrolls within it.
  useEffect(() => {
    const element = loadMoreRef.current;
    const root = feedRef.current;
    if (!element || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first.isIntersecting && hasMore && !isLoading) {
          onLoadMoreRef.current();
        }
      },
      { root, threshold: UI.LOAD_MORE_THRESHOLD }
    );

    observer.observe(element);

    return () => {
      observer.unobserve(element);
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
        {items.map(item => {
          const key = `${item.itemType}-${String(item.id)}`;
          if (item.itemType === 'observation') {
            return <ObservationCard key={key} observation={item} />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard key={key} summary={item} />;
          } else if (isTaskNotification(item)) {
            return <TaskNotificationCard key={key} prompt={item} />;
          } else {
            return <PromptCard key={key} prompt={item} />;
          }
        })}
        {items.length === 0 && !isLoading && (
          <div className="feed__empty-message" aria-live="polite">
            No items to display
          </div>
        )}
        {isLoading && (
          <div className="feed__loading-message">
            <div className="spinner feed__loading-spinner"></div>
            Loading more...
          </div>
        )}
        {hasMore && !isLoading && items.length > 0 && (
          <div ref={loadMoreRef} className="feed__load-more-sentinel" />
        )}
        {!hasMore && items.length > 0 && (
          <div className="feed__end-message">
            No more items to load
          </div>
        )}
      </div>
    </div>
  );
}
