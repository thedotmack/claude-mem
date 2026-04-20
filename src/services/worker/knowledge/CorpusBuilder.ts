/**
 * CorpusBuilder - Compiles observations from the database into a corpus file
 *
 * Uses SearchOrchestrator to find matching observations, hydrates them via
 * SessionStore, and assembles them into a complete CorpusFile.
 */

import { logger } from '../../../utils/logger.js';
import type { ObservationRecord } from '../../../types/database.js';
import type { SessionStore } from '../../sqlite/SessionStore.js';
import type { SearchOrchestrator } from '../search/SearchOrchestrator.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import { CorpusStore } from './CorpusStore.js';
import type { CorpusFile, CorpusFilter, CorpusObservation, CorpusStats } from './types.js';

/**
 * Safely parse a JSON string field from a database row.
 * Returns the parsed array or an empty array on failure.
 */
function safeParseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('WORKER', 'Failed to parse JSON array field', {}, error);
    } else {
      logger.warn('WORKER', 'Failed to parse JSON array field (non-Error thrown)', { thrownValue: String(error) });
    }
    return [];
  }
}

export class CorpusBuilder {
  private renderer: CorpusRenderer;

  constructor(
    private sessionStore: SessionStore,
    private searchOrchestrator: SearchOrchestrator,
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  /**
   * Build a corpus from database observations matching the given filter
   */
  async build(name: string, description: string, filter: CorpusFilter): Promise<CorpusFile> {
    logger.debug('WORKER', `Building corpus "${name}" with filter`, { filter });

    // Step 1: Search for matching observation IDs via SearchOrchestrator
    const searchArgs: Record<string, unknown> = {};
    if (filter.project) searchArgs.project = filter.project;
    if (filter.types && filter.types.length > 0) searchArgs.type = filter.types.join(',');
    if (filter.concepts && filter.concepts.length > 0) searchArgs.concepts = filter.concepts.join(',');
    if (filter.files && filter.files.length > 0) searchArgs.files = filter.files.join(',');
    if (filter.query) searchArgs.query = filter.query;
    if (filter.date_start) searchArgs.dateStart = filter.date_start;
    if (filter.date_end) searchArgs.dateEnd = filter.date_end;
    if (filter.limit) searchArgs.limit = filter.limit;

    const searchResult = await this.searchOrchestrator.search(searchArgs);

    // Extract observation IDs from search results
    const observationIds = (searchResult.results.observations || []).map(
      (obs: { id: number }) => obs.id
    );

    logger.debug('WORKER', `Search returned ${observationIds.length} observation IDs`);

    // Step 2: Hydrate full observation records via SessionStore
    const hydrateOptions: { orderBy?: 'date_asc' | 'date_desc'; limit?: number; project?: string; type?: string | string[] } = {
      orderBy: 'date_asc',
    };
    if (filter.project) hydrateOptions.project = filter.project;
    if (filter.types && filter.types.length > 0) hydrateOptions.type = filter.types;
    if (filter.limit) hydrateOptions.limit = filter.limit;

    const observationRows = observationIds.length > 0
      ? this.sessionStore.getObservationsByIds(observationIds, hydrateOptions)
      : [];

    logger.debug('WORKER', `Hydrated ${observationRows.length} observation records`);

    // Step 3: Map ObservationRecord rows to CorpusObservation
    const observations = observationRows.map(row => this.mapObservationToCorpus(row));

    // Step 4: Calculate stats
    const stats = this.calculateStats(observations);

    // Step 5: Assemble the corpus
    const now = new Date().toISOString();
    const corpus: CorpusFile = {
      version: 1,
      name,
      description,
      created_at: now,
      updated_at: now,
      filter,
      stats,
      system_prompt: '',
      session_id: null,
      observations,
    };

    // Step 6: Generate system prompt (needs the assembled corpus for context)
    corpus.system_prompt = this.renderer.generateSystemPrompt(corpus);

    // Update token estimate with the rendered corpus text
    const renderedText = this.renderer.renderCorpus(corpus);
    corpus.stats.token_estimate = this.renderer.estimateTokens(renderedText);

    // Step 7: Persist to disk
    this.corpusStore.write(corpus);

    logger.debug('WORKER', `Corpus "${name}" built with ${observations.length} observations, ~${corpus.stats.token_estimate} tokens`);

    return corpus;
  }

  /**
   * Map a raw ObservationRecord (with JSON string fields) to a CorpusObservation
   */
  private mapObservationToCorpus(row: ObservationRecord): CorpusObservation {
    return {
      id: row.id,
      type: row.type,
      title: (row as any).title || '',
      subtitle: (row as any).subtitle || null,
      narrative: (row as any).narrative || null,
      facts: safeParseJsonArray((row as any).facts),
      concepts: safeParseJsonArray((row as any).concepts),
      files_read: safeParseJsonArray((row as any).files_read),
      files_modified: safeParseJsonArray((row as any).files_modified),
      project: row.project,
      created_at: row.created_at,
      created_at_epoch: row.created_at_epoch,
    };
  }

  /**
   * Calculate stats from the assembled observations
   */
  private calculateStats(observations: CorpusObservation[]): CorpusStats {
    const typeBreakdown: Record<string, number> = {};
    let earliestEpoch = Infinity;
    let latestEpoch = -Infinity;

    for (const obs of observations) {
      // Type breakdown
      typeBreakdown[obs.type] = (typeBreakdown[obs.type] || 0) + 1;

      // Date range
      if (obs.created_at_epoch < earliestEpoch) earliestEpoch = obs.created_at_epoch;
      if (obs.created_at_epoch > latestEpoch) latestEpoch = obs.created_at_epoch;
    }

    const earliest = observations.length > 0
      ? new Date(earliestEpoch).toISOString()
      : new Date().toISOString();
    const latest = observations.length > 0
      ? new Date(latestEpoch).toISOString()
      : new Date().toISOString();

    return {
      observation_count: observations.length,
      token_estimate: 0, // Will be updated after rendering
      date_range: { earliest, latest },
      type_breakdown: typeBreakdown,
    };
  }
}
