import type { Database } from 'bun:sqlite';
import type { Observation, SessionSummary } from '../context/types.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../context/types.js';
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
    const observationTokens = calculateObservationTokens(obs);
    if (cumulativeTokens + observationTokens > tokenBudget) break;
    cumulativeTokens += observationTokens;
    keptObservations.push(obs);
  }

  // Summaries share the same budget. Each renders as one
  // `S<id> <request> (time)` line (AgentFormatter.renderAgentSummaryItem), so
  // its cost is its request text — a stored 4,000-char request is a
  // 1,000-token line, and sessionCount of those can dwarf the observation
  // budget if left uncounted (PR #3516 review).
  const keptSummaries: SessionSummary[] = [];
  const summaries = querySummariesMulti(db, [project], config);
  for (const summary of summaries.slice(0, config.sessionCount)) {
    const summaryTokens = Math.ceil((summary.request ?? '').length / CHARS_PER_TOKEN_ESTIMATE);
    if (cumulativeTokens + summaryTokens > tokenBudget) break;
    cumulativeTokens += summaryTokens;
    keptSummaries.push(summary);
  }

  logger.debug('WORKER', 'Compaction timeline budget walk', {
    keptObservations: keptObservations.length,
    totalObservations: observations.length,
    keptSummaries: keptSummaries.length,
    tokenBudget,
  });

  const render = () => {
    const summariesForTimeline = prepareSummariesForTimeline(keptSummaries, summaries);
    const timeline = buildTimeline(keptObservations, summariesForTimeline);
    const fullObservationIds = getFullObservationIds(keptObservations, config.fullObservationCount);
    return {
      rendered: renderTimeline(timeline, fullObservationIds, config, cwd, false).join('\n').trimEnd(),
      summariesForTimeline,
    };
  };

  // The admission walk above only charges each item's content, but rendering
  // adds scaffolding — day headers, `S<id> … (<datetime>)` wrappers, table
  // chrome — that can dwarf tiny items (PR #3516 review: ten one-char summary
  // requests under a 10-token budget rendered ~94 tokens). Enforce the budget
  // on the actual rendered output: drop the oldest kept item (both lists are
  // newest-first, so the oldest is the tail) and re-render until it fits.
  let { rendered, summariesForTimeline } = render();
  while (
    Math.ceil(rendered.length / CHARS_PER_TOKEN_ESTIMATE) > tokenBudget &&
    (keptObservations.length > 0 || keptSummaries.length > 0)
  ) {
    const oldestObservation = keptObservations[keptObservations.length - 1];
    const oldestSummary = summariesForTimeline[summariesForTimeline.length - 1];
    if (
      oldestSummary === undefined ||
      (oldestObservation !== undefined &&
        oldestObservation.created_at_epoch <= oldestSummary.displayEpoch)
    ) {
      keptObservations.pop();
    } else {
      keptSummaries.pop();
    }
    ({ rendered, summariesForTimeline } = render());
  }

  return rendered;
}
