import React, { useEffect, useMemo, useRef, useState } from 'react';
import { interpolate, useI18n } from '../../i18n';
import { translateViewerError } from '../../i18n/errors';
import { SessionCatalogEntry } from '../types';
import { SessionCard } from './SessionCard';
import { WindowedFeed } from './WindowedFeed';
import { SearchIcon, StackIcon, WarningIcon } from './icons';
import { catalogEntryRef, matchesSessionSearch, sessionKey, type SessionRef } from '../utils/sessions';
import { UI } from '../constants/ui';
import { formatCount, formatDayLabel, localDayKey } from '../utils/formatters';
import { feedEnding, type FeedEnding } from '../utils/feed-display';
import { useDeletes } from '../hooks/useFeedItemDelete';

/**
 * What the Sessions list says after its rows. The same states and the same one writer, feedEnding(), as the
 * timeline (FeedEnding in feed-display.ts is the one definition); these are the Sessions list's words. Literal t()
 * keys, so tests/ui-i18n.test.ts checks each one.
 */
export const SESSION_LIST_ENDING_WORDS: Record<FeedEnding, (t: (english: string) => string) => string> = {
  'first-load': t => t('Loading sessions…'),
  loading: t => t('Loading older sessions…'),
  empty: t => t('No sessions to show'),
  'no-match': t => t('No session matches'),
  failed: t => t('Could not load sessions.'),
  more: t => t('Load older sessions'),
  end: t => t('No more sessions to load'),
};

/**
 * A row before it is first drawn, with its 8px gap: measured on the owner's 100 newest sessions (2026-11-16),
 * rows are 67px with a one-line title and 88px with two at 1440, 89-110px at 390. Drawn rows are measured.
 */
const ESTIMATED_SESSION_ROW_HEIGHT = 84;

const rowKey = (entry: SessionCatalogEntry) => sessionKey(catalogEntryRef(entry));

interface SessionListProps {
  header: React.ReactNode;
  sessions: SessionCatalogEntry[];
  isLoading: boolean;
  hasMore: boolean;
  loadError: string | null;
  /** False when the server refused the request outright, so Retry would only repeat it. */
  canRetry?: boolean;
  /** The server's deepest allowed offset when it stopped the catalog there instead of running out. */
  offsetCapReachedAt?: number | null;
  /** The header's project filter, when one is on: an empty list offers to show every project. */
  projectFilter?: string;
  onClearProjectFilter?: () => void;
  onOpen: (session: SessionRef) => void;
  /** Deletes a session; rejects with a user-facing reason. `signal` stops waiting for the worker. */
  onDelete: (session: SessionRef, signal?: AbortSignal) => Promise<void>;
  /** Loads the next (older) page of sessions; the list asks when its end scrolls into view. */
  onLoadMore: () => void;
  onRefreshLatest?: () => void;
}

