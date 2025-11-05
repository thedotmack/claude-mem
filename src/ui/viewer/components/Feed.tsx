import React, { useMemo } from 'react';
import { Observation, Summary } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  currentFilter: string;
}

type FeedItem = (Observation & { itemType: 'observation' }) | (Summary & { itemType: 'summary' });

export function Feed({ observations, summaries, currentFilter }: FeedProps) {
  const items = useMemo<FeedItem[]>(() => {
    const filtered = currentFilter
      ? observations.filter(o => o.project === currentFilter)
      : observations;

    const filteredSummaries = currentFilter
      ? summaries.filter(s => s.project === currentFilter)
      : summaries;

    // Combine and sort by timestamp
    const combined = [
      ...filtered.map(o => ({ ...o, itemType: 'observation' as const })),
      ...filteredSummaries.map(s => ({ ...s, itemType: 'summary' as const }))
    ];

    return combined
      .sort((a, b) => b.created_at_epoch - a.created_at_epoch)
      .slice(0, 100);
  }, [observations, summaries, currentFilter]);

  return (
    <div className="feed">
      {items.map(item => {
        if (item.itemType === 'observation') {
          return <ObservationCard key={`obs-${item.id}`} observation={item} />;
        } else {
          return <SummaryCard key={`sum-${item.id}`} summary={item} />;
        }
      })}
      {items.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
          No items to display
        </div>
      )}
    </div>
  );
}
