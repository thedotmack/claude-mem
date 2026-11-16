import type { FeedItem, UserPrompt } from '../types';
import { CATEGORY_ORDER, type Category } from './category';

export const feedItemKey = (item: FeedItem): string => `${item.itemType}-${item.id}`;

type PromptItem = UserPrompt & { itemType: 'prompt' };

const promptWords = (prompt: UserPrompt) => prompt.prompt_text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Fold a prompt typed several times in a row into one row. "In a row" means no
 * different prompt came between them in the loaded timeline (observations and
 * summaries in between do not count); the newest stays in its place and carries
 * the older ones, newest first, so every time is still one click away.
 */
export function foldPromptRepeats(items: FeedItem[]): { rows: FeedItem[]; repeats: Map<string, PromptItem[]> } {
  const rows: FeedItem[] = [];
  const repeats = new Map<string, PromptItem[]>();
  let lastPrompt: PromptItem | null = null;
  for (const item of items) {
    if (item.itemType !== 'prompt') { rows.push(item); continue; }
    if (lastPrompt && promptWords(lastPrompt) === promptWords(item)) {
      const key = feedItemKey(lastPrompt);
      repeats.set(key, [...(repeats.get(key) ?? []), item]);
      continue;
    }
    lastPrompt = item;
    rows.push(item);
  }
  return { rows, repeats };
}

/**
 * The one counting rule for the timeline: memories, not drawn rows. A prompt
 * folded into "<n> times in a row" still counts each time, so the kind chips, the
 * "<n> of <m>" line, the pinned bar and the end line all count the same things.
 * Returns, for each row, how many memories come before it.
 */
export function memoriesBefore(rows: FeedItem[], repeats: Map<string, unknown[]>): number[] {
  const before: number[] = [];
  let count = 0;
  for (const row of rows) {
    before.push(count);
    count += 1 + (repeats.get(feedItemKey(row))?.length ?? 0);
  }
  return before;
}

/**
 * What the feed shows after its rows. One writer: feedEnding() below.
 *
 *   loading ──page arrives──> null | more | end | empty
 *   loading ──page fails────> failed ──Retry──> loading
 *   null ──end scrolls into view──> loading        more ──"Load older memories"──> loading
 *
 * `null`: more rows load by themselves when the end scrolls into view, so only the
 * invisible trigger is drawn. `more`: the same point while a filter or search is on;
 * the reader asks for the next page with a button (under the empty words when no
 * loaded row matches). `empty`: no rows and nothing more to load.
 */
export const FEED_ENDINGS = ['loading', 'empty', 'failed', 'more', 'end'] as const;
export type FeedEnding = (typeof FEED_ENDINGS)[number];

/**
 * The words for each ending. A failed load keeps its own reason folded under Details (G17); the end at the
 * server's cap says so instead.
 */
export const FEED_ENDING_WORDS: Record<FeedEnding, string> = {
  loading: 'Loading more...',
  empty: 'No observations to show',
  failed: 'Could not load more memories.',
  more: 'Load older memories',
  end: 'No more items to load',
};

export function feedEnding({ rowCount, isLoading, hasMore, loadError, autoLoad = true }: {
  rowCount: number; isLoading: boolean; hasMore: boolean; loadError?: string | null; autoLoad?: boolean;
}): FeedEnding | null {
  if (isLoading) return 'loading';
  if (loadError) return 'failed';
  if (hasMore) return autoLoad ? null : 'more';
  return rowCount === 0 ? 'empty' : 'end';
}

/** Every searchable word of a feed row, lower-cased. */
function searchableText(item: FeedItem): string {
  const parts = item.itemType === 'observation'
    ? [item.title, item.subtitle, item.narrative, item.facts, item.project, item.type]
    : item.itemType === 'summary'
      ? [item.request, item.investigated, item.learned, item.completed, item.next_steps, item.notes, item.project]
      : [item.prompt_text, item.project];
  return parts.filter(Boolean).join('\n').toLowerCase();
}

/** True when every word of the query appears somewhere in the row (case-insensitive). */
export function matchesSearch(item: FeedItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = searchableText(item);
  return words.every(word => text.includes(word));
}

/** Kinds that have rows, most rows first (UI UX Pro Max content-priority); ties keep the fixed order. */
export function kindsByCount(counts: Partial<Record<Category, number>>, keep: Iterable<Category> = []): Category[] {
  const kept = new Set(keep);
  return CATEGORY_ORDER
    .filter(category => (counts[category] ?? 0) > 0 || kept.has(category))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
}
