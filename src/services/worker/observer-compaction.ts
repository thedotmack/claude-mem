
import type { Database } from 'bun:sqlite';
import type { Observation } from '../context/types.js';
import { loadContextConfig } from '../context/ContextConfigLoader.js';
import { calculateObservationTokens } from '../context/TokenCalculator.js';
import {
  queryObservationsMulti,
  querySummariesMulti,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from '../context/ObservationCompiler.js';
import { renderTimeline } from '../context/sections/TimelineRenderer.js';
import { logger } from '../../utils/logger.js';

// Generous query ceiling: the token-budget walk below decides what actually
// survives, so the count knob only needs to be large enough to never be the
// binding constraint (runtime-override precedent: the `full` flag in
// ContextBuilder.generateContextWithStats).
const COMPACTION_OBSERVATION_CEILING = 500;

/**
 * Build a recent-observations timeline for the observer compaction hook,
 * bounded by a token budget instead of a fixed observation count.
 *
 * Walks the newest-first observation list, keeping observations while their
 * cumulative estimated tokens stay within `tokenBudget`, then renders the
 * survivors through the same timeline pipeline as session-start context
 * (assembly order copied from ContextBuilder.buildContextOutput).
 */
export function buildCompactionTimeline(
  db: { db: Database },
  project: string,
  cwd: string,
  tokenBudget: number
): string {
  const config = loadContextConfig();
  config.totalObservationCount = COMPACTION_OBSERVATION_CEILING;

  // Newest-first (ORDER BY created_at_epoch DESC in queryObservationsMulti).
  const observations = queryObservationsMulti(db, [project], config);

  // Budget → count conversion: keep newest observations while the cumulative
  // token estimate stays within budget; everything older is dropped.
  const keptObservations: Observation[] = [];
  let cumulativeTokens = 0;
  for (const obs of observations) {
    cumulativeTokens += calculateObservationTokens(obs);
    if (cumulativeTokens > tokenBudget) break;
    keptObservations.push(obs);
  }

  logger.debug('WORKER', 'Compaction timeline budget walk', {
    keptObservations: keptObservations.length,
    totalObservations: observations.length,
    tokenBudget,
  });

  const summaries = querySummariesMulti(db, [project], config);

  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(keptObservations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(keptObservations, config.fullObservationCount);

  const output = renderTimeline(timeline, fullObservationIds, config, cwd, false);

  return output.join('\n').trimEnd();
}
