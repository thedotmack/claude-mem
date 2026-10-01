import { Observation, Summary, UserPrompt, FeedItem } from '../types';

export function mergeAndDeduplicateByProject<T extends { id: number; project?: string }>(
  liveItems: T[],
  paginatedItems: T[]
): T[] {
  const seen = new Set<number>();
  return [...liveItems, ...paginatedItems].filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function buildFeedItems(
  observations: Observation[],
  summaries: Summary[],
  prompts: UserPrompt[]
): FeedItem[] {
  const combined: FeedItem[] = [
    ...observations.map(o => ({ ...o, itemType: 'observation' as const })),
    ...summaries.map(s => ({ ...s, itemType: 'summary' as const })),
    ...prompts.map(p => ({ ...p, itemType: 'prompt' as const }))
  ];

  return combined.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
}
