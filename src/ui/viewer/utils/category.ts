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
  'sensitive',
]);

/** The kinds a timeline row can be filtered by, in their fixed order. The one definition of a row's kind. */
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
  'sensitive',
  'other',
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

export function categoryOf(item: FeedItem): Category {
  if (item.itemType === 'observation') {
    // Every known type is also a category (tests/viewer/category.test.ts checks both lists against the code modes).
    return KNOWN_OBSERVATION_TYPES.has(item.type) ? item.type as Category : 'other';
  }
  return item.itemType;
}

export function countByCategory(items: FeedItem[]): Partial<Record<Category, number>> {
  const counts: Partial<Record<Category, number>> = {};
  for (const item of items) {
    const category = categoryOf(item);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}
