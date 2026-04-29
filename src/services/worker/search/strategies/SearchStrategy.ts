
import type { SearchResults, StrategySearchOptions, StrategySearchResult } from '../types.js';
import { logger } from '../../../../utils/logger.js';

export interface SearchStrategy {
  search(options: StrategySearchOptions): Promise<StrategySearchResult>;

  canHandle(options: StrategySearchOptions): boolean;

  readonly name: string;
}

export abstract class BaseSearchStrategy implements SearchStrategy {
  abstract readonly name: string;

  abstract search(options: StrategySearchOptions): Promise<StrategySearchResult>;
  abstract canHandle(options: StrategySearchOptions): boolean;

  protected emptyResult(strategy: 'chroma' | 'sqlite' | 'hybrid'): StrategySearchResult {
    return {
      results: {
        observations: [],
        sessions: [],
        prompts: []
      },
      usedChroma: strategy === 'chroma' || strategy === 'hybrid',
      strategy
    };
  }
}