export function SessionList({
  header, sessions, isLoading, hasMore, loadError, canRetry = true, offsetCapReachedAt = null,
  projectFilter = '', onClearProjectFilter, onOpen, onDelete, onLoadMore, onRefreshLatest,
}: SessionListProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const deletes = useDeletes();
  const shown = useMemo(() => searching ? sessions.filter(session => matchesSessionSearch(session, query)) : sessions, [sessions, query, searching]);
  const dayStarts = useMemo(() => new Set(shown.flatMap((session, index) =>
    index === 0 || localDayKey(shown[index - 1].started_at_epoch) !== localDayKey(session.started_at_epoch) ? [index] : [])), [shown]);
  // While a search is on, older pages load by the button only: a search that matches little would
  // otherwise page through the whole history by itself (the timeline does the same).
  const ending = feedEnding({ rowCount: shown.length, loadedCount: sessions.length, isLoading, hasMore, loadError, autoLoad: !searching, filtered: searching });
  // A search that matches no loaded session, whether or not older pages are left to load.
  const noMatch = ending === 'no-match' || (ending === 'more' && searching && shown.length === 0);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Several queued notifications arrive oldest first; act on where the sentinel is now.
        const latest = entries[entries.length - 1];
        if (latest.isIntersecting && latest.target.isConnected && hasMore && !isLoading && !loadError) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadError, searching]);

  const loadedLine = interpolate(t(sessions.length === 1 ? '{count} session loaded' : '{count} sessions loaded'), { count: formatCount(sessions.length) });
  const renderRow = (session: SessionCatalogEntry, index: number) => {
    const ref = catalogEntryRef(session);
    return (
      <>
        {dayStarts.has(index) && <h3 className="feed-day session-day">{formatDayLabel(session.started_at_epoch)}</h3>}
        <SessionCard
          session={session}
          deletion={deletes.forKey(sessionKey(ref), signal => onDelete(ref, signal))}
          onOpen={() => onOpen(ref)}
          onDelete={signal => onDelete(ref, signal)}
        />
      </>
    );
  };

  return (
    <main className="session-list" ref={listRef} aria-label={t('Saved sessions')}>
      <div className="session-list-content">
        {header}
        {sessions.length > 0 && (
          <div className="session-search-field">
            <label className="session-search-label" htmlFor="session-search">{t('Find a session')}</label>
            <div className="timeline-search session-search">
              <SearchIcon size={16} />
              <input id="session-search" type="search" value={query} onChange={event => setQuery(event.target.value)} />
            </div>
            {searching && (
              <p className="timeline-search-note" role="status">
                {interpolate(t('{count} of the {total} loaded sessions match. Older sessions are not searched until they load.'), {
                  count: formatCount(shown.length), total: formatCount(sessions.length),
                })}
              </p>
            )}
          </div>
        )}
        {shown.length > 0 && (
          <WindowedFeed items={shown} itemKey={rowKey} scrollRef={listRef} renderItem={renderRow}
            estimatedHeight={ESTIMATED_SESSION_ROW_HEIGHT} keepMounted={deletes.active} listLabel={t('Loaded sessions')} />
        )}
        {(ending === 'first-load' || ending === 'loading') && (
          <div className="feed-ending feed-ending--loading" role="status">
            <span className="spinner" aria-hidden="true" />
            {SESSION_LIST_ENDING_WORDS[ending](t)}
          </div>
        )}
        {shown.length === 0 && (ending === 'empty' || ending === 'no-match' || ending === 'more') && (
          <div className="memory-empty-state session-list-empty">
            <StackIcon size={40} />
            {noMatch ? (
              <>
                <h3>{SESSION_LIST_ENDING_WORDS['no-match'](t)}</h3>
                <p>{t('Only loaded sessions are searched.')}</p>
              </>
            ) : (
              <>
                <h3>{SESSION_LIST_ENDING_WORDS.empty(t)}</h3>
                <p>{t('Sessions appear as work is captured. Try another project if a filter is selected.')}</p>
                {projectFilter && <p className="memory-empty-detail">{interpolate(t('Project filter: {project}'), { project: projectFilter })}</p>}
              </>
            )}
            <div className="memory-empty-actions">
              {searching && <button type="button" onClick={() => setQuery('')}>{t('Clear search')}</button>}
              {!searching && projectFilter && onClearProjectFilter && <button type="button" onClick={onClearProjectFilter}>{t('Show all projects')}</button>}
              {ending === 'more' && <button type="button" onClick={onLoadMore}>{SESSION_LIST_ENDING_WORDS.more(t)}</button>}
            </div>
          </div>
        )}
        {ending === 'failed' && loadError && (
          // G17: the plain words, the raw reason folded under Details in monospace, then Retry.
          <div className="feed-ending feed-ending--failed" role="alert">
            <WarningIcon size={18} />
            <div className="feed-ending-text">
              <p className="feed-ending-plain">{SESSION_LIST_ENDING_WORDS.failed(t)}</p>
              <details className="feed-ending-details">
                <summary>{t('Details')}</summary>
                <pre>{translateViewerError(loadError, t)}</pre>
              </details>
            </div>
            {canRetry && <button type="button" onClick={onLoadMore}>{t('Retry')}</button>}
            {onRefreshLatest && <button type="button" onClick={onRefreshLatest}>{t('Refresh latest sessions')}</button>}
          </div>
        )}
        {/* Older sessions still load by themselves at the end of the list (C14); the button says so and works by keyboard. */}
        {(ending === null || ending === 'more') && shown.length > 0 && (
          <div className="feed-ending session-list-more">
            <span className="session-list-loaded">{loadedLine}</span>
            <button type="button" onClick={onLoadMore}>{SESSION_LIST_ENDING_WORDS.more(t)}</button>
          </div>
        )}
        {ending === null && <div ref={loadMoreRef} className="feed-sentinel" aria-hidden="true" />}
        {ending === 'end' && shown.length > 0 && (
          <div className="feed-ending feed-ending--end">
            {offsetCapReachedAt !== null
              ? interpolate(t('This list stops at the newest {count} items. Filter by project to see older ones.'), { count: formatCount(offsetCapReachedAt) })
              : <>{SESSION_LIST_ENDING_WORDS.end(t)} · {loadedLine}</>}
          </div>
        )}
      </div>
    </main>
  );
}
