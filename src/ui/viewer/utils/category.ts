import { FeedItem } from '../types';

export const KNOWN_OBSERVATION_TYPES = new Set([
  'bugfix',
  'feature',
  'refactor',
  'discovery',
  'change',
  'decision',
  'security_alert',
  'security_note',
]);

export const CATEGORY_ORDER = [
  'prompt',
  'summary',
  'discovery',
  'decision',
  'bugfix',
  'feature',
  'refactor',
  'change',
  'security_alert',
  'security_note',
  'other',
] as const;

export function categoryOf(item: FeedItem): string {
  if (item.itemType === 'observation') {
    return KNOWN_OBSERVATION_TYPES.has(item.type) ? item.type : 'other';
  }
  return item.itemType;
}

export function countByCategory(items: FeedItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const category = categoryOf(item);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

export function labelForCategory(category: string): string {
  return category
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
