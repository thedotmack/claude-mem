import React, { useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Observation, UserPrompt, SessionDetail as SessionDetailType } from '../types';
import { SummaryCard } from './SummaryCard';
import { ObservationCard } from './ObservationCard';
import { PromptCard } from './PromptCard';
import { TaskNotificationCard } from './TaskNotificationCard';
import { isTaskNotification } from '../utils/taskNotification';

// ---------------------------------------------------------------------------
// Timeline types
// ---------------------------------------------------------------------------

export type TimelineItem =
  | (Observation & { itemType: 'observation' })
  | (UserPrompt & { itemType: 'prompt' });

// ---------------------------------------------------------------------------
// Pure logic — exported for testing
// ---------------------------------------------------------------------------

/**
 * Merge observations and prompts into a single list sorted by
 * created_at_epoch descending (newest first).
 *
 * The input arrays are never mutated.
 */
export function buildTimeline(
  observations: Observation[],
  prompts: UserPrompt[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...observations.map((o): TimelineItem => ({ ...o, itemType: 'observation' as const })),
    ...prompts.map((p): TimelineItem => ({ ...p, itemType: 'prompt' as const })),
  ];

  return items.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
}

// ---------------------------------------------------------------------------
// Threshold: only virtualize when timeline is large enough to warrant overhead
// ---------------------------------------------------------------------------

const VIRTUALIZATION_THRESHOLD = 30;

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderTimelineItem(item: TimelineItem): React.ReactNode {
  const key = `${item.itemType}-${String(item.id)}`;
  if (item.itemType === 'observation') {
    return <ObservationCard key={key} observation={item} />;
  }
  if (isTaskNotification(item)) {
    return <TaskNotificationCard key={key} prompt={item} />;
  }
  return <PromptCard key={key} prompt={item} />;
}

// ---------------------------------------------------------------------------
// Sub-component: virtualized timeline
// ---------------------------------------------------------------------------

interface VirtualTimelineProps {
  timelineItems: TimelineItem[];
  scrollElement: HTMLDivElement | null;
}

function VirtualTimeline({ timelineItems, scrollElement }: VirtualTimelineProps) {
  const virtualizer = useVirtualizer({
    count: timelineItems.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 120,
    measureElement:
      typeof window !== 'undefined' && navigator.userAgent.indexOf('Firefox') === -1
        ? (element) => element.getBoundingClientRect().height
        : undefined,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      className="session-detail__timeline"
      data-testid="session-detail-timeline"
      style={{ position: 'relative', height: `${totalSize}px` }}
    >
      {virtualItems.map((virtualItem) => {
        const item = timelineItems[virtualItem.index];
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              paddingBottom: '16px',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderTimelineItem(item)}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  detail: SessionDetailType | null;
  isLoading: boolean;
  hasSelection?: boolean;
}

export function SessionDetail({ detail, isLoading, hasSelection }: SessionDetailProps) {
  // Use callback ref + state so the virtualizer re-initializes when the
  // scroll element becomes available (useRef doesn't trigger re-render).
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollElement(node);
  }, []);

  if (isLoading) {
    return (
      <div className="session-detail" data-testid="session-detail" aria-live="polite">
        <div className="session-detail__loading">
          <div className="spinner session-detail__loading-spinner" />
          Loading session...
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="session-detail" data-testid="session-detail" aria-live="polite">
        <div className="session-detail__empty" data-testid="session-detail-empty">
          {hasSelection
            ? 'No data available for this session'
            : 'Select a session to view details'}
        </div>
      </div>
    );
  }

  const timelineItems = buildTimeline(detail.observations, detail.prompts);
  const useVirtual = timelineItems.length > VIRTUALIZATION_THRESHOLD;

  return (
    <div className="session-detail" data-testid="session-detail" ref={scrollRef}>
      <div className="session-detail__content">
        <div className="session-detail__summary">
          {detail.summary ? (
            <SummaryCard summary={detail.summary} />
          ) : (
            <article className="card live-session-card" data-testid="live-session-card">
              <header className="live-session-card__header">
                <span className="session-list__status-badge">Live Session</span>
              </header>
              <div className="live-session-card__body">
                <p className="live-session-card__message">
                  This session is still in progress. A summary will be generated when it ends.
                </p>
                <div className="live-session-card__stats">
                  <span>{detail.observations.length} observation{detail.observations.length !== 1 ? 's' : ''}</span>
                  <span className="live-session-card__stats-divider">&bull;</span>
                  <span>{detail.prompts.length} prompt{detail.prompts.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
            </article>
          )}
        </div>

        {useVirtual ? (
          <VirtualTimeline
            timelineItems={timelineItems}
            scrollElement={scrollElement}
          />
        ) : (
          <div
            className="session-detail__timeline"
            data-testid="session-detail-timeline"
          >
            {timelineItems.map((item) => renderTimelineItem(item))}
          </div>
        )}
      </div>
    </div>
  );
}
