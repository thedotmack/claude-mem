import type { FeedItem, UserPrompt } from '../types';
import { CATEGORY_ORDER, type Category } from './category';
import { hasEveryWord } from './search';
import { parseStoredStringList } from './stored-string-list';

export const feedItemKey = (item: FeedItem): string => `${item.itemType}-${item.id}`;

type PromptItem = UserPrompt & { itemType: 'prompt' };

const promptWords = (prompt: UserPrompt) => prompt.prompt_text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Fold a prompt typed several times in a row into one row. "In a row" means no
 * different prompt came between them in the loaded timeline (observations and
 * summaries in between do not count); the newest stays in its place and carries
 * the older ones, newest first, so every time is still one click away.
 *
 * `matches` (the kinds and the search) is applied after folding, over the whole
 * loaded timeline, so a search never makes prompts look typed in a row that other
 * prompts separated. A folded row stays while it or one of its repeats matches.
 */
export function foldPromptRepeats(items: FeedItem[], matches?: (item: FeedItem) => boolean): { rows: FeedItem[]; repeats: Map<string, PromptItem[]> } {
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
  if (!matches) return { rows, repeats };
  return { rows: rows.filter(row => matches(row) || (repeats.get(feedItemKey(row)) ?? []).some(matches)), repeats };
}

/** How many memories the rows hold, a folded repeat counting each time (memoriesBefore's rule). */
export function memoryCount(rows: FeedItem[], repeats: Map<string, unknown[]>): number {
  return rows.reduce((count, row) => count + 1 + (repeats.get(feedItemKey(row))?.length ?? 0), 0);
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

type Translate = (english: string) => string;

/**
 * What a list shows after its rows: the timeline, a session page and the Sessions list. One writer: feedEnding() below.
 *
 *   first-load ──first page arrives──> null | more | end | empty | no-match
 *   loading ──page arrives──> null | more | end | empty | no-match
 *   first-load | loading ──page fails────> failed ──Retry──> loading
 *   null ──end scrolls into view──> loading        more ──"Load older …"──> loading
 *
 * `first-load`: nothing is loaded yet (the timeline draws placeholder cards). `null`: more rows load by themselves
 * when the end scrolls into view, so only the invisible trigger is drawn. `more`: the same point while a filter or
 * search is on; the reader asks for the next page with a button (under the empty words when no loaded row matches).
 * `empty`: no rows and nothing more to load. `no-match`: a filter or search hides every loaded row, and nothing more
 * is left to load.
 */
export const FEED_ENDINGS = ['first-load', 'loading', 'empty', 'no-match', 'failed', 'more', 'end'] as const;
export type FeedEnding = (typeof FEED_ENDINGS)[number];

/**
 * The timeline's and a session page's words for each ending (the Sessions list has its own, SESSION_LIST_ENDING_WORDS).
 * A failed load keeps its own reason folded under Details (G17); the end at the server's cap says so instead.
 * Literal t() keys, so tests/ui-i18n.test.ts checks each one.
 */
export const FEED_ENDING_WORDS: Record<FeedEnding, (t: Translate) => string> = {
  'first-load': t => t('Loading…'),
  loading: t => t('Loading more...'),
  empty: t => t('No observations to show'),
  'no-match': t => t('No observations to show'),
  failed: t => t('Could not load more memories.'),
  more: t => t('Load older memories'),
  end: t => t('No more items to load'),
};

export function feedEnding({ rowCount, loadedCount = rowCount, isLoading, hasMore, loadError, autoLoad = true, filtered = false }: {
  /** Rows shown (after the filters and search). */
  rowCount: number;
  /** Rows loaded, shown or not; the shown rows unless a filter or search hides some. */
  loadedCount?: number;
  isLoading: boolean;
  hasMore: boolean;
  loadError?: string | null;
  autoLoad?: boolean;
  /** A filter or search is on. */
  filtered?: boolean;
}): FeedEnding | null {
  if (isLoading) return loadedCount === 0 ? 'first-load' : 'loading';
  if (loadError) return 'failed';
  if (hasMore) return autoLoad ? null : 'more';
  if (rowCount > 0) return 'end';
  return filtered && loadedCount > 0 ? 'no-match' : 'empty';
}

/**
 * Every searchable word of a feed row: what its card shows, so a word read on a card is found. An observation's
 * Facts view (facts, concepts, files read and modified) counts, as a summary's sections do, and so does every row's
 * "#id" (an observation's footer, a summary's "Session #id", a prompt's time details).
 */
function searchableText(item: FeedItem): string {
  const parts = item.itemType === 'observation'
    ? [item.title, item.subtitle, item.narrative, ...parseStoredStringList(item.facts), ...parseStoredStringList(item.concepts),
      ...parseStoredStringList(item.files_read), ...parseStoredStringList(item.files_modified), item.project, item.type]
    : item.itemType === 'summary'
      ? [item.request, item.investigated, item.learned, item.completed, item.next_steps, item.notes, item.project]
      : [item.prompt_text, item.project];
  return [...parts, `#${item.id}`].filter(Boolean).join('\n');
}

/** True when every word of the query appears somewhere in the row, in any case (the viewer's one search rule). */
export function matchesSearch(item: FeedItem, query: string): boolean {
  return hasEveryWord(searchableText(item), query);
}

/** Kinds that have rows, most rows first (UI UX Pro Max content-priority); ties keep the fixed order. */
export function kindsByCount(counts: Partial<Record<Category, number>>, keep: Iterable<Category> = []): Category[] {
  const kept = new Set(keep);
  return CATEGORY_ORDER
    .filter(category => (counts[category] ?? 0) > 0 || kept.has(category))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
}
