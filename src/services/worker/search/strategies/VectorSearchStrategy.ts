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
import type { VectorDocKind } from '../../../vector/types.js';

/**
 * Anything exposing the semantic-query surface. Structural on purpose: the
 * production implementation is VectorSync, and the existing suite passes
 * hand-rolled objects carrying queryChroma alone. Depending on the concrete
 * class would break every one of those doubles for no gain, which is also why
 * the second member, getIndex(), is optional.
 */
export interface SemanticQuerySource {
  queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }>;
  /**
   * Optional. Present on VectorSync; absent on the hand-rolled test doubles,
   * which is why it is optional rather than required.
   */
  getIndex?(): SemanticIndexProbe;
}

/** The part of VectorIndex this strategy reads to tell empty from irrelevant. */
export interface SemanticIndexProbe {
  countIndexed(kind: VectorDocKind): number;
}

/**
 * Raised when the index holds no vectors for the kinds being searched while
 * the corpus itself is non-empty — the state an upgrading install sits in
 * until the one-time backfill has written its first documents.
 *
 * A thrown error rather than an empty result on purpose: callers treat an
 * empty StrategySearchResult as an answer, and the answer would be wrong.
 * SearchOrchestrator converts this into ChromaUnavailableError, the same
 * signal every other semantic-layer failure raises.
 */
export class SemanticIndexNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticIndexNotReadyError';
  }
}

const ALL_KINDS: VectorDocKind[] = ['observation', 'summary', 'prompt'];

const KINDS_BY_SEARCH_TYPE: Record<string, VectorDocKind[]> = {
  observations: ['observation'],
  sessions: ['summary'],
  prompts: ['prompt'],
};

/**
 * Semantic search backed by the in-file vector index.
 *
 * Stands in for the strategy that queried Chroma: same options in, same
 * SessionStore hydration, and the same consumed interface. Only the
 * nearest-neighbour lookup moves — in-process against claude-mem.db rather
 * than over MCP stdio to a Python subprocess.
 *
 * One case does NOT return a StrategySearchResult. A query that matches
 * nothing, against an index holding no vectors at all, over a store that does
 * have content, and with no platformSource, throws SemanticIndexNotReadyError
 * instead — see the search() body for why an empty answer would be a lie
 * there.
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

    // Fixed candidate pool, matching what the Chroma strategy always
    // requested. Hydration re-applies type / concept / file / date filters in
    // SQL, so the semantic stage must supply more candidates than the caller's
    // limit or results come back short whenever those filters bite.
    const results = await this.vectorSync.queryChroma(
      query,
      SEARCH_CONSTANTS.SEMANTIC_CANDIDATE_POOL,
      whereFilter
    );

    if (!results?.ids?.length) {
      // A platform-scoped zero is already degraded to keyword search one level
      // up, so that path is left to run; an error there would replace a usable
      // fallback with no results at all.
      if (!platformSource && this.indexIsUnpopulated(searchType)) {
        logger.warn('SEARCH', 'Semantic index holds no vectors yet; refusing to report zero matches as an answer', {
          searchType,
        });
        throw new SemanticIndexNotReadyError(
          'Semantic index is still being built (one-time backfill in progress); use keyword search until it finishes',
        );
      }
      return this.emptyResult();
    }

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

  /**
   * True when the index has nothing at all for the kinds just searched AND the
   * store has content to have indexed. Both halves matter: an index that is
   * empty because the corpus is empty returns a truthful zero, and only an
   * empty-index-over-a-non-empty-corpus is the backfill window.
   *
   * Probing is best-effort. A source without getIndex(), a store without
   * getAllProjects(), or a throwing probe all fall back to the previous
   * behaviour of reporting the zero.
   */
  private indexIsUnpopulated(searchType: string): boolean {
    try {
      const probe = this.vectorSync.getIndex?.();
      if (!probe || typeof probe.countIndexed !== 'function') return false;

      const kinds = KINDS_BY_SEARCH_TYPE[searchType] ?? ALL_KINDS;
      for (const kind of kinds) {
        if (probe.countIndexed(kind) > 0) return false;
      }
      return this.storeHasContent();
    } catch {
      return false;
    }
  }

  private storeHasContent(): boolean {
    const getAllProjects = (this.sessionStore as Partial<SessionStore>).getAllProjects;
    if (typeof getAllProjects !== 'function') return false;
    return getAllProjects.call(this.sessionStore).length > 0;
  }

  /** The Chroma filter shape, still spoken here and unpacked in VectorSync. */
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
