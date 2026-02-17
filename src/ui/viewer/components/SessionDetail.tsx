import React from 'react';
import type { Observation, UserPrompt, SessionDetail as SessionDetailType } from '../types';
import { SummaryCard } from './SummaryCard';
import { ObservationCard } from './ObservationCard';
import { PromptCard } from './PromptCard';

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
 * created_at_epoch ascending (chronological order).
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

  return items.sort((a, b) => a.created_at_epoch - b.created_at_epoch);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  detail: SessionDetailType | null;
  isLoading: boolean;
}

export function SessionDetail({ detail, isLoading }: SessionDetailProps) {
  if (isLoading) {
    return (
      <div className="session-detail" data-testid="session-detail">
        <div className="session-detail__loading">
          <div className="spinner session-detail__loading-spinner" />
          Loading session...
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="session-detail" data-testid="session-detail">
        <div className="session-detail__empty" data-testid="session-detail-empty">
          Select a session to view details
        </div>
      </div>
    );
  }

  const timelineItems = buildTimeline(detail.observations, detail.prompts);

  return (
    <div className="session-detail" data-testid="session-detail">
      <div className="session-detail__content">
        <div className="session-detail__summary">
          <SummaryCard summary={detail.summary} />
        </div>

        <div className="session-detail__timeline" data-testid="session-detail-timeline">
          {timelineItems.map((item) => {
            const key = `${item.itemType}-${String(item.id)}`;
            if (item.itemType === 'observation') {
              return <ObservationCard key={key} observation={item} />;
            }
            return <PromptCard key={key} prompt={item} />;
          })}
        </div>
      </div>
    </div>
  );
}
