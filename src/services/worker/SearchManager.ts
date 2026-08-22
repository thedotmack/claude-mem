
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { VectorSync } from '../vector/VectorSync.js';
import { FormattingService } from './FormattingService.js';
import { TimelineService } from './TimelineService.js';
import type { TimelineItem } from './TimelineService.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import type { VectorDocKind } from '../vector/types.js';
import type { IndexScope } from '../vector/VectorIndex.js';
import { VECTOR_TABLES, hasColumn } from '../vector/schema.js';
import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { formatDate, formatTime, formatDateTime, extractFirstFile, groupByDate, estimateTokens } from '../../shared/timeline-formatting.js';
import { ModeManager } from '../domain/ModeManager.js';

import {
  SearchOrchestrator,
  SEARCH_CONSTANTS
} from './search/index.js';
import { ResultFormatter } from './search/ResultFormatter.js';
import { ChromaUnavailableError } from './search/errors.js';

/**
 * Telemetry envelope for search_performed (see docs/public/telemetry.mdx).
 * Populated by SearchManager.search() via a mutable sink param so response
 * shapes (json and text formats) stay untouched. Privacy: counts, booleans,
 * and closed enums only — never query text, results, or error messages.
 */
export interface SearchTelemetryEnvelope {
  result_count?: number;
  search_strategy?: 'chroma' | 'fts' | 'filter_only';
  chroma_available?: boolean;
  fallback_reason?: 'none' | 'chroma_connection' | 'chroma_error' | 'chroma_not_initialized';
}

/**
 * Content columns whose non-emptiness makes a parent row INDEXABLE — that is,
 * a row the backfill will render at least one document from.
 *
 * These are VectorBackfill's own rendering rules (SCALAR_COLUMNS, plus the
 * facts array observations render one document per non-empty string from),
 * restated because they are private to that module. The live-capture writer,
 * VectorSync, renders the same document families from the same fields under the
 * same emptiness test, so a row carrying none of this content — an observation
 * with only a title and concepts, a session_summaries row with all six text
 * fields NULL, a user_prompts row holding '' — gets a vector from neither
 * writer. Readiness has to be able to tell those apart from rows that simply
 * have not been reached yet.
 *
 * Restating rules invites drift, so the direction that drift can break in is
 * the one pinned by test: a column named here that the backfill does NOT
 * render would leave its rows counted as owed-a-vector forever and the scope
 * permanently on keyword search. tests/vector/search-index-readiness.test.ts
 * seeds a row whose only content is each of these columns, runs the real
 * VectorBackfill to completion, and requires the search to be index-backed
 * afterwards. Drift the other way — the backfill rendering something not named
 * here — costs nothing: that row gets its vector regardless and is simply not
 * required to have one.
 */
const INDEXABLE_CONTENT: Record<VectorDocKind, { scalar: string[]; jsonArray: string[] }> = {
  observation: { scalar: ['narrative', 'text'], jsonArray: ['facts'] },
  summary: {
    scalar: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'],
    jsonArray: [],
  },
  prompt: { scalar: ['prompt_text'], jsonArray: [] },
};

/**
 * A readiness verdict, with the two counters that make it stale.
 *
 * `complete` is the answer to "does every indexable in-scope row of this kind
 * carry a vector this model can read". The counters are MAX(parent.id) and
 * MAX(vector.rowid) as they stood when the answer was taken: a backfill batch
 * landing, a live capture writing a vector, or a new row arriving all move one
 * of them, which is precisely when the answer can change from "not yet" to
 * "ready" or back.
 */
interface ScopeReadiness {
  complete: boolean;
  parentMax: number;
  vectorMax: number;
  takenAt: number;
}

/**
 * Backstop for the changes the two counters above cannot see: a vector deleted
 * without any other write (VectorBackfill discards a partially written row that
 * way), and an in-place UPDATE that gives content to a row that had none. Both
 * are narrow, and both resolve within this window rather than persisting for
 * the life of the worker.
 */
