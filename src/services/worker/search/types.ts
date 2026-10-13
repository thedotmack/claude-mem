
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange } from '../../sqlite/types.js';

export type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange };

export const SEARCH_CONSTANTS = {
  RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000,
  DEFAULT_LIMIT: 20,
  CHROMA_BATCH_SIZE: 100
} as const;

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
}

export interface CombinedResult {
  type: 'observation' | 'session' | 'prompt';
  data: SearchResult;
  epoch: number;
  created_at: string;
}
