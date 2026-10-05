
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { FormattingService } from './FormattingService.js';
import { TimelineService } from './TimelineService.js';
import type { TimelineItem } from './TimelineService.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveDateBound } from '../../shared/date-bounds.js';
import { formatDate, formatTime, formatDateTime, formatSystemLocaleDateTime, extractFirstFile, groupByDate, estimateTokens } from '../../shared/timeline-formatting.js';
import { ModeManager } from '../domain/ModeManager.js';

import {
  SearchOrchestrator,
  SEARCH_CONSTANTS
} from './search/index.js';
import type { SearchResults, StrategySearchResult, DateRange } from './search/index.js';
import { assertSearchHasQueryOrFilter } from './search/SearchOrchestrator.js';
import { ResultFormatter } from './search/ResultFormatter.js';
import { ChromaUnavailableError } from './search/errors.js';
import { buildProjectWhereFilter, projectReadKeysFor } from './search/project-where-filter.js';

/**
 * Telemetry envelope for search_performed (see docs/public/telemetry.mdx).
 * Populated by SearchManager.search() via a mutable sink param so response
 * shapes (json and text formats) stay untouched. Privacy: counts, booleans,
 * and closed enums only — never query text, results, or error messages.
 */
export interface SearchTelemetryEnvelope {
  result_count?: number;
  search_strategy?: 'chroma' | 'fts' | 'hybrid' | 'filter_only';
  chroma_available?: boolean;
  fallback_reason?: 'none' | 'chroma_connection' | 'chroma_error' | 'chroma_not_initialized' | 'chroma_zero_results';
}

