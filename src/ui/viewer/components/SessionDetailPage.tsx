import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '../../i18n';
import { Feed } from './Feed';
import { CategoryFilter } from './CategoryFilter';
import { FeedItem } from '../types';
import type { DeletableItemType } from '../utils/feed-deletion';
import { categoryOf, countByCategory, type Category } from '../utils/category';
import { sessionKey, type SessionRef } from '../utils/sessions';
import type { useFeedDeletes } from '../hooks/useFeedItemDelete';

/**
 * Session pages recycle rows only past 500, as before 16.0. Rows outside the window are
 * not in the page, so the browser's own find (Ctrl+F) cannot see them, and a session page
 * has no search box of its own yet. Phase 10 adds "Find in this session" and then moves
 * session pages to the timeline's 50 (FEED_WINDOW_THRESHOLD).
 */
export const SESSION_PAGE_WINDOW_THRESHOLD = 500;

interface SessionDetailPageProps {
  /** View tabs, rendered at the top of the scrolling column. */
  tabs: React.ReactNode;
  session: SessionRef;
  /** The session's custom title when the catalog knows it. */
  title: string | null;
  /** This session's rows, newest first (App owns loading and deletes). */
  items: FeedItem[];
  isLoading: boolean;
  hasMore: boolean;
  loadError?: string | null;
  canRetry?: boolean;
  offsetCapReachedAt?: number | null;
  onLoadMore: () => void;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
  /** The cards' deletes, kept by the page above this one so a refusal outlives the view. */
  deletes?: ReturnType<typeof useFeedDeletes>;
  onBack: () => void;
}

export function SessionDetailPage({
  tabs, session, title, items, isLoading, hasMore, loadError, canRetry, offsetCapReachedAt, onLoadMore, onDeleted, deletes, onBack,
}: SessionDetailPageProps) {
  const { t } = useI18n();
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(new Set());
  const currentSessionKey = sessionKey(session);

  useEffect(() => {
    setActiveCategories(new Set());
  }, [currentSessionKey]);

  const categoryCounts = useMemo(() => countByCategory(items), [items]);

  const filteredItems = useMemo(() => {
    if (activeCategories.size === 0) return items;
    return items.filter(item => activeCategories.has(categoryOf(item)));
  }, [items, activeCategories]);

  const toggleCategory = useCallback((category: Category) => {
    setActiveCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const header = (
    <>
      {tabs}
      <div className="session-detail-header">
        <button className="session-detail-back" onClick={onBack}>
          ← {t('Back to sessions')}
        </button>
        <div className="session-detail-title-group">
          {title && <span className="session-detail-title">{title}</span>}
          <span className="session-detail-id" title={session.contentSessionId}>
            {session.platformSource} · {session.contentSessionId}
          </span>
        </div>
      </div>
      <CategoryFilter
        categoryCounts={categoryCounts}
        activeCategories={activeCategories}
        onToggle={toggleCategory}
        onClear={() => setActiveCategories(new Set())}
        filteredCount={filteredItems.length}
        totalCount={items.length}
        totalIsPartial={hasMore}
      />
    </>
  );

  return (
    <Feed
      header={header}
      items={filteredItems}
      onLoadMore={onLoadMore}
      onDeleted={onDeleted}
      deletes={deletes}
      windowThreshold={SESSION_PAGE_WINDOW_THRESHOLD}
      isLoading={isLoading}
      hasMore={hasMore}
      loadError={loadError}
      canRetry={canRetry}
      offsetCapReachedAt={offsetCapReachedAt}
    />
  );
}