const READINESS_TTL_MS = 60_000;

/** Distinct (kind, model, project, platform) scopes remembered before the map
 *  is dropped whole. A worker serving many projects re-measures rather than
 *  growing without bound. */
const READINESS_CACHE_LIMIT = 64;


/** Whether a table is present, so a readiness probe never hard-errors on an
 *  older store that has not created it yet. */
function tableExists(db: Database, table: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table) as { name: string } | undefined;
  return Boolean(row);
}

export class SearchManager {
  private orchestrator: SearchOrchestrator;

  /** Last readiness verdict per (kind, model, project, platform) scope. */
  private readonly scopeReadiness = new Map<string, ScopeReadiness>();
  /** Result of the one-time JSON1 probe; null until it has been made. */
  private jsonFunctionsAvailable: boolean | null = null;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: VectorSync | null,
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
  private buildDocTypeWhereFilter(docType: string, project?: string, platformSource?: string): Record<string, any> {
    const filters: Array<Record<string, any>> = [{ doc_type: docType }];
    if (project) {
      const projectFilter = {
        $or: [
          { project },
          { merged_into_project: project }
        ]
      };
      filters.push(projectFilter);
    }
    if (platformSource) {
      filters.push({ platform_source: normalizePlatformSource(platformSource) });
    }
    return filters.length === 1 ? filters[0] : { $and: filters };
  }

  /**
   * Shared "Chroma semantic match -> 90-day recency filter -> SQLite hydrate"
   * pipeline for the single-doc-type hybrid searches. Returns the hydrated rows
   * (empty when Chroma yields nothing recent); callers own their own FTS
   * fallback and formatting so per-caller behavior is preserved exactly.
   */
  private async hybridSemanticHydrate<T>(
    query: string,
    docType: string,
    project: string | undefined,
    platformSource: string | undefined,
    hydrate: (ids: number[]) => T[]
  ): Promise<T[]> {
    const whereFilter = this.buildDocTypeWhereFilter(docType, project, platformSource);
    const chromaResults = await this.queryChroma(query, 100, whereFilter);
    logger.debug('SEARCH', 'Chroma returned semantic matches', { matchCount: chromaResults?.ids?.length ?? 0 });

    if (chromaResults?.ids && chromaResults.ids.length > 0) {
      const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
      const recentIds = chromaResults.ids.filter((_id, idx) => {
        const meta = chromaResults.metadatas[idx];
        return meta && meta.created_at_epoch > ninetyDaysAgo;
      });

      logger.debug('SEARCH', 'Results within 90-day window', { count: recentIds.length });

      if (recentIds.length > 0) {
        return hydrate(recentIds);
      }
    }
    return [];
  }