export class SearchManager {
  private orchestrator: SearchOrchestrator;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync | null,
    private formatter: FormattingService,
    private timelineService: TimelineService
  ) {
    this.orchestrator = new SearchOrchestrator(
      sessionSearch,
      sessionStore,
      chromaSync
    );
  }

  getOrchestrator(): SearchOrchestrator {
    return this.orchestrator;
  }

  getFormatter(): FormattingService {
    return this.formatter;
  }

  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  private async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    if (!this.chromaSync) {
      return { ids: [], distances: [], metadatas: [] };
    }
    return await this.chromaSync.queryChroma(query, limit, whereFilter);
  }

  /**
   * Build a Chroma where-filter scoped to a single doc_type, applying the
   * dual-project ($or: project + merged_into_project) scoping used by every
   * single-type hybrid search path.
   */
  private buildDocTypeWhereFilter(docType: string, readKeys: string[], platformSource?: string): Record<string, any> {
    const filters: Array<Record<string, any>> = [{ doc_type: docType }];
    if (readKeys.length > 0) {
      filters.push(buildProjectWhereFilter(readKeys));
    }
    if (platformSource) {
      filters.push({ platform_source: normalizePlatformSource(platformSource) });
    }
    return filters.length === 1 ? filters[0] : { $and: filters };
  }

  /**
   * Shared "Chroma semantic match -> date-window filter -> SQLite hydrate"
   * pipeline for the single-doc-type hybrid searches. Explicit ranges replace the
   * default 90-day window. Returns the hydrated rows
   * (empty when Chroma yields nothing recent); callers own their own FTS
   * fallback and formatting so per-caller behavior is preserved exactly.
   */
  private async hybridSemanticHydrate<T>(
    query: string,
    docType: string,
    project: string | undefined,
    platformSource: string | undefined,
    hydrate: (ids: number[], readKeys: string[]) => T[],
    projects?: string[],
    dateRange?: DateRange
  ): Promise<T[]> {
    const readKeys = projectReadKeysFor(this.sessionStore, project, projects);
    const whereFilter = this.buildDocTypeWhereFilter(docType, readKeys, platformSource);
    const chromaResults = await this.queryChroma(query, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE, whereFilter);
    logger.debug('SEARCH', 'Chroma returned semantic matches', { matchCount: chromaResults?.ids?.length ?? 0 });

    if (chromaResults?.ids && chromaResults.ids.length > 0) {
      const startEpoch = dateRange
        ? dateRange.start != null ? resolveDateBound(dateRange.start, 'start') : undefined
        : Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
      const endEpoch = dateRange?.end != null ? resolveDateBound(dateRange.end, 'end') : undefined;
      const recentIds = chromaResults.ids.filter((_id, idx) => {
        const meta = chromaResults.metadatas[idx];
        return meta && meta.created_at_epoch != null
          && (startEpoch === undefined || meta.created_at_epoch >= startEpoch)
          && (endEpoch === undefined || meta.created_at_epoch <= endEpoch);
      });

      logger.debug('SEARCH', dateRange ? 'Results within user date range' : 'Results within 90-day window', { count: recentIds.length });

      if (recentIds.length > 0) {
        return hydrate(recentIds, readKeys);
      }
    }
    return [];
  }

  private async searchChromaForTimeline(query: string, project?: string, platformSource?: string): Promise<ObservationSearchResult[]> {
    return this.hybridSemanticHydrate(query, 'observation', project, platformSource, (ids) =>
      this.sessionStore.getObservationsByIds(ids, { orderBy: 'relevance', limit: 1, project, platformSource })
    );
  }

  /**
   * Render a list of timeline items as grouped day -> file -> observation
   * markdown tables (with session/prompt rows interleaved). Returns the body
   * lines only; callers prepend their own title/window header. An item is the
   * anchor when its id matches a numeric anchorId (observation) or an "S{id}"
   * string anchorId (session).
   */
  private renderTimeline(
    filteredItems: TimelineItem[],
    anchorId: number | string | null,
    cwd: string
  ): string[] {
    const lines: string[] = [];

    const dayMap = new Map<string, TimelineItem[]>();
    for (const item of filteredItems) {
      const day = formatDate(item.epoch);
      if (!dayMap.has(day)) {
        dayMap.set(day, []);
      }
      dayMap.get(day)!.push(item);
    }

    const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
      const aDate = new Date(a[0]).getTime();
      const bDate = new Date(b[0]).getTime();
      return aDate - bDate;
    });

    for (const [day, dayItems] of sortedDays) {
      lines.push(`### ${day}`);
      lines.push('');

      let currentFile: string | null = null;
      let lastTime = '';
      let tableOpen = false;

      for (const item of dayItems) {
        const isAnchor = (
          (typeof anchorId === 'number' && item.type === 'observation' && item.data.id === anchorId) ||
          (typeof anchorId === 'string' && anchorId.startsWith('S') && item.type === 'session' && `S${item.data.id}` === anchorId)
        );

        if (item.type === 'session') {
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          const sess = item.data as SessionSummarySearchResult;
          const title = sess.request || 'Session summary';
          const marker = isAnchor ? ' <- **ANCHOR**' : '';

          lines.push(`**🎯 #S${sess.id}** ${title} (${formatDateTime(item.epoch)})${marker}`);
          lines.push('');
        } else if (item.type === 'prompt') {
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          const prompt = item.data as UserPromptSearchResult;
          const truncated = prompt.prompt_text.length > 100 ? prompt.prompt_text.substring(0, 100) + '...' : prompt.prompt_text;

          lines.push(`**💬 User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
          lines.push(`> ${truncated}`);
          lines.push('');
        } else if (item.type === 'observation') {
          const obs = item.data as ObservationSearchResult;
          const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);

          if (file !== currentFile) {
            if (tableOpen) {
              lines.push('');
            }

            lines.push(`**${file}**`);
            lines.push(`| ID | Time | T | Title | Tokens |`);
            lines.push(`|----|------|---|-------|--------|`);

            currentFile = file;
            tableOpen = true;
            lastTime = '';
          }

          const icon = ModeManager.getInstance().getTypeIcon(obs.type);

          const time = formatTime(item.epoch);
          const title = obs.title || 'Untitled';
          const tokens = estimateTokens(obs.narrative);

          const showTime = time !== lastTime;
          const timeDisplay = showTime ? time : '"';
          lastTime = time;

          const anchorMarker = isAnchor ? ' <- **ANCHOR**' : '';
          lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title}${anchorMarker} | ~${tokens} |`);
        }
      }

      if (tableOpen) {
        lines.push('');
      }
    }

    return lines;
  }

  private normalizeParams(args: any): any {
    const normalized: any = { ...args };

    if (normalized.filePath && !normalized.files) {
      normalized.files = normalized.filePath;
      delete normalized.filePath;
    }

    if (normalized.concept && !normalized.concepts) {
      normalized.concepts = normalized.concept;
      delete normalized.concept;
    }

    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obs_type = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    const dateStart = normalized.dateStart ?? normalized.date_start ?? normalized.date_from;
    const dateEnd = normalized.dateEnd ?? normalized.date_end ?? normalized.date_to;
    if (dateStart || dateEnd) {
      normalized.dateRange = {
        start: dateStart,
        end: dateEnd
      };
    }
    delete normalized.dateStart;
    delete normalized.dateEnd;
    delete normalized.date_start;
    delete normalized.date_end;
    delete normalized.date_from;
    delete normalized.date_to;

    if (normalized.isFolder === 'true') {
      normalized.isFolder = true;
    } else if (normalized.isFolder === 'false') {
      normalized.isFolder = false;
    }

    // Source-scoping (#2389): normalize the platform_source filter so that a
    // codex/cursor/etc. agent only sees its own memory. Accept both the
    // camelCase API param and the snake_case column name for robustness.
    const rawPlatformSource = normalized.platformSource ?? normalized.platform_source;
    if (typeof rawPlatformSource === 'string' && rawPlatformSource.trim()) {
      normalized.platformSource = normalizePlatformSource(rawPlatformSource);
    } else {
      delete normalized.platformSource;
    }
    delete normalized.platform_source;

    return normalized;
  }

  /**
   * Reconcile the overloaded `type` param with `obs_type`.
   *
   * `type` is used two ways: as a document-category selector
   * ('observations' | 'sessions' | 'prompts'), and — per the MCP schema, which
   * documents it as "filter by observation type" — as an observation-type
   * filter. The real observation-type filter is `obs_type`, which reaches
   * SQLite as a `type IN (...)` condition with no allowlist, so custom types
   * work through it. But a custom `type` value matched no category, turned off
   * every collection, and returned nothing.
   *
   * Resolution: if every `type` value is a known category, use it as the
   * category selector (unchanged behavior). Otherwise treat it as an alias for
   * `obs_type` (merged with any explicit obs_type), and scope the search to
   * observations — the only category obs_type applies to.
   */
  private resolveTypeFilters(type: any, obs_type: any): { category: any; effectiveObsType: any } {
    const CATEGORY_TYPES = ['observations', 'sessions', 'prompts'];

    if (type == null) {
      return { category: type, effectiveObsType: obs_type };
    }

    const typeValues = Array.isArray(type) ? type : [type];
    const isCategorySelector = typeValues.length > 0 && typeValues.every(t => CATEGORY_TYPES.includes(t));

    if (isCategorySelector) {
      return { category: type, effectiveObsType: obs_type };
    }

    const existingObsType = Array.isArray(obs_type)
      ? obs_type
      : (obs_type != null ? [obs_type] : []);
    const mergedObsType = Array.from(new Set([...existingObsType, ...typeValues]));

    return { category: 'observations', effectiveObsType: mergedObsType };
  }

  /**
   * PATH 2 body for search(): Chroma semantic query -> date-window filter ->
   * SQLite hydration. Categories left empty here (no Chroma match, or every hit
   * dropped by the date window or a filter) are refilled by search() through
   * SearchOrchestrator.supplementEmptyCategories. Extracted so search()'s try
   * block stays narrow; any error here is handled by search()'s Chroma-failure
   * fallback.
   */
  private async performChromaSemanticSearch(
    query: string,
    whereFilter: Record<string, any> | undefined,
    options: any,
    scope: {
      obs_type: any;
      concepts: any;
      files: any;
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
    }
  ): Promise<SearchResults> {
    const { obs_type, concepts, files, searchObservations, searchSessions, searchPrompts } = scope;
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    // Hydration applies `limit`, so a requested date order has to reach it; otherwise the wrong
    // end of the candidates is kept (date_asc hydrated newest-first keeps the newest rows).
    const requestedDateOrder: 'date_desc' | 'date_asc' | undefined =
      options.orderBy === 'date_desc' || options.orderBy === 'date_asc' ? options.orderBy : undefined;
    const chromaResults = await this.queryChroma(query, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE, whereFilter);
    logger.debug('SEARCH', 'ChromaDB returned semantic matches', { matchCount: chromaResults.ids.length });

    if (chromaResults.ids.length > 0) {
      const { dateRange } = options;
      let startEpoch: number | undefined;
      let endEpoch: number | undefined;

      if (dateRange) {
        if (dateRange.start) {
          startEpoch = resolveDateBound(dateRange.start, 'start');
        }
        if (dateRange.end) {
          endEpoch = resolveDateBound(dateRange.end, 'end');
        }
      } else {
        startEpoch = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
      }

      const recentMetadata = chromaResults.metadatas.map((meta, idx) => ({
        id: chromaResults.ids[idx],
        meta,
        isRecent: meta && meta.created_at_epoch != null
          && (!startEpoch || meta.created_at_epoch >= startEpoch)
          && (!endEpoch || meta.created_at_epoch <= endEpoch)
      })).filter(item => item.isRecent);

      logger.debug('SEARCH', dateRange ? 'Results within user date range' : 'Results within 90-day window', { count: recentMetadata.length });

      const obsIds: number[] = [];
      const sessionIds: number[] = [];
      const promptIds: number[] = [];

      for (const item of recentMetadata) {
        const docType = item.meta?.doc_type;
        if (docType === 'observation' && searchObservations) {
          obsIds.push(item.id);
        } else if (docType === 'session_summary' && searchSessions) {
          sessionIds.push(item.id);
        } else if (docType === 'user_prompt' && searchPrompts) {
          promptIds.push(item.id);
        }
      }

      if (obsIds.length > 0) {
        const obsOptions = { ...options, type: obs_type, concepts, files, orderBy: requestedDateOrder ?? 'relevance' };
        observations = this.sessionStore.getObservationsByIds(obsIds, obsOptions);
        if (!requestedDateOrder) {
          observations.sort((a, b) => obsIds.indexOf(a.id) - obsIds.indexOf(b.id));
        }
      }
      if (sessionIds.length > 0) {
        sessions = this.sessionStore.getSessionSummariesByIds(sessionIds, {
          orderBy: requestedDateOrder ?? 'date_desc',
          limit: options.limit,
          project: options.project,
          projects: options.projects,
          platformSource: options.platformSource
        });
      }
      if (promptIds.length > 0) {
        prompts = this.sessionStore.getUserPromptsByIds(promptIds, {
          orderBy: requestedDateOrder ?? 'date_desc',
          limit: options.limit,
          project: options.project,
          projects: options.projects,
          platformSource: options.platformSource
        });
      }
    }

    return { observations, sessions, prompts };
  }

  /**
   * Exact selection for a date-ordered search on the Chroma path (#4135). Chroma picks its
   * top-N candidates by relevance, so re-sorting only those by date misses the newest (or
   * oldest) matches outside them. Each requested category is unioned with its FTS5 keyword
   * matches, which SQL selects by date, then deduped by id, sorted by date and cut to `limit`.
   */
  private mergeKeywordMatchesByDate(
    query: string,
    dateOrder: 'date_desc' | 'date_asc',
    chromaResults: SearchResults,
    observationOptions: any,
    options: any,
    scope: { searchObservations: boolean; searchSessions: boolean; searchPrompts: boolean }
  ): SearchResults {
    const limit = options.limit || SEARCH_CONSTANTS.DEFAULT_LIMIT;
    const byDate = (a: { created_at_epoch: number }, b: { created_at_epoch: number }) =>
      dateOrder === 'date_desc' ? b.created_at_epoch - a.created_at_epoch : a.created_at_epoch - b.created_at_epoch;
    const mergeByDate = <T extends { id: number; created_at_epoch: number }>(chromaRows: T[], keywordRows: T[]): T[] => {
      const rowsById = new Map<number, T>();
      for (const row of [...chromaRows, ...keywordRows]) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
      return Array.from(rowsById.values()).sort(byDate).slice(0, limit);
    };

    return {
      observations: scope.searchObservations
        ? mergeByDate(chromaResults.observations, this.sessionSearch.searchObservations(query, { ...observationOptions, orderBy: dateOrder, limit }))
        : chromaResults.observations,
      sessions: scope.searchSessions
        ? mergeByDate(chromaResults.sessions, this.sessionSearch.searchSessions(query, { ...options, orderBy: dateOrder, limit }))
        : chromaResults.sessions,
      prompts: scope.searchPrompts
        ? mergeByDate(chromaResults.prompts, this.sessionSearch.searchUserPrompts(query, { ...options, orderBy: dateOrder, limit }))
        : chromaResults.prompts,
    };
  }

  async search(args: any, telemetryOut?: SearchTelemetryEnvelope): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, type, obs_type, concepts, files, format, ...options } = normalized;
    // Gate P2-5: every key the requested projects are stored under, so a
    // checkout's search reaches what it wrote before a re-key. The SQLite paths
    // receive the same list (scopedProjects prefers `projects` over `project`).
    const projectReadKeys = projectReadKeysFor(this.sessionStore, options.project, options.projects);
    if (projectReadKeys.length > 0) {
      options.projects = projectReadKeys;
    } else {
      delete options.projects;
    }
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];
    let chromaFailed = false;
    let chromaSupplementStrategy: StrategySearchResult['strategy'] = 'chroma';
    let chromaFailureReason: { message: string; isConnectionError: boolean } | null = null;

    // `type` historically doubles as a document-category selector
    // ('observations' | 'sessions' | 'prompts'). But it is documented in the
    // MCP schema as "filter by observation type", so callers routinely pass a
    // custom observation type (e.g. 'bugfix') here. Left as-is, such a value
    // matches none of the three categories, zeroes every collection boolean,
    // and returns nothing. Reconcile the two meanings: when `type` is not one
    // of the known categories, treat it as an alias for `obs_type` and scope
    // the search to observations, so the documented behavior actually holds.
    const { category, effectiveObsType } = this.resolveTypeFilters(type, obs_type);
    assertSearchHasQueryOrFilter({
      query,
      project: options.project ?? options.projects?.[0],
      platformSource: options.platformSource,
      dateRange: options.dateRange,
      obsType: effectiveObsType,
      concepts,
      files,
    });

    const searchObservations = !category || category === 'observations';
    const searchSessions = !category || category === 'sessions';
    const searchPrompts = !category || category === 'prompts';

    if (!query) {
      logger.debug('SEARCH', 'Filter-only query (no query text), using direct SQLite filtering', { enablesDateFilters: true });
      const obsOptions = { ...options, type: effectiveObsType, concepts, files };
      if (searchObservations) {
        observations = this.sessionSearch.searchObservations(undefined, obsOptions);
      }
      if (searchSessions) {
        sessions = this.sessionSearch.searchSessions(undefined, options);
      }
      if (searchPrompts) {
        prompts = this.sessionSearch.searchUserPrompts(undefined, options);
      }
    }
    // PATH 2: CHROMA SEMANTIC SEARCH (query text + Chroma available)
    else if (this.chromaSync) {
      let chromaSucceeded = false;
      logger.debug('SEARCH', 'Using ChromaDB semantic search', { typeFilter: category || 'all' });

      const whereFilters: Array<Record<string, any>> = [];
      if (category === 'observations') {
        whereFilters.push({ doc_type: 'observation' });
      } else if (category === 'sessions') {
        whereFilters.push({ doc_type: 'session_summary' });
      } else if (category === 'prompts') {
        whereFilters.push({ doc_type: 'user_prompt' });
      }

      if (projectReadKeys.length > 0) {
        whereFilters.push(buildProjectWhereFilter(projectReadKeys));
      }

      if (options.platformSource) {
        whereFilters.push({ platform_source: normalizePlatformSource(options.platformSource) });
      }

      const whereFilter = whereFilters.length === 0
        ? undefined
        : whereFilters.length === 1
          ? whereFilters[0]
          : { $and: whereFilters };

      try {
        const chromaResults = await this.performChromaSemanticSearch(query, whereFilter, options, { obs_type: effectiveObsType, concepts, files, searchObservations, searchSessions, searchPrompts });
        chromaSucceeded = true;
        // Same fallback policy as the orchestrator pipeline: SQLite refills every requested
        // category Chroma left empty, or answers alone when Chroma left them all empty.
        const supplemented = await this.orchestrator.supplementEmptyCategories(
          {
            ...options,
            query,
            searchType: category ?? 'all',
            obsType: effectiveObsType,
            concepts,
            files,
            orderBy: options.orderBy ?? 'relevance',
          },
          { results: chromaResults, usedChroma: true, strategy: 'chroma' }
        );
        ({ observations, sessions, prompts } = supplemented.results);
        chromaSupplementStrategy = supplemented.strategy;
      } catch (chromaError) {
        const errorObject = chromaError instanceof Error ? chromaError : new Error(String(chromaError));
        chromaFailureReason = {
          message: errorObject.message,
          isConnectionError: chromaError instanceof ChromaUnavailableError,
        };
        logger.warn('SEARCH', 'ChromaDB semantic search failed, falling back to FTS5 keyword search', {}, errorObject);
        chromaFailed = true;

        // As on the Chroma-less path below: a keyword search that fails too
        // leaves an empty answer, not a failed request.
        try {
          if (searchObservations) {
            observations = this.sessionSearch.searchObservations(query, { ...options, type: effectiveObsType, concepts, files });
          }
          if (searchSessions) {
            sessions = this.sessionSearch.searchSessions(query, options);
          }
          if (searchPrompts) {
            prompts = this.sessionSearch.searchUserPrompts(query, options);
          }
        } catch (ftsError) {
          const ftsErrorObject = ftsError instanceof Error ? ftsError : new Error(String(ftsError));
          logger.error('WORKER', 'FTS5 fallback search failed after a Chroma error', {}, ftsErrorObject);
        }
      }

      if (!chromaFailed && (options.orderBy === 'date_desc' || options.orderBy === 'date_asc')) {
        ({ observations, sessions, prompts } = this.mergeKeywordMatchesByDate(
          query,
          options.orderBy,
          { observations, sessions, prompts },
          { ...options, type: effectiveObsType, concepts, files },
          options,
          { searchObservations, searchSessions, searchPrompts }
        ));
      }
    }
    // PATH 3: FTS5 KEYWORD SEARCH (Chroma not initialized)
    else if (query) {
      logger.debug('SEARCH', 'ChromaDB not initialized — falling back to FTS5 keyword search', {});
      try {
        if (searchObservations) {
          observations = this.sessionSearch.searchObservations(query, { ...options, type: effectiveObsType, concepts, files });
        }
        if (searchSessions) {
          sessions = this.sessionSearch.searchSessions(query, options);
        }
        if (searchPrompts) {
          prompts = this.sessionSearch.searchUserPrompts(query, options);
        }
      } catch (ftsError) {
        const errorObject = ftsError instanceof Error ? ftsError : new Error(String(ftsError));
        logger.error('WORKER', 'FTS5 fallback search failed', {}, errorObject);
        chromaFailed = true;
      }
    }

    const totalResults = observations.length + sessions.length + prompts.length;

    // Telemetry envelope (search_performed): derive the strategy from the
    // three paths above. Enum/count values only — never the Chroma error
    // message, query text, or result content.
    if (telemetryOut) {
      let searchStrategy: SearchTelemetryEnvelope['search_strategy'];
      let fallbackReason: SearchTelemetryEnvelope['fallback_reason'];
      if (!query) {
        // PATH 1: filter-only SQLite (no query text; Chroma never consulted)
        searchStrategy = 'filter_only';
        fallbackReason = 'none';
      } else if (this.chromaSync) {
        // PATH 2: Chroma semantic search. FTS5 answers alone on a Chroma error
        // or when Chroma left every requested category empty; 'hybrid' means
        // SQLite refilled only the categories Chroma left empty.
        if (chromaFailed) {
          searchStrategy = 'fts';
          fallbackReason = chromaFailureReason?.isConnectionError ? 'chroma_connection' : 'chroma_error';
        } else if (chromaSupplementStrategy === 'sqlite') {
          searchStrategy = 'fts';
          fallbackReason = 'chroma_zero_results';
        } else if (chromaSupplementStrategy === 'hybrid') {
          searchStrategy = 'hybrid';
          fallbackReason = 'chroma_zero_results';
        } else {
          searchStrategy = 'chroma';
          fallbackReason = 'none';
        }
      } else {
        // PATH 3: FTS5 keyword search (Chroma not initialized)
        searchStrategy = 'fts';
        fallbackReason = 'chroma_not_initialized';
      }
      telemetryOut.result_count = totalResults;
      telemetryOut.search_strategy = searchStrategy;
      telemetryOut.chroma_available = this.chromaSync !== null && !chromaFailed;
      telemetryOut.fallback_reason = fallbackReason;
    }

    if (format === 'json') {
      return {
        observations,
        sessions,
        prompts,
        totalResults,
        query: query || ''
      };
    }

    if (totalResults === 0) {
      if (chromaFailureReason !== null) {
        return {
          content: [{
            type: 'text' as const,
            text: ResultFormatter.formatChromaFailureMessage(chromaFailureReason)
          }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `No results found matching "${query}"`
        }]
      };
    }

    interface CombinedResult {
      type: 'observation' | 'session' | 'prompt';
      data: any;
      epoch: number;
      created_at: string;
    }

    const allResults: CombinedResult[] = [
      ...observations.map(obs => ({
        type: 'observation' as const,
        data: obs,
        epoch: obs.created_at_epoch,
        created_at: obs.created_at
      })),
      ...sessions.map(sess => ({
        type: 'session' as const,
        data: sess,
        epoch: sess.created_at_epoch,
        created_at: sess.created_at
      })),
      ...prompts.map(prompt => ({
        type: 'prompt' as const,
        data: prompt,
        epoch: prompt.created_at_epoch,
        created_at: prompt.created_at
      }))
    ];

    if (options.orderBy === 'date_desc') {
      allResults.sort((a, b) => b.epoch - a.epoch);
    } else if (options.orderBy === 'date_asc') {
      allResults.sort((a, b) => a.epoch - b.epoch);
    }

    const limitedResults = allResults.slice(0, options.limit || 20);

    const cwd = process.cwd();
    const resultsByDate = groupByDate(
      limitedResults,
      item => item.created_at,
      // Date orders render their day groups in that order; relevance-ordered results keep the
      // order in which each day's first (most relevant) result appears.
      { order: options.orderBy === 'date_desc' ? 'desc' : options.orderBy === 'date_asc' ? 'asc' : 'first-seen' }
    );

    const lines: string[] = [];
    lines.push(`Found ${totalResults} result(s) matching "${query}" (${observations.length} obs, ${sessions.length} sessions, ${prompts.length} prompts)`);
    lines.push('');

    for (const [day, dayResults] of resultsByDate) {
      lines.push(`### ${day}`);
      lines.push('');

      const resultsByFile = new Map<string, CombinedResult[]>();
      for (const result of dayResults) {
        let file = 'General';
        if (result.type === 'observation') {
          file = extractFirstFile(result.data.files_modified, cwd, result.data.files_read);
        }
        if (!resultsByFile.has(file)) {
          resultsByFile.set(file, []);
        }
        resultsByFile.get(file)!.push(result);
      }

      for (const [file, fileResults] of resultsByFile) {
        lines.push(`**${file}**`);
        lines.push(this.formatter.formatSearchTableHeader());

        let lastTime = '';
        for (const result of fileResults) {
          if (result.type === 'observation') {
            const formatted = this.formatter.formatObservationSearchRow(result.data as ObservationSearchResult, lastTime);
            lines.push(formatted.row);
            lastTime = formatted.time;
          } else if (result.type === 'session') {
            const formatted = this.formatter.formatSessionSearchRow(result.data as SessionSummarySearchResult, lastTime);
            lines.push(formatted.row);
            lastTime = formatted.time;
          } else {
            const formatted = this.formatter.formatUserPromptSearchRow(result.data as UserPromptSearchResult, lastTime);
            lines.push(formatted.row);
            lastTime = formatted.time;
          }
        }

        lines.push('');
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    };
  }

  private parseNumericAnchor(anchor: unknown): number | null {
    if (typeof anchor === 'number') return anchor;
    if (typeof anchor === 'string' && /^\d+$/.test(anchor.trim())) {
      return Number(anchor.trim());
    }
    return null;
  }

  async timeline(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { anchor, query, depth_before, depth_after, project, platformSource } = normalized;
    const depthBefore = depth_before != null ? Number(depth_before) : 10;
    const depthAfter = depth_after != null ? Number(depth_after) : 10;
    const anchorAsNumber = this.parseNumericAnchor(anchor);
    const cwd = process.cwd();

    if (!anchor && !query) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Error: Must provide either "anchor" or "query" parameter'
        }],
        isError: true
      };
    }

    if (anchor && query) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Error: Cannot provide both "anchor" and "query" parameters. Use one or the other.'
        }],
        isError: true
      };
    }

    let anchorId: string | number;
    let anchorEpoch: number;
    let timelineData: any;

    if (query) {
      let results: ObservationSearchResult[] = [];

      if (this.chromaSync) {
        logger.debug('SEARCH', 'Using hybrid semantic search for timeline query', {});
        try {
          results = await this.searchChromaForTimeline(query, project, platformSource);
        } catch (chromaError) {
          const errorObject = chromaError instanceof Error ? chromaError : new Error(String(chromaError));
          logger.error('WORKER', 'Chroma search failed for timeline, continuing without semantic results', {}, errorObject);
        }
      }

      if (results.length === 0) {
        try {
          const ftsResults = this.sessionSearch.searchObservations(query, { project, platformSource, limit: 1 });
          if (ftsResults.length > 0) {
            results = ftsResults;
          }
        } catch (ftsError) {
          logger.warn('SEARCH', 'FTS fallback failed for timeline', {}, ftsError instanceof Error ? ftsError : undefined);
        }
      }

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No observations found matching "${query}". Try a different search query.`
          }]
        };
      }

      const topResult = results[0];
      anchorId = topResult.id;
      anchorEpoch = topResult.created_at_epoch;
      logger.debug('SEARCH', 'Query mode: Using observation as timeline anchor', { observationId: topResult.id });
      timelineData = this.sessionStore.getTimelineAroundObservation(topResult.id, topResult.created_at_epoch, depthBefore, depthAfter, project, platformSource);
    }
    // MODE 2: Anchor-based timeline
    else if (anchorAsNumber !== null) {
      const obs = this.sessionStore.getObservationsByIds([anchorAsNumber], { project, platformSource, limit: 1 })[0] ?? null;
      if (!obs) {
        return {
          content: [{
            type: 'text' as const,
            text: `Observation #${anchorAsNumber} not found`
          }],
          isError: true
        };
      }
      anchorId = anchorAsNumber;
      anchorEpoch = obs.created_at_epoch;
      timelineData = this.sessionStore.getTimelineAroundObservation(anchorAsNumber, anchorEpoch, depthBefore, depthAfter, project, platformSource);
    } else if (typeof anchor === 'string') {
      if (anchor.startsWith('S') || anchor.startsWith('#S')) {
        const sessionId = anchor.replace(/^#?S/, '');
        const sessionNum = parseInt(sessionId, 10);
        const sessions = this.sessionStore.getSessionSummariesByIds([sessionNum], { project, platformSource });
        if (sessions.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Session #${sessionNum} not found`
            }],
            isError: true
          };
        }
        anchorEpoch = sessions[0].created_at_epoch;
        anchorId = `S${sessionNum}`;
        timelineData = this.sessionStore.getTimelineAroundTimestamp(anchorEpoch, depthBefore, depthAfter, project, platformSource);
      } else {
        const date = new Date(anchor);
        if (isNaN(date.getTime())) {
          return {
            content: [{
              type: 'text' as const,
              text: `Invalid timestamp: ${anchor}`
            }],
            isError: true
          };
        }
        anchorEpoch = date.getTime();
        anchorId = anchor;
        timelineData = this.sessionStore.getTimelineAroundTimestamp(anchorEpoch, depthBefore, depthAfter, project, platformSource);
      }
    } else {
      return {
        content: [{
          type: 'text' as const,
          text: 'Invalid anchor: must be observation ID (number), session ID (e.g., "S123"), or ISO timestamp'
        }],
        isError: true
      };
    }

    const items: TimelineItem[] = [
      ...(timelineData.observations || []).map((obs: any) => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
      ...(timelineData.sessions || []).map((sess: any) => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
      ...(timelineData.prompts || []).map((prompt: any) => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
    ];
    items.sort((a, b) => a.epoch - b.epoch);
    const filteredItems = this.timelineService.filterByDepth(items, anchorId, anchorEpoch, depthBefore, depthAfter);

    if (!filteredItems || filteredItems.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: query
            ? `Found observation matching "${query}", but no timeline context available (${depthBefore} records before, ${depthAfter} records after).`
            : `No context found around anchor (${depthBefore} records before, ${depthAfter} records after)`
        }]
      };
    }

    const lines: string[] = [];

    if (query) {
      const anchorObs = filteredItems.find(item => item.type === 'observation' && item.data.id === anchorId);
      const anchorTitle = anchorObs && anchorObs.type === 'observation' ? ((anchorObs.data as ObservationSearchResult).title || 'Untitled') : 'Unknown';
      lines.push(`# Timeline for query: "${query}"`);
      lines.push(`**Anchor:** Observation #${anchorId} - ${anchorTitle}`);
    } else {
      lines.push(`# Timeline around anchor: ${anchorId}`);
    }

    lines.push(`**Window:** ${depthBefore} records before -> ${depthAfter} records after | **Items:** ${filteredItems?.length ?? 0}`);
    lines.push('');

    lines.push(...this.renderTimeline(filteredItems, anchorId, cwd));

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    };
  }

  async searchObservations(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, ...options } = normalized;
    let results: ObservationSearchResult[] = [];

    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using hybrid semantic search (Chroma + SQLite)', {});
      try {
        const limit = options.limit || 20;
        // `projects` comes parsed from the route (#4304); the keyword fallback
        // below already reads it, so Chroma and the hydration must too (#4248).
        results = await this.hybridSemanticHydrate(query, 'observation', options.project, options.platformSource, (ids, readKeys) =>
          this.sessionStore.getObservationsByIds(ids, { ...options, orderBy: 'relevance', limit, projects: readKeys }),
          options.projects,
          options.dateRange
        );
      } catch (chromaError) {
        const errorObject = chromaError instanceof Error ? chromaError : new Error(String(chromaError));
        logger.error('WORKER', 'Chroma search failed for observations, falling back to FTS', {}, errorObject);
      }
    }

    if (results.length === 0) {
      try {
        const ftsResults = this.sessionSearch.searchObservations(query, options);
        if (ftsResults.length > 0) {
          results = ftsResults;
        }
      } catch (ftsError) {
        logger.warn('SEARCH', 'FTS fallback failed for observations', {}, ftsError instanceof Error ? ftsError : undefined);
      }
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No observations found matching "${query}"`
        }]
      };
    }

    // Relevance-ordered results (FTS/Chroma): only add day headers, never
    // reorder into chronological groups, or the most relevant match could
    // print below a less relevant but more recent one.
    const resultsByDate = groupByDate(results, obs => obs.created_at, { order: 'first-seen' });

    const lines: string[] = [];
    lines.push(`Found ${results.length} observation(s) matching "${query}"`);
    lines.push('');

    for (const [day, dayResults] of resultsByDate) {
      lines.push(`### ${day}`);
      lines.push('');
      lines.push(this.formatter.formatTableHeader());
      for (const obs of dayResults) {
        lines.push(this.formatter.formatObservationIndex(obs, 0));
      }
      lines.push('');
    }

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    };
  }

  async getRecentContext(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const project = normalized.project || getProjectContext(process.cwd()).primary;
    const parsedLimit = parseInt(String(normalized.limit ?? '3'), 10);
    const limit = parsedLimit > 0 ? parsedLimit : 3;
    const { platformSource } = normalized;

    const sessions = this.sessionStore.getRecentSessionsWithStatus(project, limit, platformSource);

    if (sessions.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `# Recent Session Context\n\nNo previous sessions found for project "${project}".`
        }]
      };
    }

    const lines: string[] = [];
    lines.push('# Recent Session Context');
    lines.push('');
    lines.push(`Showing last ${sessions.length} session(s) for **${project}**:`);
    lines.push('');

    for (const session of sessions) {
      if (!session.memory_session_id) continue;

      lines.push('---');
      lines.push('');

      if (session.has_summary) {
        const summary = this.sessionStore.getSummaryForSession(session.memory_session_id, platformSource);
        if (summary) {
          const promptLabel = summary.prompt_number ? ` (Prompt #${summary.prompt_number})` : '';
          lines.push(`**Summary${promptLabel}**`);
          lines.push('');

          if (summary.request) lines.push(`**Request:** ${summary.request}`);
          if (summary.completed) lines.push(`**Completed:** ${summary.completed}`);
          if (summary.learned) lines.push(`**Learned:** ${summary.learned}`);
          if (summary.next_steps) lines.push(`**Next Steps:** ${summary.next_steps}`);

          if (summary.files_read) {
            try {
              const filesRead = JSON.parse(summary.files_read);
              if (Array.isArray(filesRead) && filesRead.length > 0) {
                lines.push(`**Files Read:** ${filesRead.join(', ')}`);
              }
            } catch (error) {
              const errorObject = error instanceof Error ? error : new Error(String(error));
              logger.debug('WORKER', 'files_read is plain string, using as-is', {}, errorObject);
              if (summary.files_read.trim()) {
                lines.push(`**Files Read:** ${summary.files_read}`);
              }
            }
          }

          if (summary.files_edited) {
            try {
              const filesEdited = JSON.parse(summary.files_edited);
              if (Array.isArray(filesEdited) && filesEdited.length > 0) {
                lines.push(`**Files Edited:** ${filesEdited.join(', ')}`);
              }
            } catch (error) {
              const errorObject = error instanceof Error ? error : new Error(String(error));
              logger.debug('WORKER', 'files_edited is plain string, using as-is', {}, errorObject);
              if (summary.files_edited.trim()) {
                lines.push(`**Files Edited:** ${summary.files_edited}`);
              }
            }
          }

          const date = formatSystemLocaleDateTime(summary.created_at);
          lines.push(`**Date:** ${date}`);
        }
      } else if (session.status === 'active') {
        lines.push('**In Progress**');
        lines.push('');

        if (session.user_prompt) {
          lines.push(`**Request:** ${session.user_prompt}`);
        }

        const observations = this.sessionStore.getObservationsForSession(session.memory_session_id, platformSource);
        if (observations.length > 0) {
          lines.push('');
          lines.push(`**Observations (${observations.length}):**`);
          for (const obs of observations) {
            lines.push(`- ${obs.title}`);
          }
        } else {
          lines.push('');
          lines.push('*No observations yet*');
        }

        lines.push('');
        lines.push('**Status:** Active - summary pending');

        const date = formatSystemLocaleDateTime(session.started_at);
        lines.push(`**Date:** ${date}`);
      } else {
        lines.push(`**${session.status.charAt(0).toUpperCase() + session.status.slice(1)}**`);
        lines.push('');

        if (session.user_prompt) {
          lines.push(`**Request:** ${session.user_prompt}`);
        }

        lines.push('');
        lines.push(`**Status:** ${session.status} - no summary available`);

        const date = formatSystemLocaleDateTime(session.started_at);
        lines.push(`**Date:** ${date}`);
      }

      lines.push('');
    }

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    };
  }

  async getTimelineByQuery(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, mode = 'auto', limit = 5, project, platformSource } = normalized;

    if (mode !== 'interactive') {
      return this.timeline(args);
    }

    let results: ObservationSearchResult[] = [];

    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using hybrid semantic search for timeline query', {});
      try {
        results = await this.hybridSemanticHydrate(query, 'observation', project, platformSource, (ids) =>
          this.sessionStore.getObservationsByIds(ids, { orderBy: 'relevance', limit, project, platformSource })
        );
      } catch (chromaError) {
        const errorObject = chromaError instanceof Error ? chromaError : new Error(String(chromaError));
        logger.error('WORKER', 'Chroma search failed for timeline by query, falling back to FTS', {}, errorObject);
      }
    }

    if (results.length === 0) {
      try {
        const ftsResults = this.sessionSearch.searchObservations(query, { project, platformSource, limit });
        if (ftsResults.length > 0) {
          results = ftsResults;
        }
      } catch (ftsError) {
        logger.warn('SEARCH', 'FTS fallback failed for timeline by query', {}, ftsError instanceof Error ? ftsError : undefined);
      }
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No observations found matching "${query}". Try a different search query.`
        }]
      };
    }

    const lines: string[] = [];
    lines.push(`# Timeline Anchor Search Results`);
    lines.push('');
    lines.push(`Found ${results.length} observation(s) matching "${query}"`);
    lines.push('');
    lines.push(`To get timeline context around any of these observations, use the \`get_context_timeline\` tool with the observation ID as the anchor.`);
    lines.push('');
    lines.push(`**Top ${results.length} matches:**`);
    lines.push('');

    for (let i = 0; i < results.length; i++) {
      const obs = results[i];
      const title = obs.title || `Observation #${obs.id}`;
      const date = formatSystemLocaleDateTime(obs.created_at_epoch);
      const type = obs.type ? `[${obs.type}]` : '';

      lines.push(`${i + 1}. **${type} ${title}**`);
      lines.push(`   - ID: ${obs.id}`);
      lines.push(`   - Date: ${date}`);
      if (obs.subtitle) {
        lines.push(`   - ${obs.subtitle}`);
      }
      lines.push('');
    }

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    };
  }
}
