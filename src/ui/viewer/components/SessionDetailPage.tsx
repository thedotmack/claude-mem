import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Feed } from './Feed';
import { CategoryFilter } from './CategoryFilter';
import { FeedItem } from '../types';
import type { DeletableItemType } from '../utils/feed-deletion';
import { categoryOf, countByCategory } from '../utils/category';
import { sessionKey, type SessionRef } from '../utils/sessions';

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
  onLoadMore: () => void;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
  onBack: () => void;
}

export function SessionDetailPage({
  tabs, session, title, items, isLoading, hasMore, loadError, onLoadMore, onDeleted, onBack,
}: SessionDetailPageProps) {
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set());
  const currentSessionKey = sessionKey(session);

  useEffect(() => {
    setActiveCategories(new Set());
  }, [currentSessionKey]);

  const categoryCounts = useMemo(() => countByCategory(items), [items]);

  const filteredItems = useMemo(() => {
    if (activeCategories.size === 0) return items;
    return items.filter(item => activeCategories.has(categoryOf(item)));
  }, [items, activeCategories]);

  const toggleCategory = useCallback((category: string) => {
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
          ← Back to sessions
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
      isLoading={isLoading}
      hasMore={hasMore}
      loadError={loadError}
    />
  );
}
