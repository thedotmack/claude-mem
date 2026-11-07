
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange } from '../../sqlite/types.js';

export type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange };

export const SEARCH_CONSTANTS = {
  RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000,
  DEFAULT_LIMIT: 20,
  CHROMA_BATCH_SIZE: 100
} as const;

/**
 * Parse CLAUDE_MEM_SEARCH_RECENCY_DAYS into the implicit recency window, in
 * milliseconds, that date-less semantic searches apply (the 90-day default).
 * Absent or empty keeps the default; `0` disables the window so every
 * semantic match stays eligible; a positive integer sets the window in days.
 * settings.json is hand-editable JSON and SettingsDefaultsManager leaves JSON
 * numbers untouched, so the value can also arrive as a real number: numeric
 * days parse exactly like their string spelling. A present but malformed
 * value — including an explicit null or any other non-string type — returns
 * null: the caller warns and keeps the default. An explicit `dateRange` on a
 * request always wins over this.
 */
export function parseSearchRecencyWindowMs(raw: unknown): number | null {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
  if (typeof raw === 'number') {
    const milliseconds = raw * 86_400_000;
    if (!Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(milliseconds)) return null;
    return milliseconds;
  }
  if (typeof raw !== 'string') return null;
  if (raw.trim() === '0') return 0;
  const days = Number(raw.trim());
  const milliseconds = days * 86_400_000;
  if (!Number.isInteger(days) || days < 0 || !Number.isSafeInteger(milliseconds)) return null;
  return milliseconds;
}

export type ChromaDocType = 'observation' | 'session_summary' | 'user_prompt';

export const SEARCH_CATEGORIES = ['observations', 'sessions', 'prompts'] as const;

export type SearchCategory = typeof SEARCH_CATEGORIES[number];

export type SearchSelection = SearchCategory | SearchCategory[] | 'all';

export function isCategoryRequested(
  searchType: SearchSelection | undefined,
  category: SearchCategory
): boolean {
  return !searchType || searchType === 'all' || (Array.isArray(searchType) ? searchType.includes(category) : searchType === category);
}

/** Scope the candidate budget to the selected document categories. */
export function buildCategoryWhereFilter(searchType: SearchSelection | undefined): Record<string, unknown> | undefined {
  if (!searchType || searchType === 'all') return undefined;
  const docTypes: Record<SearchCategory, ChromaDocType> = {
    observations: 'observation', sessions: 'session_summary', prompts: 'user_prompt'
  };
  const selected = Array.isArray(searchType) ? [...new Set(searchType)] : [searchType];
  return { doc_type: selected.length === 1 ? docTypes[selected[0]] : { $in: selected.map(category => docTypes[category]) } };
}

export interface ChromaMetadata {
  sqlite_id: number;
  doc_type: ChromaDocType;
  memory_session_id: string;
  project: string;
  platform_source?: string;
  created_at_epoch: number;
  type?: string;
  title?: string;
  subtitle?: string;
  concepts?: string;
  files_read?: string;
  files_modified?: string;
  field_type?: string;
  prompt_number?: number;
}

export type SearchResult = ObservationSearchResult | SessionSummarySearchResult | UserPromptSearchResult;

export interface SearchResults {
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
  prompts: UserPromptSearchResult[];
}

export interface ExtendedSearchOptions extends SearchOptions {
  searchType?: SearchSelection;
  obsType?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
  format?: 'text' | 'json';
  /**
   * Skip the implicit 90-day window Chroma results get when no dateRange is given. Corpus
   * builds set it: a corpus is defined by its stored filter, so a date-less corpus must not
   * lose everything older than 90 days each time it is rebuilt.
   */
  ignoreDefaultRecencyWindow?: boolean;
}

export type SearchStrategyHint = 'chroma' | 'sqlite' | 'hybrid' | 'auto';

export interface StrategySearchOptions extends ExtendedSearchOptions {
  query?: string;
  strategyHint?: SearchStrategyHint;
}

export interface StrategySearchResult {
  results: SearchResults;
  usedChroma: boolean;
  strategy: SearchStrategyHint;
  /** The bounded semantic prefix was insufficient; keyword hits may fill its remaining slots. */
  semanticBudgetReached?: boolean;
}

export interface CombinedResult {
  type: 'observation' | 'session' | 'prompt';
  data: SearchResult;
  epoch: number;
  created_at: string;
}
