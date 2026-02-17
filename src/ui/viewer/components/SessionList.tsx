import React, { useRef, useEffect } from 'react';
import type { SessionGroup, SessionListItem } from '../types';

// ─────────────────────────────────────────────────────────
// Pure utility (exported for unit testing)
// ─────────────────────────────────────────────────────────

/**
 * Formats an epoch timestamp (ms) to "HH:mm" using local time.
 */
export function formatSessionTime(epoch: number): string {
  const d = new Date(epoch);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface SessionListProps {
  sessionGroups: SessionGroup[];
  selectedId: number | null;
  onSelectSession: (id: number) => void;
  onLoadMore: () => Promise<void>;
  hasMore: boolean;
  isLoading: boolean;
}

// ─────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────

interface SessionRowProps {
  session: SessionListItem;
  isSelected: boolean;
  onSelect: (id: number) => void;
}

function SessionRow({ session, isSelected, onSelect }: SessionRowProps) {
  const time = formatSessionTime(session.created_at_epoch);
  const className = isSelected
    ? 'session-list__row session-list__row--selected'
    : 'session-list__row';
  return (
    <div
      className={className}
      data-testid="session-row"
      aria-selected={isSelected}
      onClick={() => onSelect(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
    >
      <div className="session-list__request">
        {session.request ?? '(no description)'}
      </div>
      <div className="session-list__meta">
        {time} &bull; {session.observationCount} obs
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────

export function SessionList({
  sessionGroups,
  selectedId,
  onSelectSession,
  onLoadMore,
  hasMore,
  isLoading,
}: SessionListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  // Keep callback ref current to avoid stale closure in observer
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  // Infinite scroll via IntersectionObserver (same pattern as Feed)
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = containerRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first.isIntersecting && hasMore && !isLoading) {
          void onLoadMoreRef.current();
        }
      },
      { root, threshold: 0 }
    );

    observer.observe(sentinel);

    return () => {
      observer.unobserve(sentinel);
      observer.disconnect();
    };
  }, [hasMore, isLoading]);

  const hasGroups = sessionGroups.length > 0;

  return (
    <div className="session-list" data-testid="session-list" ref={containerRef}>
      {!hasGroups && !isLoading && (
        <div className="session-list__empty">No sessions found</div>
      )}

      {sessionGroups.map((group) => (
        <div
          key={group.dateKey}
          className="session-list__group"
          data-testid="session-group"
        >
          <div className="session-list__day-header">{group.label}</div>
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isSelected={session.id === selectedId}
              onSelect={onSelectSession}
            />
          ))}
        </div>
      ))}

      {isLoading && (
        <div className="session-list__loading" data-testid="session-list-loading">
          <div className="spinner" />
          Loading...
        </div>
      )}

      {hasMore && !isLoading && hasGroups && (
        <div ref={loadMoreRef} className="session-list__load-more-sentinel" />
      )}
    </div>
  );
}
