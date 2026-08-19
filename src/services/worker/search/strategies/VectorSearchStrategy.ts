import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { VectorIndex } from '../../../vector/VectorIndex.js';
import type { VectorDocKind } from '../../../vector/types.js';
import { logger } from '../../../../utils/logger.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';

/**
 * Semantic search backed by the in-file vector index.
 *
 * Drop-in replacement for ChromaSearchStrategy: same options in, same
 * StrategySearchResult out, same SessionStore hydration. The only thing that
 * changes is where the nearest-neighbour lookup happens — in-process against
 * claude-mem.db instead of over MCP stdio to a Python subprocess.
 *
 * `strategy: 'chroma'` and `usedChroma` are kept deliberately. They are read by
 * SearchOrchestrator and HybridSearchStrategy, and renaming them would ripple
 * through files this change has no other reason to touch. They now read as
 * "semantic search was used"; a rename is a clean follow-up, not part of this.
 */
export class VectorSearchStrategy {
  constructor(
    private vectorIndex: VectorIndex,
    private sessionStore: SessionStore
  ) {}

  private emptyResult(): StrategySearchResult {
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: true,
      strategy: 'chroma'
    };
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
      platformSource,
      orderBy = 'date_desc'
    } = options;

    if (!query) return this.emptyResult();

    const kinds: VectorDocKind[] = [];
    if (searchType === 'all' || searchType === 'observations') kinds.push('observation');
    if (searchType === 'all' || searchType === 'sessions') kinds.push('summary');
    if (searchType === 'all' || searchType === 'prompts') kinds.push('prompt');
    if (kinds.length === 0) return this.emptyResult();

    logger.debug('SEARCH', 'VectorSearchStrategy: querying in-file index', { query, searchType });

    // Over-fetch: hydration re-applies type/concept/file/date filters in SQL,
    // so the vector stage must hand it more candidates than the final limit.
    const hits = await this.vectorIndex.query({
      text: query,
      kinds,
      project,
      platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined,
      limit: limit * SEARCH_CONSTANTS.OVERFETCH_FACTOR,
    });

    if (hits.length === 0) return this.emptyResult();

    // Preserve rank order while de-duplicating: one row can produce several
    // documents (narrative, text, per-fact), and the best-scoring one wins.
    const obsIds: number[] = [];
    const sessionIds: number[] = [];
    const promptIds: number[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const key = `${hit.kind}:${hit.sqliteId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hit.kind === 'observation') obsIds.push(hit.sqliteId);
      else if (hit.kind === 'summary') sessionIds.push(hit.sqliteId);
      else promptIds.push(hit.sqliteId);
    }

    const shared = { orderBy, limit, project, platformSource };
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    if (obsIds.length > 0) {
      observations = this.sessionStore.getObservationsByIds(obsIds, {
        type: obsType, concepts, files, ...shared
      });
    }
    if (sessionIds.length > 0) {
      sessions = this.sessionStore.getSessionSummariesByIds(sessionIds, shared);
    }
    if (promptIds.length > 0) {
      prompts = this.sessionStore.getUserPromptsByIds(promptIds, shared);
    }

    return {
      results: { observations, sessions, prompts },
      usedChroma: true,
      strategy: 'chroma'
    };
  }
}
