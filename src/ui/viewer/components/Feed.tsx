import React, { useRef, useEffect, useState } from 'react';
import { interpolate, useI18n } from '../../i18n';
import { translateViewerError } from '../../i18n/errors';
import { FeedItem } from '../types';
import type { DeletableItemType } from '../utils/feed-deletion';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { PromptCard } from './PromptCard';
import { ScrollToTop } from './ScrollToTop';
import { UI } from '../constants/ui';
import { WindowedFeed, feedItemKey } from './WindowedFeed';
import type { ObservationViewMode } from './ObservationCard';

interface FeedProps {
  /** Newest first; build with buildFeedItems. */
  items: FeedItem[];
  /** Rendered at the top of the scrolling column (view tabs, session header). */
  header?: React.ReactNode;
  onLoadMore: () => void;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
  isLoading: boolean;
  hasMore: boolean;
  loadError?: string | null;
  /** False when the server refused the request outright, so Retry would only repeat it. */
  canRetry?: boolean;
  /** The server's deepest allowed offset when it stopped this list there instead of running out. */
  offsetCapReachedAt?: number | null;
}

export function Feed({ items, header, onLoadMore, onDeleted, isLoading, hasMore, loadError, canRetry = true, offsetCapReachedAt = null }: FeedProps) {
  const { t } = useI18n();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [observationModes, setObservationModes] = useState<Record<string, ObservationViewMode>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    const keys = new Set(items.map(feedItemKey));
    setObservationModes(previous => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key)));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
    setExpandedPrompts(previous => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key)));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [items]);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // On a slow frame the observer's first check (sentinel not yet in view)
        // and the check after a scroll that brought it into view arrive in one
        // callback, oldest first. Only the newest says where the sentinel is now.
        const latest = entries[entries.length - 1];
        // A notification can arrive after React removed this sentinel but before
        // this effect's cleanup ran, e.g. once the first page of an empty feed
        // started loading and failed. hasMore/isLoading/loadError are stale then,
        // so only a sentinel that is still rendered may load.
        if (latest.isIntersecting && latest.target.isConnected && hasMore && !isLoading && !loadError) {
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
  }, [hasMore, isLoading, loadError]);

  return (
    <main className="feed" ref={feedRef} aria-label={t('Memory timeline')} style={{ overflowAnchor: 'none' }}>
      <ScrollToTop targetRef={feedRef} />
      <div className="feed-content">
        {header}
        <WindowedFeed items={items} scrollRef={feedRef} renderItem={item => {
          const key = feedItemKey(item);
          if (item.itemType === 'observation') {
            return <ObservationCard observation={item} onDeleted={onDeleted} viewMode={observationModes[key] ?? 'summary'} onViewModeChange={mode => setObservationModes(previous => ({ ...previous, [key]: mode }))} />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard summary={item} onDeleted={onDeleted} />;
          } else {
            return <PromptCard prompt={item} expanded={expandedPrompts[key] ?? false} onExpandedChange={expanded => setExpandedPrompts(previous => ({ ...previous, [key]: expanded }))} />;
          }
        }} />
        {items.length === 0 && !isLoading && !loadError && (
          <div className="memory-empty-state">
            <h3>{t('No observations to show')}</h3>
            <p>{t('Observations appear here as you work. If a filter is selected, try another project or category.')}</p>
          </div>
        )}
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--color-text-muted)' }}>
            <div className="spinner" style={{ display: 'inline-block', marginRight: '10px' }}></div>
            {t('Loading more...')}
          </div>
        )}
        {loadError && !isLoading && (
          <div role="alert" style={{ textAlign: 'center', padding: '20px' }}>
            <p>{translateViewerError(loadError, t)}</p>
            {canRetry && <button onClick={onLoadMore}>{t('Retry')}</button>}
          </div>
        )}
        {hasMore && !isLoading && !loadError && (
          <div ref={loadMoreRef} style={{ height: '20px', margin: '10px 0' }} />
        )}
        {!hasMore && items.length > 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--color-text-muted)', fontSize: '14px' }}>
            {offsetCapReachedAt !== null
              ? interpolate(t('This list stops at the newest {count} items. Filter by project to see older ones.'), { count: offsetCapReachedAt.toLocaleString() })
              : t('No more items to load')}
          </div>
        )}
      </div>
    </main>
  );
}
