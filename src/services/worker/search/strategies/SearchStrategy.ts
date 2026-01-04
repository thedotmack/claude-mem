/**
 * SearchStrategy - Interface for search strategy implementations
 *
 * Each strategy implements a different approach to searching:
 * - ChromaSearchStrategy: Vector-based semantic search via Chroma
 * - SQLiteSearchStrategy: Direct SQLite queries for filter-only searches
 * - HybridSearchStrategy: Metadata filtering + semantic ranking
 */

import type { SearchResults, StrategySearchOptions, StrategySearchResult } from '../types.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Base interface for all search strategies
 */
export interface SearchStrategy {
  /**
   * Execute a search with the given options
   * @param options Search options including query and filters
   * @returns Promise resolving to categorized search results
   */
  search(options: StrategySearchOptions): Promise<StrategySearchResult>;

  /**
   * Check if this strategy can handle the given search options
   * @param options Search options to evaluate
   * @returns true if this strategy can handle the search
   */
  canHandle(options: StrategySearchOptions): boolean;

  /**
   * Strategy name for logging and debugging
   */
  readonly name: string;
}

/**
 * Abstract base class providing common functionality for strategies
 */
export abstract class BaseSearchStrategy implements SearchStrategy {
  abstract readonly name: string;

  abstract search(options: StrategySearchOptions): Promise<StrategySearchResult>;
  abstract canHandle(options: StrategySearchOptions): boolean;

  /**
   * Create an empty search result
   */
  protected emptyResult(strategy: 'chroma' | 'sqlite' | 'hybrid'): StrategySearchResult {
    return {
      results: {
        observations: [],
        sessions: [],
        prompts: []
      },
      usedChroma: strategy === 'chroma' || strategy === 'hybrid',
      fellBack: false,
      strategy
    };
  }
}
