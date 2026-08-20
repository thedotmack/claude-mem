import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';

/**
 * Anything exposing the semantic-query surface. Structural on purpose: the
 * production implementation is VectorSync, and the existing suite passes
 * hand-rolled objects with just this method. Depending on the concrete class
 * would break every one of those mocks for no gain.
 */
export interface SemanticQuerySource {
  queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }>;
}

/**
 * Semantic search backed by the in-file vector index.
 *
 * Drop-in for ChromaSearchStrategy: same options in, same StrategySearchResult
 * out, same SessionStore hydration, and the same consumed interface. Only the
 * nearest-neighbour lookup moves — in-process against claude-mem.db rather than
 * over MCP stdio to a Python subprocess.
 *
 * `strategy: 'chroma'` and `usedChroma` are kept deliberately. Both are read by
 * SearchOrchestrator and HybridSearchStrategy; renaming them would pull files
 * into this change that have no other reason to move. They now read as
 * "semantic search was used"; the rename is a clean follow-up.
 */
export class VectorSearchStrategy {
  constructor(
    private vectorSync: SemanticQuerySource,
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
      dateRange,
      orderBy = 'date_desc'
    } = options;

    if (!query) return this.emptyResult();

    const whereFilter = this.buildWhereFilter(searchType, project, platformSource);

    logger.debug('SEARCH', 'VectorSearchStrategy: querying in-file index', { query, searchType });

    // Over-fetch: hydration re-applies type / concept / file / date filters in
    // SQL, so the semantic stage must supply more candidates than the caller's
    // limit or results come back short whenever those filters bite.
    const results = await this.vectorSync.queryChroma(
      query,
      limit * SEARCH_CONSTANTS.OVERFETCH_FACTOR,
      whereFilter
    );

    if (!results?.ids?.length) return this.emptyResult();

    // Recency window, matching the previous strategy's filterByRecency.
    const startEpoch = dateRange?.start ?? (Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS);
    const endEpoch = dateRange?.end;

    const obsIds: number[] = [];
    const sessionIds: number[] = [];
    const promptIds: number[] = [];
    const seen = new Set<string>();

    results.ids.forEach((id, idx) => {
      const meta = results.metadatas?.[idx];
      if (!meta) return;
      const epoch = meta.created_at_epoch;
      if (epoch != null) {
        if (startEpoch && epoch < startEpoch) return;
        if (endEpoch && epoch > endEpoch) return;
      }
      // One row can yield several documents (narrative, per-fact), so keep the
      // best-scoring occurrence and preserve rank order.
      const key = `${meta.doc_type}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);

      if (meta.doc_type === 'observation') obsIds.push(id);
      else if (meta.doc_type === 'session_summary') sessionIds.push(id);
      else if (meta.doc_type === 'user_prompt') promptIds.push(id);
    });

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

  /** Identical filter shape to ChromaSearchStrategy.buildWhereFilter. */
  private buildWhereFilter(
    searchType: string,
    project?: string,
    platformSource?: string
  ): Record<string, any> | undefined {
    const filters: Array<Record<string, any>> = [];

    switch (searchType) {
      case 'observations': filters.push({ doc_type: 'observation' }); break;
      case 'sessions':     filters.push({ doc_type: 'session_summary' }); break;
      case 'prompts':      filters.push({ doc_type: 'user_prompt' }); break;
      default: break;
    }

    if (project) {
      filters.push({ $or: [{ project }, { merged_into_project: project }] });
    }
    if (platformSource) {
      filters.push({ platform_source: normalizePlatformSource(platformSource) });
    }

    if (filters.length === 0) return undefined;
    if (filters.length === 1) return filters[0];
    return { $and: filters };
  }
}
