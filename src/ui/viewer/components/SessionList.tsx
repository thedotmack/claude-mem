import React, { useEffect, useRef } from 'react';
import { interpolate, useI18n } from '../../i18n';
import { translateViewerError } from '../../i18n/errors';
import { SessionCatalogEntry } from '../types';
import { SessionCard } from './SessionCard';
import { catalogEntryRef, sessionKey, type SessionRef } from '../utils/sessions';
import { UI } from '../constants/ui';

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
  onOpen: (session: SessionRef) => void;
  onDelete: (session: SessionRef) => Promise<void>;
  /** Loads the next (older) page of sessions; the list asks when its end scrolls into view. */
  onLoadMore: () => void;
  onRefreshLatest?: () => void;
}

export function SessionList({ header, sessions, isLoading, hasMore, loadError, canRetry = true, offsetCapReachedAt = null, onOpen, onDelete, onLoadMore, onRefreshLatest }: SessionListProps) {
  const { t } = useI18n();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

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
  }, [hasMore, isLoading, loadError]);

  return (
    <main className="session-list" aria-label={t('Saved sessions')}>
      <div className="session-list-content">
        {header}
        {loadError && <div className="card-delete-error" role="alert">
          {translateViewerError(loadError, t)}
          {!isLoading && canRetry && <button onClick={onLoadMore}>{t('Retry')}</button>}
          {!isLoading && onRefreshLatest && <button onClick={onRefreshLatest}>{t('Refresh latest sessions')}</button>}
        </div>}
        {sessions.map(session => {
          const ref = catalogEntryRef(session);
          return (
            <SessionCard
              key={sessionKey(ref)}
              session={session}
              onOpen={() => onOpen(ref)}
              onDelete={() => onDelete(ref)}
            />
          );
        })}
        {sessions.length === 0 && !loadError && (
          <div className="session-list-empty">
            {isLoading ? t('Loading sessions…') : <><h3>{t('No sessions to show')}</h3><p>{t('Sessions appear as work is captured. Try another project if a filter is selected.')}</p></>}
          </div>
        )}
        {isLoading && sessions.length > 0 && (
          <div className="session-list-empty">{t('Loading older sessions…')}</div>
        )}
        {hasMore && !isLoading && !loadError && sessions.length > 0 && (
          <div ref={loadMoreRef} style={{ height: '20px', margin: '10px 0' }} />
        )}
        {!hasMore && !isLoading && offsetCapReachedAt !== null && sessions.length > 0 && (
          <div className="session-list-empty">{interpolate(t('This list stops at the newest {count} items. Filter by project to see older ones.'), { count: offsetCapReachedAt.toLocaleString() })}</div>
        )}
      </div>
    </main>
  );
}
