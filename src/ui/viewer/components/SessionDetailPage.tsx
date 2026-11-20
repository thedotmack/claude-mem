import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { interpolate, useI18n } from '../../i18n';
import { Feed } from './Feed';
import { CategoryFilter } from './CategoryFilter';
import { SummaryCard, type SummarySectionMode } from './SummaryCard';
import { CopyButton } from './CopyButton';
import { StampToggle } from './ShortTime';
import { ArrowLeftIcon, ChevronRightIcon, SearchIcon } from './icons';
import { FeedItem, SessionCatalogEntry, Summary } from '../types';
import type { DeletableItemType } from '../utils/feed-deletion';
import { categoryOf, countByCategory, type Category } from '../utils/category';
import { feedItemKey, matchesSearch } from '../utils/feed-display';
import { formatCount, formatDate, formatShortDate, formatShortTime, localDayKey } from '../utils/formatters';
import { sessionTitle, sessionsHash, sessionKey, type SessionRef } from '../utils/sessions';
import { isPlainClick } from '../utils/links';
import { useFeedDeletes } from '../hooks/useFeedItemDelete';

interface SessionDetailPageProps {
  /** View tabs, shown beside the breadcrumb. */
  tabs: React.ReactNode;
  /** Page notices ("Refresh latest memories"), under the session's heading. */
  notices?: React.ReactNode;
  session: SessionRef;
  /** A title to show when neither the catalog nor the loaded rows name the session. */
  title?: string | null;
  /** The Sessions list's row for this session, when it was loaded: summary title, memory count and start. */
  catalogEntry?: SessionCatalogEntry | null;
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

type SummaryItem = Summary & { itemType: 'summary' };

/** "Nov 15, 5:21 pm to 5:57 pm", or with both dates when the session crossed midnight; one stamp when there is no span. */
function timeSpan(start: number | null, end: number | null, t: (english: string) => string): string | null {
  const stamp = (epoch: number) => interpolate(t('{date}, {time}'), { date: formatShortDate(epoch), time: formatShortTime(epoch) });
  if (end === null) return start === null ? null : stamp(start);
  if (start === null || start >= end) return stamp(end);
  const endText = localDayKey(start) === localDayKey(end) ? formatShortTime(end) : stamp(end);
  return interpolate(t('{start} to {end}'), { start: stamp(start), end: endText });
}

export function SessionDetailPage({
  tabs, notices, session, title: fallbackTitle = null, catalogEntry = null, items, isLoading, hasMore, loadError, canRetry,
  offsetCapReachedAt, onLoadMore, onDeleted, deletes: pageDeletes, onBack,
}: SessionDetailPageProps) {
  const { t } = useI18n();
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(new Set());
  const [query, setQuery] = useState('');
  const [pinnedMode, setPinnedMode] = useState<SummarySectionMode>('folded');
  const ownDeletes = useFeedDeletes(onDeleted);
  const deletes = pageDeletes ?? ownDeletes;
  const currentSessionKey = sessionKey(session);

  useEffect(() => {
    setActiveCategories(new Set());
    setQuery('');
  }, [currentSessionKey]);

  const categoryCounts = useMemo(() => countByCategory(items), [items]);
  const filtered = activeCategories.size > 0 || query.trim() !== '';

  // The kinds and the search. The list applies them after folding prompt repeats over the whole session (G2), so
  // "<n> times in a row" stays true under a search; the counts are the memories that match.
  const matches = useMemo(() => filtered
    ? (item: FeedItem) => (activeCategories.size === 0 || activeCategories.has(categoryOf(item))) && matchesSearch(item, query)
    : undefined, [activeCategories, query, filtered]);
  const filteredItems = useMemo(() => matches ? items.filter(matches) : items, [items, matches]);

  // The newest summary that the filters keep is pinned at the top, folded (F2, F21), and leaves the list below.
  const pinned = useMemo(() => filteredItems.find((item): item is SummaryItem => item.itemType === 'summary') ?? null, [filteredItems]);
  const listItems = useMemo(() => pinned ? items.filter(item => item !== pinned) : items, [items, pinned]);
  const pinnedKey = pinned ? feedItemKey(pinned) : null;
  useEffect(() => { setPinnedMode('folded'); }, [pinnedKey]);

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

  const newestSummary = items.find((item): item is SummaryItem => item.itemType === 'summary');
  const title = sessionTitle(catalogEntry, newestSummary?.request) ?? (fallbackTitle?.trim() || null);
  const project = catalogEntry?.project ?? items[0]?.project ?? null;
  // The catalog counts every memory of the session; without it, the loaded rows are a floor while older pages remain.
  const memoryCount = catalogEntry?.item_count ?? items.length;
  const countText = interpolate(t(memoryCount === 1 ? '{count} memory' : '{count} memories'), {
    count: `${formatCount(memoryCount)}${catalogEntry || !hasMore ? '' : '+'}`,
  });
  const start = catalogEntry?.started_at_epoch ?? (hasMore || items.length === 0 ? null : items[items.length - 1].created_at_epoch);
  const end = items.length > 0 ? items[0].created_at_epoch : null;
  const span = timeSpan(start, end, t);
  // The full stamps, on hover, focus and tap (G9, G10).
  const spanFull = [start, end].filter((epoch): epoch is number => epoch !== null).map(formatDate).join(' – ');

  const header = (
    <>
      <div className="session-detail-header">
        <div className="session-detail-topbar">
          <div className="session-detail-path">
          {/* F21's Keep: "← Back to sessions" in words, beside the breadcrumb; the browser's Back works too (the list has its own address). */}
          <a className="session-detail-back" href={sessionsHash()}
            onClick={event => { if (isPlainClick(event)) { event.preventDefault(); onBack(); } }}>
            <ArrowLeftIcon size={16} />{t('Back to sessions')}
          </a>
          <nav className="session-breadcrumb" aria-label={t('Breadcrumb')}>
            <ol>
              <li>
                <a href={sessionsHash()}
                  onClick={event => { if (isPlainClick(event)) { event.preventDefault(); onBack(); } }}>
                  {t('Sessions')}
                </a>
                <ChevronRightIcon size={14} />
              </li>
              <li aria-current="page">{t('This session')}</li>
            </ol>
          </nav>
          </div>
          {tabs}
        </div>
        <h2 className={`session-detail-title${title ? '' : ' session-detail-title--none'}`}>
          {title ?? (isLoading && items.length === 0 ? t('Loading this session…') : t('No summary yet'))}
        </h2>
        <p className="session-detail-meta">
          {project && <><span className="session-detail-project">{project}</span><span className="session-card-dot" aria-hidden="true">·</span></>}
          <span className={`session-detail-tool source-${session.platformSource}`}>{session.platformSource}</span>
          <span className="session-card-dot" aria-hidden="true">·</span>
          <span className="session-detail-id">{session.contentSessionId}</span>
          <CopyButton text={() => session.contentSessionId} label={t('Copy id')} />
        </p>
        <p className="session-detail-span">
          <span className="session-detail-count">{countText}</span>
          {span && <><span className="session-card-dot" aria-hidden="true">·</span><StampToggle className="session-detail-when" shown={span} full={spanFull} /></>}
        </p>
      </div>
      {notices}
      {pinned && (
        <div className="session-pinned-summary">
          <SummaryCard summary={pinned} onDeleted={onDeleted} deletion={deletes.forRow(feedItemKey(pinned), 'summary', pinned.id)}
            sectionMode={pinnedMode} onSectionModeChange={setPinnedMode} titleShownAbove={pinned.request?.trim() === title} />
        </div>
      )}
      <div className="timeline-filters session-filters">
        <CategoryFilter
          categoryCounts={categoryCounts}
          activeCategories={activeCategories}
          onToggle={toggleCategory}
          onClear={() => setActiveCategories(new Set())}
          filteredCount={filteredItems.length}
          totalCount={items.length}
          totalIsPartial={hasMore}
        />
        {items.length > 0 && (
          <div className="timeline-search">
            <SearchIcon size={16} />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('Find in this session')}
              aria-label={t('Find in this session')}
            />
          </div>
        )}
        {query.trim() && (
          <p className="timeline-search-note" role="status">
            {interpolate(t('{count} of the {total} loaded memories match. Older memories are not searched until they load.'), {
              count: formatCount(filteredItems.length), total: formatCount(items.length),
            })}
          </p>
        )}
      </div>
    </>
  );

  // Rows recycle past FEED_WINDOW_THRESHOLD (50), as on the timeline: "Find in this session" searches every
  // loaded row, including the ones the window has not drawn, which the browser's own find cannot see.
  return (
    <Feed
      header={header}
      items={listItems}
      matches={matches}
      leadCount={pinned ? 1 : 0}
      onLoadMore={onLoadMore}
      onDeleted={onDeleted}
      deletes={deletes}
      isLoading={isLoading}
      hasMore={hasMore}
      loadError={loadError}
      canRetry={canRetry}
      offsetCapReachedAt={offsetCapReachedAt}
      emptyHint={filtered ? { actions: [{ label: t('Clear filters'), onClick: () => { setActiveCategories(new Set()); setQuery(''); } }] } : undefined}
      // Older pages keep loading by themselves while a kind or search is on: one session is bounded (unlike the
      // whole timeline, which pauses), and a filter that empties the loaded rows must still reach older matches.
    />
  );
}