  private async searchChromaForTimeline(query: string, project?: string, platformSource?: string): Promise<ObservationSearchResult[]> {
    return this.hybridSemanticHydrate(query, 'observation', project, platformSource, (ids) =>
      this.sessionStore.getObservationsByIds(ids, { orderBy: 'date_desc', limit: 1, project, platformSource })
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
   * The FTS5 keyword search every degraded path runs. One body, because three
   * copies of it drifting apart is how a fallback ends up scoped differently
   * from the search it is standing in for.
   */
  private keywordSearch(
    query: string | undefined,
    options: any,
    scope: {
      obs_type: any;
      concepts: any;
      files: any;
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
    }
  ): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
    prompts: UserPromptSearchResult[];
  } {
    const { obs_type, concepts, files, searchObservations, searchSessions, searchPrompts } = scope;
    return {
      observations: searchObservations
        ? this.sessionSearch.searchObservations(query, { ...options, type: obs_type, concepts, files })
        : [],
      sessions: searchSessions ? this.sessionSearch.searchSessions(query, options) : [],
      prompts: searchPrompts ? this.sessionSearch.searchUserPrompts(query, options) : [],
    };
  }

  /**
   * The vector kinds a search with these collection flags would read.
   */
  private searchedVectorKinds(scope: {
    searchObservations: boolean;
    searchSessions: boolean;
    searchPrompts: boolean;
  }): VectorDocKind[] {
    const kinds: VectorDocKind[] = [];
    if (scope.searchObservations) kinds.push('observation');
    if (scope.searchSessions) kinds.push('summary');
    if (scope.searchPrompts) kinds.push('prompt');
    return kinds;
  }

  /**
   * True when the vectors this search would read do not yet cover every row of
   * this scope that CAN carry a vector.
   *
   * Two predecessors got this wrong in opposite directions, and the shape of
   * both mistakes is the same: the question was asked about the wrong
   * population.
   *
   * The first asked `countIndexed(kind, scope) > 0` — "has the backfill
   * started". A scope with ONE row of twenty indexed does not return a zero to
   * notice downstream: it returns that one row's documents and the caller
   * reports success. Measured on a seeded store: 20 observations, 1 indexed,
   * `totalResults` 2, no fallback, 19 rows the user has silently absent.
   *
   * The second compared indexed rows against ALL in-scope rows and accepted 0.9
   * of them. Two consequences, both measured. A row that renders no document at
   * all is never given a vector by anything — VectorBackfill is built around
   * that fact — so it sat in the denominator permanently: a 20-row project with
   * 3 such rows reported 0.85 with the backfill genuinely finished, and stayed
   * on keyword search for good. And the 10% the floor allowed was not slack: at
   * 0.95 coverage the index answered and one row in twenty was quietly missing
   * from a result the caller was told was semantic.
   *
   * So the population is INDEXABLE rows — the ones that will be given a vector
   * — and the bar is all of them. A row that can never carry a vector is not
   * evidence of an unfinished index, and a row that can is not something to
   * round away. There is no partial-credit band left in which a user is told
   * "here is what we found" over a corpus the index has only most of.
   *
   * The cost of being wrong is asymmetric and that is why the bar sits at the
   * top: falling back too eagerly gives the user keyword hits on rows that
   * exist; failing to fall back tells the user that rows they have do not
   * exist. If INDEXABLE_CONTENT ever over-claims relative to what the backfill
   * renders, the failure lands on the first side — that scope keeps answering
   * from keyword search, degraded but complete.
   *
   * Best-effort by construction. The suite — and SearchOrchestrator's own
   * doubles — pass objects carrying queryChroma alone, so an absent getIndex(),
   * an index without a modelId, a store without a database handle, or a
   * throwing probe all leave the previous behaviour in place rather than
   * inventing a fallback.
   */
  private semanticScopeIsIncomplete(options: any, kinds: VectorDocKind[]): boolean {
    const getIndex = (this.chromaSync as Partial<VectorSync> | null)?.getIndex;
    if (typeof getIndex !== 'function') return false;
    try {
      const index = getIndex.call(this.chromaSync);
      const modelId = index?.modelId;
      if (typeof modelId !== 'string' || modelId.length === 0) return false;

      const db = (this.sessionStore as Partial<SessionStore> | null)?.db;
      if (!db || typeof db.prepare !== 'function') return false;

      const indexScope: IndexScope = {};
      if (options.project) indexScope.project = options.project;
      if (options.platformSource) indexScope.platformSource = normalizePlatformSource(options.platformSource);

      for (const kind of kinds) {
        const complete = this.scopeIndexIsComplete(db, kind, modelId, indexScope);
        if (complete === null || complete) continue;
        logger.debug('SEARCH', 'Vector index does not yet cover every indexable row in this scope', { kind });
        return true;
      }
      return false;
    } catch (probeError) {
      const errorObject = probeError instanceof Error ? probeError : new Error(String(probeError));
      logger.debug('SEARCH', 'Vector index readiness probe failed; treating the index as populated', {}, errorObject);
      return false;
    }
  }

  /**
   * Whether every INDEXABLE in-scope row of this kind carries a vector readable
   * by `modelId`. `null` when the question does not apply — the tables are not
   * there, this store has none of the content columns the kind renders from, or
   * the join shape is not the one this query was written against.
   *
   * Memoised, because the scan behind it is not free and the answer changes
   * only when the corpus or the index does. It ran on EVERY semantic search,
   * per searched kind, for the life of the worker — not just during the
   * one-time indexing window it exists to cover. Measured on a fully indexed
   * single-project store, in-memory SQLite, Bun 1.3.8, M-series, 20 runs:
   *
   *   corpus     per search, before      after: memo hit    after: scan
   *   20,000     36.5ms                  0.24ms             28ms
   *   100,000    200ms                   0.21ms             140ms
   *
   * A memo hit is the two MAX lookups below and a map read. The scan runs only
   * when either MAX has moved since the last verdict, or the verdict is over a
   * minute old — never more than once per search, and in a settled corpus at
   * most once a minute per scope.
   *
   * The scan itself also got cheaper, and the ordering below is why: it stops
   * at the first row still owed a vector instead of counting every row, and it
   * disposes of already-indexed rows on an index seek before any content test.
   * The shape that defeats both shortcuts — every row unindexed AND doc-less,
   * so the array term runs on all of them and nothing matches — measured 48ms
   * over 20,000 such rows.
   */
  private scopeIndexIsComplete(
    db: Database,
    kind: VectorDocKind,
    modelId: string,
    scope: IndexScope,
  ): boolean | null {
    const spec = VECTOR_TABLES[kind];
    if (!tableExists(db, spec.parent) || !tableExists(db, spec.table)) return null;

    const indexable = this.indexableSql(db, kind);
    if (indexable === null) return null;

    // Both are index maxima, so this is two B-tree seeks rather than a scan.
    const generation = db.prepare(`
      SELECT (SELECT COALESCE(MAX(id), 0) FROM ${spec.parent}) AS parentMax,
             (SELECT COALESCE(MAX(rowid), 0) FROM ${spec.table}) AS vectorMax
    `).get() as { parentMax: number; vectorMax: number };

    const key = [kind, modelId, scope.project ?? '', scope.platformSource ?? ''].join('\t');
    const cached = this.scopeReadiness.get(key);
    const now = Date.now();
    if (
      cached
      && cached.parentMax === generation.parentMax
      && cached.vectorMax === generation.vectorMax
      && now - cached.takenAt < READINESS_TTL_MS
    ) {
      return cached.complete;
    }

    // VECTOR_TABLES.joinSql is written outwards from the vector table. Readiness
    // has to ask from the parent side instead, because the rows it is looking
    // for are precisely the ones with NO vector to join from. Every hop after
    // the first is identical, so it is reused rather than restated — and a
    // joinSql that no longer opens with that hop is not something to guess
    // about.
    const firstHop = `JOIN ${spec.parent} p ON p.id = v.sqlite_id `;
    if (!spec.joinSql.startsWith(firstHop)) return null;
    const parentJoins = spec.joinSql.slice(firstHop.length);

    // Mirrors VectorIndex.scopeSql, minus its model_id clause: that one moves
    // into the NOT EXISTS below, where it decides whether a row counts as
    // indexed rather than which rows are in scope.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (scope.project) {
      const merged =
        spec.mergedExpr && spec.mergedRequires && hasColumn(db, ...spec.mergedRequires)
          ? spec.mergedExpr
          : null;
      if (merged) {
        where.push(`(${spec.projectExpr} = ? OR ${merged} = ?)`);
        params.push(scope.project, scope.project);
      } else {
        where.push(`${spec.projectExpr} = ?`);
        params.push(scope.project);
      }
    }
    if (scope.platformSource && spec.platformExpr && spec.platformRequires
        && hasColumn(db, ...spec.platformRequires)) {
      where.push(`${spec.platformExpr} = ?`);
      params.push(scope.platformSource);
    }

    // "Is there a row still owed a vector", not "how many" — so a scope that is
    // not ready stops at the first such row instead of counting them all. The
    // NOT EXISTS is written first because it is an index seek that disposes of
    // every already-indexed row before the content test is reached, which in the
    // steady state is all of them.
    const row = db.prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM ${spec.parent} p
        ${parentJoins}
        WHERE NOT EXISTS (
                SELECT 1 FROM ${spec.table} v
                WHERE v.sqlite_id = p.id AND v.model_id = ?
              )
          AND (${indexable})
          ${where.length > 0 ? `AND ${where.join(' AND ')}` : ''}
      ) AS pending
    `).get(modelId, ...params) as { pending: number } | undefined;

    const complete = !row || row.pending === 0;

    if (this.scopeReadiness.size >= READINESS_CACHE_LIMIT) this.scopeReadiness.clear();
    this.scopeReadiness.set(key, {
      complete,
      parentMax: generation.parentMax,
      vectorMax: generation.vectorMax,
      takenAt: now,
    });
    return complete;
  }

  /**
   * SQL predicate, over a parent row aliased `p`, for "this row renders at
   * least one document".
   *
   * Columns are probed rather than assumed, exactly as VectorBackfill probes
   * them: observations.text is in the base table while narrative/facts arrive
   * at schema v8, so either half can be missing depending on how old the store
   * is, and naming an absent column is a hard SQL error. `null` when this store
   * has none of them — there is then no row of this kind that could be indexed,
   * and no readiness question to answer.
   *
   * The scalar terms come first so that on ordinary rows the array term is
   * never reached. The array term matches VectorBackfill's fact rendering:
   * elements that are non-empty JSON strings, and nothing else. Its one
   * divergence is malformed JSON, where the backfill takes the elements it
   * parsed before the damage and this returns false — an UNDER-count, which
   * costs nothing: those rows are given vectors anyway, they are merely not
   * required to have one.
   */
  private indexableSql(db: Database, kind: VectorDocKind): string | null {
    const { parent } = VECTOR_TABLES[kind];
    const { scalar, jsonArray } = INDEXABLE_CONTENT[kind];
    const terms: string[] = [];

    for (const column of scalar) {
      if (hasColumn(db, parent, column)) {
        terms.push(`(p.${column} IS NOT NULL AND p.${column} <> '')`);
      }
    }

    if (this.hasJsonFunctions(db)) {
      for (const column of jsonArray) {
        if (!hasColumn(db, parent, column)) continue;
        // Nested CASE rather than AND: json_type() and json_each() raise on a
        // value json_valid() rejects, and CASE is where SQLite guarantees the
        // guard is evaluated before what it guards.
        terms.push(
          `(CASE WHEN json_valid(p.${column}) THEN (`
          + ` CASE WHEN json_type(p.${column}) = 'array' THEN EXISTS (`
          + ` SELECT 1 FROM json_each(p.${column}) je WHERE je.type = 'text' AND je.value <> ''`
          + ` ) ELSE 0 END) ELSE 0 END)`,
        );
      }
    }

    if (terms.length === 0) return null;
    return terms.join(' OR ');
  }

  /**
   * Whether this SQLite build has the JSON1 functions the array term needs.
   * Probed once — it cannot change under a running process. Without them the
   * array term is simply dropped, which under-counts indexable rows in the
   * harmless direction described above.
   */
  private hasJsonFunctions(db: Database): boolean {
    if (this.jsonFunctionsAvailable === null) {
      try {
        db.prepare(`SELECT 1 FROM json_each('["x"]') je WHERE json_valid('[]') AND je.type = 'text'`).get();
        this.jsonFunctionsAvailable = true;
      } catch {
        this.jsonFunctionsAvailable = false;
      }
    }
    return this.jsonFunctionsAvailable;
  }

  /**
   * PATH 2 body for search(): Chroma semantic query -> date-window filter ->
   * SQLite hydration, with a scoped FTS5 fallback when the index covers too
   * little of the scope being searched, or when a platform-scoped query matches
   * nothing in Chroma. Extracted so search()'s try block stays narrow; any
   * error here is handled by search()'s Chroma-failure fallback.
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
  ): Promise<{
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
    prompts: UserPromptSearchResult[];
    platformScopedChromaZeroFallback: boolean;
    incompleteScopeFallback: boolean;
  }> {
    const { obs_type, concepts, files, searchObservations, searchSessions, searchPrompts } = scope;
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];
    let platformScopedChromaZeroFallback = false;

    // Readiness is decided BEFORE the query, not from the shape of its answer.
    // A materially incomplete scope does not announce itself with a zero — it
    // answers from the slice already indexed and looks like a result — so there
    // is nothing to notice downstream. Asking first also spends no embedding
    // work on an answer that is about to be discarded.
    if (this.semanticScopeIsIncomplete(options, this.searchedVectorKinds(scope))) {
      logger.warn('SEARCH', 'Vector index covers too little of this scope; answering from FTS5 keyword search', {
        hasProject: Boolean(options.project),
      });
      return {
        ...this.keywordSearch(query, options, scope),
        platformScopedChromaZeroFallback: false,
        incompleteScopeFallback: true,
      };
    }

    const chromaResults = await this.queryChroma(query, 100, whereFilter);
    logger.debug('SEARCH', 'ChromaDB returned semantic matches', { matchCount: chromaResults.ids.length });

    if (chromaResults.ids.length > 0) {
      const { dateRange } = options;
      let startEpoch: number | undefined;
      let endEpoch: number | undefined;

      if (dateRange) {
        if (dateRange.start) {
          startEpoch = typeof dateRange.start === 'number'
            ? dateRange.start
            : new Date(dateRange.start).getTime();
        }
        if (dateRange.end) {
          endEpoch = typeof dateRange.end === 'number'
            ? dateRange.end
            : new Date(dateRange.end).getTime();
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
        const obsOptions = { ...options, type: obs_type, concepts, files, orderBy: 'relevance' };
        observations = this.sessionStore.getObservationsByIds(obsIds, obsOptions);
        observations.sort((a, b) => obsIds.indexOf(a.id) - obsIds.indexOf(b.id));
      }
      if (sessionIds.length > 0) {
        sessions = this.sessionStore.getSessionSummariesByIds(sessionIds, {
          orderBy: 'date_desc',
          limit: options.limit,
          project: options.project,
          platformSource: options.platformSource
        });
      }
      if (promptIds.length > 0) {
        prompts = this.sessionStore.getUserPromptsByIds(promptIds, {
          orderBy: 'date_desc',
          limit: options.limit,
          project: options.project,
          platformSource: options.platformSource
        });
      }
    } else {
      if (options.platformSource) {
        logger.debug('SEARCH', 'Platform-scoped ChromaDB search found no matches; falling back to scoped FTS5 search', {});
        platformScopedChromaZeroFallback = true;
        ({ observations, sessions, prompts } = this.keywordSearch(query, options, scope));
      } else {
        // Reaching here means the readiness gate above passed: the index covers
        // this scope, so a zero is the index's real answer about the corpus and
        // is reported as one rather than masked by a keyword result.
        logger.debug('SEARCH', 'ChromaDB found no matches (final result, no FTS5 fallback)', {});
      }
    }

    return { observations, sessions, prompts, platformScopedChromaZeroFallback, incompleteScopeFallback: false };
  }

  async search(args: any, telemetryOut?: SearchTelemetryEnvelope): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, type, obs_type, concepts, files, format, ...options } = normalized;
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];
    let chromaFailed = false;
    let platformScopedChromaZeroFallback = false;
    let incompleteScopeFallback = false;
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

      if (options.project) {
        whereFilters.push({
          $or: [
            { project: options.project },
            { merged_into_project: options.project }
          ]
        });
      }

      if (options.platformSource) {
        whereFilters.push({ platform_source: normalizePlatformSource(options.platformSource) });
      }

      const whereFilter = whereFilters.length === 0
        ? undefined
        : whereFilters.length === 1
          ? whereFilters[0]
          : { $and: whereFilters };

      const keywordScope = { obs_type: effectiveObsType, concepts, files, searchObservations, searchSessions, searchPrompts };

      try {
        const chromaOutcome = await this.performChromaSemanticSearch(query, whereFilter, options, keywordScope);
        chromaSucceeded = true;
        ({ observations, sessions, prompts, platformScopedChromaZeroFallback, incompleteScopeFallback } = chromaOutcome);
      } catch (chromaError) {
        const errorObject = chromaError instanceof Error ? chromaError : new Error(String(chromaError));
        chromaFailureReason = {
          message: errorObject.message,
          isConnectionError: chromaError instanceof ChromaUnavailableError,
        };
        logger.warn('SEARCH', 'ChromaDB semantic search failed, falling back to FTS5 keyword search', {}, errorObject);
        chromaFailed = true;

        ({ observations, sessions, prompts } = this.keywordSearch(query, options, keywordScope));
      }
    }
    // PATH 3: FTS5 KEYWORD SEARCH (Chroma not initialized)
    else if (query) {
      logger.debug('SEARCH', 'ChromaDB not initialized — falling back to FTS5 keyword search', {});
      try {
        ({ observations, sessions, prompts } = this.keywordSearch(query, options, {
          obs_type: effectiveObsType, concepts, files, searchObservations, searchSessions, searchPrompts,
        }));
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
        // PATH 2: Chroma semantic search, degrading to FTS5 on error, on
        // platform-scoped zeroes caused by pre-platform Chroma metadata, or on
        // a scope the vector index covers too little of to answer for. The last
        // one reuses chroma_not_initialized — the vector store exists but is
        // not yet a usable index of this scope, which is the same "no index to
        // search" the null-chromaSync path reports — rather than widening a
        // closed enum that ships in the telemetry contract.
        searchStrategy = chromaFailed || platformScopedChromaZeroFallback || incompleteScopeFallback ? 'fts' : 'chroma';
        if (chromaFailed) {
          fallbackReason = chromaFailureReason?.isConnectionError ? 'chroma_connection' : 'chroma_error';
        } else if (platformScopedChromaZeroFallback) {
          fallbackReason = 'chroma_error';
        } else if (incompleteScopeFallback) {
          fallbackReason = 'chroma_not_initialized';
        } else {
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
    const resultsByDate = groupByDate(limitedResults, item => item.created_at);

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
        results = await this.hybridSemanticHydrate(query, 'observation', options.project, options.platformSource, (ids) =>
          this.sessionStore.getObservationsByIds(ids, { orderBy: 'date_desc', limit, project: options.project, platformSource: options.platformSource })
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

    const header = `Found ${results.length} observation(s) matching "${query}"\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
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

          const date = new Date(summary.created_at).toLocaleString();
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

        const date = new Date(session.started_at).toLocaleString();
        lines.push(`**Date:** ${date}`);
      } else {
        lines.push(`**${session.status.charAt(0).toUpperCase() + session.status.slice(1)}**`);
        lines.push('');

        if (session.user_prompt) {
          lines.push(`**Request:** ${session.user_prompt}`);
        }

        lines.push('');
        lines.push(`**Status:** ${session.status} - no summary available`);

        const date = new Date(session.started_at).toLocaleString();
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
          this.sessionStore.getObservationsByIds(ids, { orderBy: 'date_desc', limit, project, platformSource })
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
      const date = new Date(obs.created_at_epoch).toLocaleString();
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
