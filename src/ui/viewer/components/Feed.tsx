import React, { useMemo } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { PromptCard } from './PromptCard';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  processingSessions: Set<string>;
  currentFilter: string;
}

type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export function Feed({ observations, summaries, prompts, processingSessions, currentFilter }: FeedProps) {
  const items = useMemo<FeedItem[]>(() => {
    const filtered = currentFilter
      ? observations.filter(o => o.project === currentFilter)
      : observations;

    const filteredSummaries = currentFilter
      ? summaries.filter(s => s.project === currentFilter)
      : summaries;

    // For now, don't filter prompts by project since they don't have a project field directly
    // We can enhance this later if needed
    const filteredPrompts = prompts;

    // Combine and sort by timestamp
    const combined = [
      ...filtered.map(o => ({ ...o, itemType: 'observation' as const })),
      ...filteredSummaries.map(s => ({ ...s, itemType: 'summary' as const })),
      ...filteredPrompts.map(p => ({ ...p, itemType: 'prompt' as const }))
    ];

    return combined
      .sort((a, b) => b.created_at_epoch - a.created_at_epoch)
      .slice(0, 100);
  }, [observations, summaries, prompts, currentFilter]);

  return (
    <div className="feed">
      <div className="feed-content">
        {items.map(item => {
          if (item.itemType === 'observation') {
            return <ObservationCard key={`obs-${item.id}`} observation={item} />;
          } else if (item.itemType === 'summary') {
            return <SummaryCard key={`sum-${item.id}`} summary={item} />;
          } else {
            const isProcessing = processingSessions.has(item.claude_session_id);
            return <PromptCard key={`prompt-${item.id}`} prompt={item} isProcessing={isProcessing} />;
          }
        })}
        {items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
            No items to display
          </div>
        )}
      </div>
    </div>
  );
}
