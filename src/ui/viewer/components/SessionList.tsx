import React, { useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SessionGroup, SessionListItem } from '../types';

// ─────────────────────────────────────────────────────────
// Constants (exported for unit testing)
// ─────────────────────────────────────────────────────────

/** Minimum total session count before virtual scrolling is enabled. */
export const VIRTUAL_THRESHOLD = 100;

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type VirtualItem =
  | { type: 'header'; label: string; dateKey: string }
  | { type: 'session'; session: SessionListItem; isSelected: boolean };

interface SessionListProps {
  sessionGroups: SessionGroup[];
  selectedId: number | null;
  onSelectSession: (id: number) => void;
  onLoadMore: () => Promise<void>;
  hasMore: boolean;
  isLoading: boolean;
}

// ─────────────────────────────────────────────────────────
// Pure utilities (exported for unit testing)
// ─────────────────────────────────────────────────────────

/** Formats an epoch timestamp (ms) to "HH:mm" using local time. */
export function formatSessionTime(epoch: number): string {
  const d = new Date(epoch);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Flattens session groups into a flat list of virtual items (headers + rows).
 * Pure function — does not mutate input.
 */
export function flattenGroups(
  groups: SessionGroup[],
  selectedId: number | null,
): VirtualItem[] {
  const items: VirtualItem[] = [];
  for (const group of groups) {
    items.push({ type: 'header', label: group.label, dateKey: group.dateKey });
    for (const session of group.sessions) {
      items.push({ type: 'session', session, isSelected: session.id === selectedId });
    }
  }
  return items;
}

// ─────────────────────────────────────────────────────────
// SessionRow sub-component
// ─────────────────────────────────────────────────────────

function SessionRow({ session, isSelected, onSelect }: {
  session: SessionListItem;
  isSelected: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <div
      className={isSelected ? 'session-list__row session-list__row--selected' : 'session-list__row'}
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
      <div className="session-list__request">{session.request ?? '(no description)'}</div>
      <div className="session-list__meta">
        {formatSessionTime(session.created_at_epoch)} &bull; {session.observationCount} obs
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// VirtualContent sub-component (above threshold)
// ─────────────────────────────────────────────────────────

function VirtualContent({ items, containerRef, onSelectSession }: {
  items: VirtualItem[];
  containerRef: React.RefObject<HTMLDivElement>;
  onSelectSession: (id: number) => void;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => (items[index]?.type === 'header' ? 32 : 60),
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
  });

  return (
    <div
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
      data-testid="session-group"
    >
      {virtualizer.getVirtualItems().map((vItem) => {
        const item = items[vItem.index];
        if (!item) return null;
        const style: React.CSSProperties = {
          position: 'absolute', top: 0, left: 0, width: '100%',
          transform: `translateY(${vItem.start}px)`,
        };
        if (item.type === 'header') {
          return (
            <div key={`header-${item.dateKey}`} data-index={vItem.index} ref={virtualizer.measureElement} style={style}>
              <div className="session-list__day-header" style={{ position: 'sticky', top: 0 }}>
                {item.label}
              </div>
            </div>
          );
        }
        return (
          <div key={`session-${item.session.id}`} data-index={vItem.index} ref={virtualizer.measureElement} style={style}>
            <SessionRow session={item.session} isSelected={item.isSelected} onSelect={onSelectSession} />
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────

export function SessionList({
  sessionGroups, selectedId, onSelectSession, onLoadMore, hasMore, isLoading,
}: SessionListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => { onLoadMoreRef.current = onLoadMore; }, [onLoadMore]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = containerRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) void onLoadMoreRef.current();
      },
      { root, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => { observer.unobserve(sentinel); observer.disconnect(); };
  }, [hasMore, isLoading]);

  const totalCount = sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0);
  const useVirtual = totalCount > VIRTUAL_THRESHOLD;
  const hasGroups = sessionGroups.length > 0;
  const flatItems = useMemo(() => flattenGroups(sessionGroups, selectedId), [sessionGroups, selectedId]);

  return (
    <div className="session-list" data-testid="session-list" ref={containerRef}>
      {!hasGroups && !isLoading && <div className="session-list__empty">No sessions found</div>}

      {useVirtual ? (
        <VirtualContent
          items={flatItems}
          containerRef={containerRef as React.RefObject<HTMLDivElement>}
          onSelectSession={onSelectSession}
        />
      ) : (
        sessionGroups.map((group) => (
          <div key={group.dateKey} className="session-list__group" data-testid="session-group">
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
        ))
      )}

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
