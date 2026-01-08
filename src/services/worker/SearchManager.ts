/**
 * SearchManager - Core search orchestration for claude-mem
 *
 * This class is a thin wrapper that delegates to the modular search infrastructure.
 * It maintains the same public interface for backward compatibility.
 *
 * The actual search logic is now in:
 * - SearchOrchestrator: Strategy selection and coordination
 * - ChromaSearchStrategy: Vector-based semantic search
 * - SQLiteSearchStrategy: Filter-only queries
 * - HybridSearchStrategy: Metadata filtering + semantic ranking
 * - ResultFormatter: Output formatting
 * - TimelineBuilder: Timeline construction
 */

import { basename } from 'path';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { FormattingService } from './FormattingService.js';
import { TimelineService } from './TimelineService.js';
import type { TimelineItem } from './TimelineService.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { logger } from '../../utils/logger.js';
import { formatDate, formatTime, formatDateTime, extractFirstFile, groupByDate, estimateTokens } from '../../shared/timeline-formatting.js';
import { ModeManager } from '../domain/ModeManager.js';

import {
  SearchOrchestrator,
  TimelineBuilder,
  SEARCH_CONSTANTS
} from './search/index.js';
import type { TimelineData } from './search/index.js';

export class SearchManager {
  private orchestrator: SearchOrchestrator;
  private timelineBuilder: TimelineBuilder;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync,
    private formatter: FormattingService,
    private timelineService: TimelineService
  ) {
    // Initialize the new modular search infrastructure
    this.orchestrator = new SearchOrchestrator(
      sessionSearch,
      sessionStore,
      chromaSync
    );
    this.timelineBuilder = new TimelineBuilder();
  }

  /**
   * Query Chroma vector database via ChromaSync
   * @deprecated Use orchestrator.search() instead
   */
  private async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    return await this.chromaSync.queryChroma(query, limit, whereFilter);
  }

  /**
   * Helper to normalize query parameters from URL-friendly format
   * Converts comma-separated strings to arrays and flattens date params
   */
  private normalizeParams(args: any): any {
    const normalized: any = { ...args };

    // Map filePath to files (API uses filePath, internal uses files)
    if (normalized.filePath && !normalized.files) {
      normalized.files = normalized.filePath;
      delete normalized.filePath;
    }

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obs_type = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated type (for filterSchema) into array
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    // Parse isFolder boolean from string
    if (normalized.isFolder === 'true') {
      normalized.isFolder = true;
    } else if (normalized.isFolder === 'false') {
      normalized.isFolder = false;
    }

    return normalized;
  }

  /**
   * Tool handler: search
   */
  async search(args: any): Promise<any> {
    // Normalize URL-friendly params to internal format
    const normalized = this.normalizeParams(args);
    const { query, type, obs_type, concepts, files, format, ...options } = normalized;
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];
    let chromaFailed = false;

    // Determine which types to query based on type filter
    const searchObservations = !type || type === 'observations';
    const searchSessions = !type || type === 'sessions';
    const searchPrompts = !type || type === 'prompts';

    // PATH 1: FILTER-ONLY (no query text) - Skip Chroma/FTS5, use direct SQLite filtering
    // This path enables date filtering which Chroma cannot do (requires direct SQLite access)
    if (!query) {
      logger.debug('SEARCH', 'Filter-only query (no query text), using direct SQLite filtering', { enablesDateFilters: true });
      const obsOptions = { ...options, type: obs_type, concepts, files };
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
      logger.debug('SEARCH', 'Using ChromaDB semantic search', { typeFilter: type || 'all' });

      // Build Chroma where filter for doc_type
      let whereFilter: Record<string, any> | undefined;
      if (type === 'observations') {
        whereFilter = { doc_type: 'observation' };
      } else if (type === 'sessions') {
        whereFilter = { doc_type: 'session_summary' };
      } else if (type === 'prompts') {
        whereFilter = { doc_type: 'user_prompt' };
      }

      // Step 1: Chroma semantic search with optional type filter
      const chromaResults = await this.queryChroma(query, 100, whereFilter);
      chromaSucceeded = true; // Chroma didn't throw error
      logger.debug('SEARCH', 'ChromaDB returned semantic matches', { matchCount: chromaResults.ids.length });

      if (chromaResults.ids.length > 0) {
        // Step 2: Filter by recency (90 days)
        const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
        const recentMetadata = chromaResults.metadatas.map((meta, idx) => ({
          id: chromaResults.ids[idx],
          meta,
          isRecent: meta && meta.created_at_epoch > ninetyDaysAgo
        })).filter(item => item.isRecent);

        logger.debug('SEARCH', 'Results within 90-day window', { count: recentMetadata.length });

        // Step 3: Categorize IDs by document type
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

        logger.debug('SEARCH', 'Categorized results by type', { observations: obsIds.length, sessions: sessionIds.length, prompts: prompts.length });

        // Step 4: Hydrate from SQLite with additional filters
        if (obsIds.length > 0) {
          // Apply obs_type, concepts, files filters if provided
          const obsOptions = { ...options, type: obs_type, concepts, files };
          observations = this.sessionStore.getObservationsByIds(obsIds, obsOptions);
        }
        if (sessionIds.length > 0) {
          sessions = this.sessionStore.getSessionSummariesByIds(sessionIds, { orderBy: 'date_desc', limit: options.limit, project: options.project });
        }
        if (promptIds.length > 0) {
          prompts = this.sessionStore.getUserPromptsByIds(promptIds, { orderBy: 'date_desc', limit: options.limit, project: options.project });
        }

        logger.debug('SEARCH', 'Hydrated results from SQLite', { observations: observations.length, sessions: sessions.length, prompts: prompts.length });
      } else {
        // Chroma returned 0 results - this is the correct answer, don't fall back to FTS5
        logger.debug('SEARCH', 'ChromaDB found no matches (final result, no FTS5 fallback)', {});
      }
    }
    // ChromaDB not initialized - mark as failed to show proper error message
    else if (query) {
      chromaFailed = true;
      logger.debug('SEARCH', 'ChromaDB not initialized - semantic search unavailable', {});
      logger.debug('SEARCH', 'Install UVX/Python to enable vector search', { url: 'https://docs.astral.sh/uv/getting-started/installation/' });
      observations = [];
      sessions = [];
      prompts = [];
    }

    const totalResults = observations.length + sessions.length + prompts.length;

    // JSON format: return raw data for programmatic access (e.g., export scripts)
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
      if (chromaFailed) {
        return {
          content: [{
            type: 'text' as const,
            text: `Vector search failed - semantic search unavailable.\n\nTo enable semantic search:\n1. Install uv: https://docs.astral.sh/uv/getting-started/installation/\n2. Restart the worker: npm run worker:restart\n\nNote: You can still use filter-only searches (date ranges, types, files) without a query term.`
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

    // Combine all results with timestamps for unified sorting
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

    // Sort by date
    if (options.orderBy === 'date_desc') {
      allResults.sort((a, b) => b.epoch - a.epoch);
    } else if (options.orderBy === 'date_asc') {
      allResults.sort((a, b) => a.epoch - b.epoch);
    }

    // Apply limit across all types
    const limitedResults = allResults.slice(0, options.limit || 20);

    // Group by date, then by file within each day
    const cwd = process.cwd();
    const resultsByDate = groupByDate(limitedResults, item => item.created_at);

    // Build output with date/file grouping
    const lines: string[] = [];
    lines.push(`Found ${totalResults} result(s) matching "${query}" (${observations.length} obs, ${sessions.length} sessions, ${prompts.length} prompts)`);
    lines.push('');

    for (const [day, dayResults] of resultsByDate) {
      lines.push(`### ${day}`);
      lines.push('');

      // Group by file within this day
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

      // Render each file section
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

  /**
   * Tool handler: timeline
   */
  async timeline(args: any): Promise<any> {
    const { anchor, query, depth_before = 10, depth_after = 10, project } = args;
    const cwd = process.cwd();

    // Validate: must provide either anchor or query, not both
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

    // MODE 1: Query-based timeline
    if (query) {
      // Step 1: Search for observations
      let results: ObservationSearchResult[] = [];

      if (this.chromaSync) {
        try {
          logger.debug('SEARCH', 'Using hybrid semantic search for timeline query', {});
          const chromaResults = await this.queryChroma(query, 100);
          logger.debug('SEARCH', 'Chroma returned semantic matches for timeline', { matchCount: chromaResults?.ids?.length ?? 0 });

          if (chromaResults?.ids && chromaResults.ids.length > 0) {
            const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
            const recentIds = chromaResults.ids.filter((_id, idx) => {
              const meta = chromaResults.metadatas[idx];
              return meta && meta.created_at_epoch > ninetyDaysAgo;
            });

            if (recentIds.length > 0) {
              results = this.sessionStore.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit: 1 });
            }
          }
        } catch (chromaError) {
          logger.error('SEARCH', 'Chroma search failed for timeline, continuing without semantic results', {}, chromaError as Error);
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

      // Use top result as anchor
      const topResult = results[0];
      anchorId = topResult.id;
      anchorEpoch = topResult.created_at_epoch;
      logger.debug('SEARCH', 'Query mode: Using observation as timeline anchor', { observationId: topResult.id });
      timelineData = this.sessionStore.getTimelineAroundObservation(topResult.id, topResult.created_at_epoch, depth_before, depth_after, project);
    }
    // MODE 2: Anchor-based timeline
    else if (typeof anchor === 'number') {
      // Observation ID
      const obs = this.sessionStore.getObservationById(anchor);
      if (!obs) {
        return {
          content: [{
            type: 'text' as const,
            text: `Observation #${anchor} not found`
          }],
          isError: true
        };
      }
      anchorId = anchor;
      anchorEpoch = obs.created_at_epoch;
      timelineData = this.sessionStore.getTimelineAroundObservation(anchor, anchorEpoch, depth_before, depth_after, project);
    } else if (typeof anchor === 'string') {
      // Session ID or ISO timestamp
      if (anchor.startsWith('S') || anchor.startsWith('#S')) {
        const sessionId = anchor.replace(/^#?S/, '');
        const sessionNum = parseInt(sessionId, 10);
        const sessions = this.sessionStore.getSessionSummariesByIds([sessionNum]);
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
        timelineData = this.sessionStore.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
      } else {
        // ISO timestamp
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
        timelineData = this.sessionStore.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
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

    // Combine, sort, and filter timeline items
    const items: TimelineItem[] = [
      ...(timelineData.observations || []).map((obs: any) => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
      ...(timelineData.sessions || []).map((sess: any) => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
      ...(timelineData.prompts || []).map((prompt: any) => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
    ];
    items.sort((a, b) => a.epoch - b.epoch);
    const filteredItems = this.timelineService.filterByDepth(items, anchorId, anchorEpoch, depth_before, depth_after);

    if (!filteredItems || filteredItems.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: query
            ? `Found observation matching "${query}", but no timeline context available (${depth_before} records before, ${depth_after} records after).`
            : `No context found around anchor (${depth_before} records before, ${depth_after} records after)`
        }]
      };
    }

    // Format results
    const lines: string[] = [];

    // Header
    if (query) {
      const anchorObs = filteredItems.find(item => item.type === 'observation' && item.data.id === anchorId);
      const anchorTitle = anchorObs && anchorObs.type === 'observation' ? ((anchorObs.data as ObservationSearchResult).title || 'Untitled') : 'Unknown';
      lines.push(`# Timeline for query: "${query}"`);
      lines.push(`**Anchor:** Observation #${anchorId} - ${anchorTitle}`);
    } else {
      lines.push(`# Timeline around anchor: ${anchorId}`);
    }

    lines.push(`**Window:** ${depth_before} records before -> ${depth_after} records after | **Items:** ${filteredItems?.length ?? 0}`);
    lines.push('');


    // Group by day
    const dayMap = new Map<string, TimelineItem[]>();
    for (const item of filteredItems) {
      const day = formatDate(item.epoch);
      if (!dayMap.has(day)) {
        dayMap.set(day, []);
      }
      dayMap.get(day)!.push(item);
    }

    // Sort days chronologically
    const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
      const aDate = new Date(a[0]).getTime();
      const bDate = new Date(b[0]).getTime();
      return aDate - bDate;
    });

    // Render each day
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

          lines.push(`**\uD83C\uDFAF #S${sess.id}** ${title} (${formatDateTime(item.epoch)})${marker}`);
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

          lines.push(`**\uD83D\uDCAC User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
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

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    };
  }

  /**
   * Tool handler: decisions
   */
  async decisions(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, ...filters } = normalized;
    let results: ObservationSearchResult[] = [];

    // Search for decision-type observations
    if (this.chromaSync) {
      try {
        if (query) {
          // Semantic search filtered to decision type
          logger.debug('SEARCH', 'Using Chroma semantic search with type=decision filter', {});
          const chromaResults = await this.queryChroma(query, Math.min((filters.limit || 20) * 2, 100), { type: 'decision' });
          const obsIds = chromaResults.ids;

          if (obsIds.length > 0) {
            results = this.sessionStore.getObservationsByIds(obsIds, { ...filters, type: 'decision' });
            // Preserve Chroma ranking order
            results.sort((a, b) => obsIds.indexOf(a.id) - obsIds.indexOf(b.id));
          }
        } else {
          // No query: get all decisions, rank by "decision" keyword
          logger.debug('SEARCH', 'Using metadata-first + semantic ranking for decisions', {});
          const metadataResults = this.sessionSearch.findByType('decision', filters);

          if (metadataResults.length > 0) {
            const ids = metadataResults.map(obs => obs.id);
            const chromaResults = await this.queryChroma('decision', Math.min(ids.length, 100));

            const rankedIds: number[] = [];
            for (const chromaId of chromaResults.ids) {
              if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
                rankedIds.push(chromaId);
              }
            }

            if (rankedIds.length > 0) {
              results = this.sessionStore.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
              results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
            }
          }
        }
      } catch (chromaError) {
        logger.error('SEARCH', 'Chroma search failed for decisions, falling back to metadata search', {}, chromaError as Error);
      }
    }

    if (results.length === 0) {
      results = this.sessionSearch.findByType('decision', filters);
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No decision observations found'
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} decision(s)\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }

  /**
   * Tool handler: changes
   */
  async changes(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { ...filters } = normalized;
    let results: ObservationSearchResult[] = [];

    // Search for change-type observations and change-related concepts
    if (this.chromaSync) {
      try {
        logger.debug('SEARCH', 'Using hybrid search for change-related observations', {});

        // Get all observations with type="change" or concepts containing change
        const typeResults = this.sessionSearch.findByType('change', filters);
        const conceptChangeResults = this.sessionSearch.findByConcept('change', filters);
        const conceptWhatChangedResults = this.sessionSearch.findByConcept('what-changed', filters);

        // Combine and deduplicate
        const allIds = new Set<number>();
        [...typeResults, ...conceptChangeResults, ...conceptWhatChangedResults].forEach(obs => allIds.add(obs.id));

        if (allIds.size > 0) {
          const idsArray = Array.from(allIds);
          const chromaResults = await this.queryChroma('what changed', Math.min(idsArray.length, 100));

          const rankedIds: number[] = [];
          for (const chromaId of chromaResults.ids) {
            if (idsArray.includes(chromaId) && !rankedIds.includes(chromaId)) {
              rankedIds.push(chromaId);
            }
          }

          if (rankedIds.length > 0) {
            results = this.sessionStore.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
            results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
          }
        }
      } catch (chromaError) {
        logger.error('SEARCH', 'Chroma search failed for changes, falling back to metadata search', {}, chromaError as Error);
      }
    }

    if (results.length === 0) {
      const typeResults = this.sessionSearch.findByType('change', filters);
      const conceptResults = this.sessionSearch.findByConcept('change', filters);
      const whatChangedResults = this.sessionSearch.findByConcept('what-changed', filters);

      const allIds = new Set<number>();
      [...typeResults, ...conceptResults, ...whatChangedResults].forEach(obs => allIds.add(obs.id));

      results = Array.from(allIds).map(id =>
        typeResults.find(obs => obs.id === id) ||
        conceptResults.find(obs => obs.id === id) ||
        whatChangedResults.find(obs => obs.id === id)
      ).filter(Boolean) as ObservationSearchResult[];

      results.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
      results = results.slice(0, filters.limit || 20);
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No change-related observations found'
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} change-related observation(s)\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: how_it_works
   */
  async howItWorks(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { ...filters } = normalized;
    let results: ObservationSearchResult[] = [];

    // Search for how-it-works concept observations
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using metadata-first + semantic ranking for how-it-works', {});
      const metadataResults = this.sessionSearch.findByConcept('how-it-works', filters);

      if (metadataResults.length > 0) {
        const ids = metadataResults.map(obs => obs.id);
        const chromaResults = await this.queryChroma('how it works architecture', Math.min(ids.length, 100));

        const rankedIds: number[] = [];
        for (const chromaId of chromaResults.ids) {
          if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
            rankedIds.push(chromaId);
          }
        }

        if (rankedIds.length > 0) {
          results = this.sessionStore.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
          results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
        }
      }
    }

    if (results.length === 0) {
      results = this.sessionSearch.findByConcept('how-it-works', filters);
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No "how it works" observations found'
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} "how it works" observation(s)\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: search_observations
   */
  async searchObservations(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, ...options } = normalized;
    let results: ObservationSearchResult[] = [];

    // Vector-first search via ChromaDB
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using hybrid semantic search (Chroma + SQLite)', {});

      // Step 1: Chroma semantic search (top 100)
      const chromaResults = await this.queryChroma(query, 100);
      logger.debug('SEARCH', 'Chroma returned semantic matches', { matchCount: chromaResults.ids.length });

      if (chromaResults.ids.length > 0) {
        // Step 2: Filter by recency (90 days)
        const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
        const recentIds = chromaResults.ids.filter((_id, idx) => {
          const meta = chromaResults.metadatas[idx];
          return meta && meta.created_at_epoch > ninetyDaysAgo;
        });

        logger.debug('SEARCH', 'Results within 90-day window', { count: recentIds.length });

        // Step 3: Hydrate from SQLite in temporal order
        if (recentIds.length > 0) {
          const limit = options.limit || 20;
          results = this.sessionStore.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit });
          logger.debug('SEARCH', 'Hydrated observations from SQLite', { count: results.length });
        }
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

    // Format as table
    const header = `Found ${results.length} observation(s) matching "${query}"\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: search_sessions
   */
  async searchSessions(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, ...options } = normalized;
    let results: SessionSummarySearchResult[] = [];

    // Vector-first search via ChromaDB
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using hybrid semantic search for sessions', {});

      // Step 1: Chroma semantic search (top 100)
      const chromaResults = await this.queryChroma(query, 100, { doc_type: 'session_summary' });
      logger.debug('SEARCH', 'Chroma returned semantic matches for sessions', { matchCount: chromaResults.ids.length });

      if (chromaResults.ids.length > 0) {
        // Step 2: Filter by recency (90 days)
        const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
        const recentIds = chromaResults.ids.filter((_id, idx) => {
          const meta = chromaResults.metadatas[idx];
          return meta && meta.created_at_epoch > ninetyDaysAgo;
        });

        logger.debug('SEARCH', 'Results within 90-day window', { count: recentIds.length });

        // Step 3: Hydrate from SQLite in temporal order
        if (recentIds.length > 0) {
          const limit = options.limit || 20;
          results = this.sessionStore.getSessionSummariesByIds(recentIds, { orderBy: 'date_desc', limit });
          logger.debug('SEARCH', 'Hydrated sessions from SQLite', { count: results.length });
        }
      }
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No sessions found matching "${query}"`
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} session(s) matching "${query}"\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((session, i) => this.formatter.formatSessionIndex(session, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: search_user_prompts
   */
  async searchUserPrompts(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { query, ...options } = normalized;
    let results: UserPromptSearchResult[] = [];

    // Vector-first search via ChromaDB
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using hybrid semantic search for user prompts', {});

      // Step 1: Chroma semantic search (top 100)
      const chromaResults = await this.queryChroma(query, 100, { doc_type: 'user_prompt' });
      logger.debug('SEARCH', 'Chroma returned semantic matches for prompts', { matchCount: chromaResults.ids.length });

      if (chromaResults.ids.length > 0) {
        // Step 2: Filter by recency (90 days)
        const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
        const recentIds = chromaResults.ids.filter((_id, idx) => {
          const meta = chromaResults.metadatas[idx];
          return meta && meta.created_at_epoch > ninetyDaysAgo;
        });

        logger.debug('SEARCH', 'Results within 90-day window', { count: recentIds.length });

        // Step 3: Hydrate from SQLite in temporal order
        if (recentIds.length > 0) {
          const limit = options.limit || 20;
          results = this.sessionStore.getUserPromptsByIds(recentIds, { orderBy: 'date_desc', limit });
          logger.debug('SEARCH', 'Hydrated user prompts from SQLite', { count: results.length });
        }
      }
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: query ? `No user prompts found matching "${query}"` : 'No user prompts found'
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} user prompt(s) matching "${query}"\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((prompt, i) => this.formatter.formatUserPromptIndex(prompt, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: find_by_concept
   */
  async findByConcept(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { concepts: concept, ...filters } = normalized;
    let results: ObservationSearchResult[] = [];

    // Metadata-first, semantic-enhanced search
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using metadata-first + semantic ranking for concept search', {});

      // Step 1: SQLite metadata filter (get all IDs with this concept)
      const metadataResults = this.sessionSearch.findByConcept(concept, filters);
      logger.debug('SEARCH', 'Found observations with concept', { concept, count: metadataResults.length });

      if (metadataResults.length > 0) {
        // Step 2: Chroma semantic ranking (rank by relevance to concept)
        const ids = metadataResults.map(obs => obs.id);
        const chromaResults = await this.queryChroma(concept, Math.min(ids.length, 100));

        // Intersect: Keep only IDs that passed metadata filter, in semantic rank order
        const rankedIds: number[] = [];
        for (const chromaId of chromaResults.ids) {
          if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
            rankedIds.push(chromaId);
          }
        }

        logger.debug('SEARCH', 'Chroma ranked results by semantic relevance', { count: rankedIds.length });

        // Step 3: Hydrate in semantic rank order
        if (rankedIds.length > 0) {
          results = this.sessionStore.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
          // Restore semantic ranking order
          results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
        }
      }
    }

    // Fall back to SQLite-only if Chroma unavailable or failed
    if (results.length === 0) {
      logger.debug('SEARCH', 'Using SQLite-only concept search', {});
      results = this.sessionSearch.findByConcept(concept, filters);
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No observations found with concept "${concept}"`
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} observation(s) with concept "${concept}"\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: find_by_file
   */
  async findByFile(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { files: rawFilePath, ...filters } = normalized;
    // Handle both string and array (normalizeParams may split on comma)
    const filePath = Array.isArray(rawFilePath) ? rawFilePath[0] : rawFilePath;
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];

    // Metadata-first, semantic-enhanced search for observations
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using metadata-first + semantic ranking for file search', {});

      // Step 1: SQLite metadata filter (get all results with this file)
      const metadataResults = this.sessionSearch.findByFile(filePath, filters);
      logger.debug('SEARCH', 'Found results for file', { file: filePath, observations: metadataResults.observations.length, sessions: metadataResults.sessions.length });

      // Sessions: Keep as-is (already summarized, no semantic ranking needed)
      sessions = metadataResults.sessions;

      // Observations: Apply semantic ranking
      if (metadataResults.observations.length > 0) {
        // Step 2: Chroma semantic ranking (rank by relevance to file path)
        const ids = metadataResults.observations.map(obs => obs.id);
        const chromaResults = await this.queryChroma(filePath, Math.min(ids.length, 100));

        // Intersect: Keep only IDs that passed metadata filter, in semantic rank order
        const rankedIds: number[] = [];
        for (const chromaId of chromaResults.ids) {
          if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
            rankedIds.push(chromaId);
          }
        }

        logger.debug('SEARCH', 'Chroma ranked observations by semantic relevance', { count: rankedIds.length });

        // Step 3: Hydrate in semantic rank order
        if (rankedIds.length > 0) {
          observations = this.sessionStore.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
          // Restore semantic ranking order
          observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
        }
      }
    }

    // Fall back to SQLite-only if Chroma unavailable or failed
    if (observations.length === 0 && sessions.length === 0) {
      logger.debug('SEARCH', 'Using SQLite-only file search', {});
      const results = this.sessionSearch.findByFile(filePath, filters);
      observations = results.observations;
      sessions = results.sessions;
    }

    const totalResults = observations.length + sessions.length;

    if (totalResults === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No results found for file "${filePath}"`
        }]
      };
    }

    // Combine observations and sessions with timestamps for date grouping
    const combined: Array<{
      type: 'observation' | 'session';
      data: ObservationSearchResult | SessionSummarySearchResult;
      epoch: number;
      created_at: string;
    }> = [
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
      }))
    ];

    // Sort by date (most recent first)
    combined.sort((a, b) => b.epoch - a.epoch);

    // Group by date for proper timeline rendering
    const resultsByDate = groupByDate(combined, item => item.created_at);

    // Format with date headers for proper date parsing by folder CLAUDE.md generator
    const lines: string[] = [];
    lines.push(`Found ${totalResults} result(s) for file "${filePath}"`);
    lines.push('');

    for (const [day, dayResults] of resultsByDate) {
      lines.push(`### ${day}`);
      lines.push('');
      lines.push(this.formatter.formatTableHeader());

      for (const result of dayResults) {
        if (result.type === 'observation') {
          lines.push(this.formatter.formatObservationIndex(result.data as ObservationSearchResult, 0));
        } else {
          lines.push(this.formatter.formatSessionIndex(result.data as SessionSummarySearchResult, 0));
        }
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


  /**
   * Tool handler: find_by_type
   */
  async findByType(args: any): Promise<any> {
    const normalized = this.normalizeParams(args);
    const { type, ...filters } = normalized;
    const typeStr = Array.isArray(type) ? type.join(', ') : type;
    let results: ObservationSearchResult[] = [];

    // Metadata-first, semantic-enhanced search
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using metadata-first + semantic ranking for type search', {});

      // Step 1: SQLite metadata filter (get all IDs with this type)
      const metadataResults = this.sessionSearch.findByType(type, filters);
      logger.debug('SEARCH', 'Found observations with type', { type: typeStr, count: metadataResults.length });

      if (metadataResults.length > 0) {
        // Step 2: Chroma semantic ranking (rank by relevance to type)
        const ids = metadataResults.map(obs => obs.id);
        const chromaResults = await this.queryChroma(typeStr, Math.min(ids.length, 100));

        // Intersect: Keep only IDs that passed metadata filter, in semantic rank order
        const rankedIds: number[] = [];
        for (const chromaId of chromaResults.ids) {
          if (ids.includes(chromaId) && !rankedIds.includes(chromaId)) {
            rankedIds.push(chromaId);
          }
        }

        logger.debug('SEARCH', 'Chroma ranked results by semantic relevance', { count: rankedIds.length });

        // Step 3: Hydrate in semantic rank order
        if (rankedIds.length > 0) {
          results = this.sessionStore.getObservationsByIds(rankedIds, { limit: filters.limit || 20 });
          // Restore semantic ranking order
          results.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
        }
      }
    }

    // Fall back to SQLite-only if Chroma unavailable or failed
    if (results.length === 0) {
      logger.debug('SEARCH', 'Using SQLite-only type search', {});
      results = this.sessionSearch.findByType(type, filters);
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No observations found with type "${typeStr}"`
        }]
      };
    }

    // Format as table
    const header = `Found ${results.length} observation(s) with type "${typeStr}"\n\n${this.formatter.formatTableHeader()}`;
    const formattedResults = results.map((obs, i) => this.formatter.formatObservationIndex(obs, i));

    return {
      content: [{
        type: 'text' as const,
        text: header + '\n' + formattedResults.join('\n')
      }]
    };
  }


  /**
   * Tool handler: get_recent_context
   */
  async getRecentContext(args: any): Promise<any> {
    const project = args.project || basename(process.cwd());
    const limit = args.limit || 3;

    const sessions = this.sessionStore.getRecentSessionsWithStatus(project, limit);

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
        const summary = this.sessionStore.getSummaryForSession(session.memory_session_id);
        if (summary) {
          const promptLabel = summary.prompt_number ? ` (Prompt #${summary.prompt_number})` : '';
          lines.push(`**Summary${promptLabel}**`);
          lines.push('');

          if (summary.request) lines.push(`**Request:** ${summary.request}`);
          if (summary.completed) lines.push(`**Completed:** ${summary.completed}`);
          if (summary.learned) lines.push(`**Learned:** ${summary.learned}`);
          if (summary.next_steps) lines.push(`**Next Steps:** ${summary.next_steps}`);

          // Handle files_read
          if (summary.files_read) {
            try {
              const filesRead = JSON.parse(summary.files_read);
              if (Array.isArray(filesRead) && filesRead.length > 0) {
                lines.push(`**Files Read:** ${filesRead.join(', ')}`);
              }
            } catch (error) {
              logger.debug('WORKER', 'files_read is plain string, using as-is', {}, error as Error);
              if (summary.files_read.trim()) {
                lines.push(`**Files Read:** ${summary.files_read}`);
              }
            }
          }

          // Handle files_edited
          if (summary.files_edited) {
            try {
              const filesEdited = JSON.parse(summary.files_edited);
              if (Array.isArray(filesEdited) && filesEdited.length > 0) {
                lines.push(`**Files Edited:** ${filesEdited.join(', ')}`);
              }
            } catch (error) {
              logger.debug('WORKER', 'files_edited is plain string, using as-is', {}, error as Error);
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

        const observations = this.sessionStore.getObservationsForSession(session.memory_session_id);
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

  /**
   * Tool handler: get_context_timeline
   */
  async getContextTimeline(args: any): Promise<any> {
    const { anchor, depth_before = 10, depth_after = 10, project } = args;
    const cwd = process.cwd();
    let anchorEpoch: number;
    let anchorId: string | number = anchor;

    // Resolve anchor and get timeline data
    let timelineData;
    if (typeof anchor === 'number') {
      // Observation ID - use ID-based boundary detection
      const obs = this.sessionStore.getObservationById(anchor);
      if (!obs) {
        return {
          content: [{
            type: 'text' as const,
            text: `Observation #${anchor} not found`
          }],
          isError: true
        };
      }
      anchorEpoch = obs.created_at_epoch;
      timelineData = this.sessionStore.getTimelineAroundObservation(anchor, anchorEpoch, depth_before, depth_after, project);
    } else if (typeof anchor === 'string') {
      // Session ID or ISO timestamp
      if (anchor.startsWith('S') || anchor.startsWith('#S')) {
        const sessionId = anchor.replace(/^#?S/, '');
        const sessionNum = parseInt(sessionId, 10);
        const sessions = this.sessionStore.getSessionSummariesByIds([sessionNum]);
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
        timelineData = this.sessionStore.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
      } else {
        // ISO timestamp
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
        anchorEpoch = date.getTime(); // Keep as milliseconds
        timelineData = this.sessionStore.getTimelineAroundTimestamp(anchorEpoch, depth_before, depth_after, project);
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

    // Combine, sort, and filter timeline items
    const items: TimelineItem[] = [
      ...timelineData.observations.map(obs => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
      ...timelineData.sessions.map(sess => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
      ...timelineData.prompts.map(prompt => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
    ];
    items.sort((a, b) => a.epoch - b.epoch);
    const filteredItems = this.timelineService.filterByDepth(items, anchorId, anchorEpoch, depth_before, depth_after);

    if (!filteredItems || filteredItems.length === 0) {
      const anchorDate = new Date(anchorEpoch).toLocaleString();
      return {
        content: [{
          type: 'text' as const,
          text: `No context found around ${anchorDate} (${depth_before} records before, ${depth_after} records after)`
        }]
      };
    }

    // Format results matching context-hook.ts exactly
    const lines: string[] = [];

    // Header
    lines.push(`# Timeline around anchor: ${anchorId}`);
    lines.push(`**Window:** ${depth_before} records before -> ${depth_after} records after | **Items:** ${filteredItems?.length ?? 0}`);
    lines.push('');


    // Group by day
    const dayMap = new Map<string, TimelineItem[]>();
    for (const item of filteredItems) {
      const day = formatDate(item.epoch);
      if (!dayMap.has(day)) {
        dayMap.set(day, []);
      }
      dayMap.get(day)!.push(item);
    }

    // Sort days chronologically
    const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
      const aDate = new Date(a[0]).getTime();
      const bDate = new Date(b[0]).getTime();
      return aDate - bDate;
    });

    // Render each day
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
          // Close any open table
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          // Render session
          const sess = item.data as SessionSummarySearchResult;
          const title = sess.request || 'Session summary';
          const marker = isAnchor ? ' <- **ANCHOR**' : '';

          lines.push(`**\uD83C\uDFAF #S${sess.id}** ${title} (${formatDateTime(item.epoch)})${marker}`);
          lines.push('');
        } else if (item.type === 'prompt') {
          // Close any open table
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          // Render prompt
          const prompt = item.data as UserPromptSearchResult;
          const truncated = prompt.prompt_text.length > 100 ? prompt.prompt_text.substring(0, 100) + '...' : prompt.prompt_text;

          lines.push(`**\uD83D\uDCAC User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
          lines.push(`> ${truncated}`);
          lines.push('');
        } else if (item.type === 'observation') {
          // Render observation in table
          const obs = item.data as ObservationSearchResult;
          const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);

          // Check if we need a new file section
          if (file !== currentFile) {
            // Close previous table
            if (tableOpen) {
              lines.push('');
            }

            // File header
            lines.push(`**${file}**`);
            lines.push(`| ID | Time | T | Title | Tokens |`);
            lines.push(`|----|------|---|-------|--------|`);

            currentFile = file;
            tableOpen = true;
            lastTime = '';
          }

          // Map observation type to emoji
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

      // Close final table if open
      if (tableOpen) {
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

  /**
   * Tool handler: get_timeline_by_query
   */
  async getTimelineByQuery(args: any): Promise<any> {
    const { query, mode = 'auto', depth_before = 10, depth_after = 10, limit = 5, project } = args;
    const cwd = process.cwd();

    // Step 1: Search for observations
    let results: ObservationSearchResult[] = [];

    // Use hybrid search if available
    if (this.chromaSync) {
      logger.debug('SEARCH', 'Using hybrid semantic search for timeline query', {});
      const chromaResults = await this.queryChroma(query, 100);
      logger.debug('SEARCH', 'Chroma returned semantic matches for timeline', { matchCount: chromaResults.ids.length });

      if (chromaResults.ids.length > 0) {
        // Filter by recency (90 days)
        const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
        const recentIds = chromaResults.ids.filter((_id, idx) => {
          const meta = chromaResults.metadatas[idx];
          return meta && meta.created_at_epoch > ninetyDaysAgo;
        });

        logger.debug('SEARCH', 'Results within 90-day window', { count: recentIds.length });

        if (recentIds.length > 0) {
          results = this.sessionStore.getObservationsByIds(recentIds, { orderBy: 'date_desc', limit: mode === 'auto' ? 1 : limit });
          logger.debug('SEARCH', 'Hydrated observations from SQLite', { count: results.length });
        }
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

    // Step 2: Handle based on mode
    if (mode === 'interactive') {
      // Return formatted index of top results for LLM to choose from
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
    } else {
      // Auto mode: Use top result as timeline anchor
      const topResult = results[0];
      logger.debug('SEARCH', 'Auto mode: Using observation as timeline anchor', { observationId: topResult.id });

      // Get timeline around this observation
      const timelineData = this.sessionStore.getTimelineAroundObservation(
        topResult.id,
        topResult.created_at_epoch,
        depth_before,
        depth_after,
        project
      );

      // Combine, sort, and filter timeline items
      const items: TimelineItem[] = [
        ...(timelineData.observations || []).map(obs => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
        ...(timelineData.sessions || []).map(sess => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
        ...(timelineData.prompts || []).map(prompt => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
      ];
      items.sort((a, b) => a.epoch - b.epoch);
      const filteredItems = this.timelineService.filterByDepth(items, topResult.id, 0, depth_before, depth_after);

      if (!filteredItems || filteredItems.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Found observation #${topResult.id} matching "${query}", but no timeline context available (${depth_before} records before, ${depth_after} records after).`
          }]
        };
      }

      // Format timeline (reused from get_context_timeline)
      const lines: string[] = [];

      // Header
      lines.push(`# Timeline for query: "${query}"`);
      lines.push(`**Anchor:** Observation #${topResult.id} - ${topResult.title || 'Untitled'}`);
      lines.push(`**Window:** ${depth_before} records before -> ${depth_after} records after | **Items:** ${filteredItems?.length ?? 0}`);
      lines.push('');


      // Group by day
      const dayMap = new Map<string, TimelineItem[]>();
      for (const item of filteredItems) {
        const day = formatDate(item.epoch);
        if (!dayMap.has(day)) {
          dayMap.set(day, []);
        }
        dayMap.get(day)!.push(item);
      }

      // Sort days chronologically
      const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
        const aDate = new Date(a[0]).getTime();
        const bDate = new Date(b[0]).getTime();
        return aDate - bDate;
      });

      // Render each day
      for (const [day, dayItems] of sortedDays) {
        lines.push(`### ${day}`);
        lines.push('');

        let currentFile: string | null = null;
        let lastTime = '';
        let tableOpen = false;

        for (const item of dayItems) {
          const isAnchor = (item.type === 'observation' && item.data.id === topResult.id);

          if (item.type === 'session') {
            // Close any open table
            if (tableOpen) {
              lines.push('');
              tableOpen = false;
              currentFile = null;
              lastTime = '';
            }

            // Render session
            const sess = item.data as SessionSummarySearchResult;
            const title = sess.request || 'Session summary';

            lines.push(`**\uD83C\uDFAF #S${sess.id}** ${title} (${formatDateTime(item.epoch)})`);
            lines.push('');
          } else if (item.type === 'prompt') {
            // Close any open table
            if (tableOpen) {
              lines.push('');
              tableOpen = false;
              currentFile = null;
              lastTime = '';
            }

            // Render prompt
            const prompt = item.data as UserPromptSearchResult;
            const truncated = prompt.prompt_text.length > 100 ? prompt.prompt_text.substring(0, 100) + '...' : prompt.prompt_text;

            lines.push(`**\uD83D\uDCAC User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
            lines.push(`> ${truncated}`);
            lines.push('');
          } else if (item.type === 'observation') {
            // Render observation in table
            const obs = item.data as ObservationSearchResult;
            const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);

            // Check if we need a new file section
            if (file !== currentFile) {
              // Close previous table
              if (tableOpen) {
                lines.push('');
              }

              // File header
              lines.push(`**${file}**`);
              lines.push(`| ID | Time | T | Title | Tokens |`);
              lines.push(`|----|------|---|-------|--------|`);

              currentFile = file;
              tableOpen = true;
              lastTime = '';
            }

            // Map observation type to emoji
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

        // Close final table if open
        if (tableOpen) {
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
  }
}
