import type { Database } from './sqlite-compat.js';
import { logger } from '../../utils/logger.js';

/**
 * Parameters for recording a context injection event
 */
export interface TrackInjectionParams {
  sessionId?: string;
  project: string;
  observationIds: number[];
  totalReadTokens: number;
  injectionSource: 'session_start' | 'prompt_submit' | 'mcp_search';
}

/**
 * InjectionTracker — records context injection events for token analytics.
 *
 * Each call to trackInjection() writes one row to context_injections,
 * capturing which observations were surfaced into the model context
 * and how many read tokens they consumed.
 */
export class InjectionTracker {
  constructor(private readonly db: Database) {}

  /**
   * Record a context injection event.
   * Stores which observations were injected, the source hook, and the token cost.
   */
  trackInjection(params: TrackInjectionParams): void {
    const now = new Date();
    this.db.prepare(`
      INSERT INTO context_injections (
        session_id,
        project,
        observation_ids,
        total_read_tokens,
        injection_source,
        created_at,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.sessionId ?? null,
      params.project,
      JSON.stringify(params.observationIds),
      params.totalReadTokens,
      params.injectionSource,
      now.toISOString(),
      now.getTime()
    );
    logger.debug('ANALYTICS', `Tracked ${params.injectionSource} injection`, {
      project: params.project,
      observationCount: params.observationIds.length,
      readTokens: params.totalReadTokens,
    });
  }
}
