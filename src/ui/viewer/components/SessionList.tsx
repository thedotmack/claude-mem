import React, { useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
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

export interface SessionListHandle {
  scrollToDate: (dateKey: string) => void;
  scrollToSession: (id: number) => void;
}

export interface ActiveSessionEntry {
  /** Always -1 for the synthetic active session. */
  id: number;
  /** The memory_session_id or content_session_id for the active session. */
  sessionId: string;
  /** Number of unsummarized observations. */
  observationCount: number;
}

interface SessionListProps {
  sessionGroups: SessionGroup[];
  selectedId: number | null;
  onSelectSession: (id: number) => void;
  onLoadMore: () => Promise<void>;
  hasMore: boolean;
  isLoading: boolean;
  /** Active (unsummarized) session to render at the top. Null when no active session. */
  activeSession?: ActiveSessionEntry | null;
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

const SessionRow = React.memo(function SessionRow({ session, isSelected, onSelect }: {
  session: SessionListItem;
  isSelected: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <div
      className={`session-list__row${isSelected ? ' session-list__row--selected' : ''}`}
      data-testid="session-row"
      data-session-id={session.id}
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
        {formatSessionTime(session.created_at_epoch)} &bull; {session.observationCount} obs
      </div>
    </div>
  );
});

export function ActiveSessionRow({ entry, isSelected, onSelect }: {
  entry: ActiveSessionEntry;
  isSelected: boolean;
  onSelect: (id: number) => void;
}) {
  const hasContent = entry.observationCount > 0;
  return (
    <div
      className={`session-list__row session-list__row--active${isSelected ? ' session-list__row--selected' : ''}`}
      data-testid="active-session-row"
      data-session-id={entry.id}
      aria-selected={isSelected}
      onClick={() => onSelect(entry.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(entry.id);
        }
      }}
    >
      <div className="session-list__request">Current session</div>
      <div className="session-list__meta">
        {hasContent && <span className="session-list__status-badge">Live</span>}
        {hasContent ? `${entry.observationCount} unsummarized obs` : 'No pending observations'}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// VirtualContent sub-component (above threshold)
// ─────────────────────────────────────────────────────────

function VirtualContent({ items, containerRef, onSelectSession, scrollToIndexRef }: {
  items: VirtualItem[];
  containerRef: React.RefObject<HTMLDivElement>;
  onSelectSession: (id: number) => void;
  scrollToIndexRef: React.MutableRefObject<((index: number, opts?: { align?: string }) => void) | null>;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => (items[index]?.type === 'header' ? 32 : 60),
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
  });

  // Register scrollToIndex with parent for imperative access
  useEffect(() => {
    scrollToIndexRef.current = (index, opts) => {
      virtualizer.scrollToIndex(index, opts as Parameters<typeof virtualizer.scrollToIndex>[1]);
    };
    return () => { scrollToIndexRef.current = null; };
  }, [virtualizer, scrollToIndexRef]);

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
              <div className="session-list__day-header" data-date-key={item.dateKey}>
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

export const SessionList = forwardRef<SessionListHandle, SessionListProps>(function SessionList(
  { sessionGroups, selectedId, onSelectSession, onLoadMore, hasMore, isLoading, activeSession },
  ref,
) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const scrollToIndexRef = useRef<((index: number, opts?: { align?: string }) => void) | null>(null);

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
  // Lock rendering mode after initial load to prevent scroll-destroying mode
  // switches when loadMore crosses VIRTUAL_THRESHOLD mid-session.
  const virtualModeRef = useRef<boolean | null>(null);
  if (virtualModeRef.current === null && totalCount > 0) {
    virtualModeRef.current = totalCount > VIRTUAL_THRESHOLD;
  }
  const useVirtual = virtualModeRef.current ?? false;
  const hasGroups = sessionGroups.length > 0;
  const flatItems = useMemo(() => flattenGroups(sessionGroups, selectedId), [sessionGroups, selectedId]);

  useImperativeHandle(ref, () => ({
    scrollToDate(dateKey: string) {
      const index = flatItems.findIndex(item => item.type === 'header' && item.dateKey === dateKey);
      if (index === -1) return;
      if (useVirtual && scrollToIndexRef.current) {
        scrollToIndexRef.current(index, { align: 'start' });
        requestAnimationFrame(() => {
          scrollToIndexRef.current?.(index, { align: 'start' });
        });
      } else if (containerRef.current) {
        // Query the non-sticky anchor element instead of the sticky header.
        // Sticky headers report misleading offsetTop/getBoundingClientRect
        // when stuck at the container top, causing zero-delta scroll failures.
        const anchor = containerRef.current.querySelector(`[data-date-anchor="${dateKey}"]`) as HTMLElement | null;
        if (anchor) {
          containerRef.current.scrollTop = anchor.offsetTop;
        }
      }
    },
    scrollToSession(id: number) {
      const index = flatItems.findIndex(item => item.type === 'session' && item.session.id === id);
      if (index === -1) return;
      if (useVirtual && scrollToIndexRef.current) {
        scrollToIndexRef.current(index, { align: 'nearest' });
      } else if (containerRef.current) {
        const el = containerRef.current.querySelector(`[data-session-id="${id}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    },
  }), [flatItems, useVirtual]);

  return (
    <div className="session-list" data-testid="session-list" ref={containerRef}>
      {!hasGroups && !isLoading && !activeSession && <div className="session-list__empty" aria-live="polite">No sessions found</div>}

      {useVirtual ? (
        <VirtualContent
          items={flatItems}
          containerRef={containerRef as React.RefObject<HTMLDivElement>}
          onSelectSession={onSelectSession}
          scrollToIndexRef={scrollToIndexRef}
        />
      ) : (
        flatItems.map((item) => {
          if (item.type === 'header') {
            return (
              <React.Fragment key={`header-${item.dateKey}`}>
                <div data-date-anchor={item.dateKey} style={{ height: 0, overflow: 'hidden' }} />
                <div className="session-list__day-header" data-date-key={item.dateKey}>
                  {item.label}
                </div>
              </React.Fragment>
            );
          }
          return (
            <SessionRow
              key={`session-${item.session.id}`}
              session={item.session}
              isSelected={item.isSelected}
              onSelect={onSelectSession}
            />
          );
        })
      )}

      {isLoading && (
        <div className="session-list__loading" data-testid="session-list-loading" aria-live="polite">
          <div className="spinner" />
          Loading...
        </div>
      )}

      {hasMore && !isLoading && hasGroups && (
        <div ref={loadMoreRef} className="session-list__load-more-sentinel" />
      )}
    </div>
  );
});
