
import path from 'path';
import { homedir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../sqlite/connection.js';

import type { ContextInput, ContextConfig, Observation, SessionSummary } from './types.js';
import { colors } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { fitContextToBudget, CONTEXT_OUTPUT_LIMIT } from './ContextBudget.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  queryObservationsMulti,
  querySummariesMulti,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import { renderTimeline } from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection, renderFooter } from './sections/FooterRenderer.js';
import { renderAgentEmptyState } from './formatters/AgentFormatter.js';
import { renderHumanEmptyState } from './formatters/HumanFormatter.js';
import {
  readObserverHealth,
  isObserverUnhealthy,
  renderObserverHealthWarning,
} from '../../shared/observer-health.js';

const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'thedotmack',
  'plugin',
  '.install-version'
);

function initializeDatabase(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true, create: false });
    try {
      db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        if (unlinkError instanceof Error) {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', {}, unlinkError);
        } else {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', { error: String(unlinkError) });
        }
      }
      logger.error('WORKER', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

function renderEmptyState(project: string, forHuman: boolean): string {
  return forHuman ? renderHumanEmptyState(project) : renderAgentEmptyState(project);
}

function buildContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  forHuman: boolean
): string {
  const output: string[] = [];

  const economics = calculateTokenEconomics(observations);

  output.push(...renderHeader(project, economics, config, forHuman));

  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, forHuman));

  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, forHuman));
  }

  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, forHuman));

  output.push(...renderFooter(economics, config, forHuman));

  return output.join('\n').trimEnd();
}

/**
 * Telemetry-facing shape of one context injection. Counts, booleans, and our
 * own enum strings only — computed from the same observation set that was
 * rendered, never from user content.
 */
export interface ContextInjectStats {
  observation_count: number;
  session_count: number;
  timeline_depth_days: number;
  has_session_summary: boolean;
  obs_type_bugfix: number;
  obs_type_discovery: number;
  obs_type_decision: number;
  obs_type_refactor: number;
  obs_type_other: number;
  tokens_injected: number;
  tokens_saved_vs_naive: number;
  search_strategy: string;
}

const STAT_TYPE_BUCKETS = new Set(['bugfix', 'discovery', 'decision', 'refactor']);

function buildInjectStats(
  observations: Observation[],
  summaries: SessionSummary[],
  full: boolean
): ContextInjectStats {
  const economics = calculateTokenEconomics(observations);
  const typeCounts: Record<string, number> = {
    bugfix: 0, discovery: 0, decision: 0, refactor: 0, other: 0,
  };
  const sessionIds = new Set<string>();
  let oldestEpoch = Number.POSITIVE_INFINITY;
  for (const obs of observations) {
    const bucket = STAT_TYPE_BUCKETS.has(obs.type) ? obs.type : 'other';
    typeCounts[bucket]++;
    if (obs.memory_session_id) sessionIds.add(obs.memory_session_id);
    if (obs.created_at_epoch && obs.created_at_epoch < oldestEpoch) {
      oldestEpoch = obs.created_at_epoch;
    }
  }
  const timelineDepthDays = Number.isFinite(oldestEpoch)
    ? Math.max(0, Math.floor((Date.now() - oldestEpoch) / 86_400_000))
    : 0;

  return {
    observation_count: observations.length,
    session_count: sessionIds.size,
    timeline_depth_days: timelineDepthDays,
    has_session_summary: summaries.length > 0,
    obs_type_bugfix: typeCounts.bugfix,
    obs_type_discovery: typeCounts.discovery,
    obs_type_decision: typeCounts.decision,
    obs_type_refactor: typeCounts.refactor,
    obs_type_other: typeCounts.other,
    tokens_injected: economics.totalReadTokens,
    tokens_saved_vs_naive: economics.savings,
    search_strategy: full ? 'full' : 'timeline',
  };
}

/**
 * Paint every non-blank line, rather than wrapping the block once: session
 * context is long enough to scroll, and a single leading escape leaves the
 * warning uncolored wherever the terminal reflows or the reader scrolls back.
 */
function paintRed(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `${colors.red}${line}${colors.reset}` : line))
    .join('\n');
}

/**
 * Append the observer-health outage warning when the observer is failing.
 * Applied to EVERY context path (including empty-state, missing-DB, and the
 * no-memories-yet welcome hint in SearchRoutes) so the outage is surfaced even
 * when there is nothing else to render.
 *
 * BELOW the context, not above it: the timeline runs long, so a warning at the
 * top has already scrolled off by the time the context finishes printing. The
 * last thing rendered is the thing still on screen — and for the model, the
 * closest thing to its first reply.
 */
export function withObserverHealthWarning(text: string, forHuman: boolean = false): string {
  return appendObserverHealthWarning(observerHealthWarning(forHuman), text);
}

/**
 * The warning on its own, or `''` when the observer is healthy.
 *
 * Split out so the fitted path can read the health ONCE and then measure the
 * warning as part of the block it is fitting. `fitContextToBudget` calls its
 * render repeatedly, and `readObserverHealth` touches state: re-reading it per
 * reduction would let the measured length change under the loop.
 */
export function observerHealthWarning(forHuman: boolean = false): string {
  const health = readObserverHealth();
  if (!isObserverUnhealthy(health)) {
    return '';
  }
  const warning = renderObserverHealthWarning(health);
  // Colors only on the human render: the agent copy is fetched separately
  // (colors=false) and ANSI escapes there are noise in the model's context.
  return forHuman ? paintRed(warning) : warning;
}

function appendObserverHealthWarning(warning: string, text: string): string {
  if (!warning) return text;
  return text ? `${text}\n\n${warning}` : warning;
}

/**
 * Fit the block to `limit` and report on exactly what survived.
 *
 * Split out of `generateContextWithStats` so both halves can be tested without
 * a database: the caller's only remaining job is to fetch rows. Two things have
 * to happen together here, and neither is safe on its own.
 *
 * The health warning is rendered INSIDE the measured block. Appending it to the
 * fitted result spends characters the fitter never counted, so an unhealthy
 * observer could push a block just fitted to 9,998 back over the limit — and
 * over the limit the whole block is replaced by the preview stub #3802 exists
 * to avoid, which is exactly when an outage warning most needs to arrive.
 *
 * The stats describe what was DELIVERED, not what was queried.
 * `ContextInjectStats` already promises this ("computed from the same
 * observation set that was rendered"); before this, a run trimmed from seven
 * observations to three still reported seven, so telemetry read as healthy
 * precisely when context was being dropped. `sessionCount` is the same slice
 * `buildContextOutput` takes for `displaySummaries`.
 */
export function fitContextForDelivery(
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  healthWarning: string,
  renderBlock: (items: Observation[], cfg: ContextConfig) => string,
  limit: number,
  full: boolean
): { text: string; stats: ContextInjectStats } {
  const budget = fitContextToBudget(
    observations,
    config,
    (items, cfg) => appendObserverHealthWarning(healthWarning, renderBlock(items, cfg)),
    limit
  );

  if (budget.reductions > 0) {
    logger.debug('HOOK', 'Trimmed context to fit the hook output limit', {
      reductions: budget.reductions,
      observations: budget.observationCount,
      sessions: budget.config.sessionCount,
      chars: budget.text.length,
      overBudget: budget.overBudget,
    });
  }

  return {
    text: budget.text,
    stats: buildInjectStats(
      observations.slice(0, budget.observationCount),
      summaries.slice(0, budget.config.sessionCount),
      full
    ),
  };
}

export async function generateContextWithStats(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<{ text: string; stats: ContextInjectStats | null }> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const context = getProjectContext(cwd);

  const projects = input?.projects?.length ? input.projects : context.allProjects;
  const project = projects[projects.length - 1] ?? context.primary;

  if (input?.full) {
    config.totalObservationCount = 999999;
    config.sessionCount = 999999;
  }

  const rawDb = initializeDatabase();
  if (!rawDb) {
    return { text: withObserverHealthWarning('', forHuman), stats: null };
  }

  try {
    const db = { db: rawDb };
    const platformSource = input?.platformSource
      ? normalizePlatformSource(input.platformSource)
      : undefined;
    const queryProjects = projects.length > 1 ? projects : [project];
    const observations = queryObservationsMulti(db, queryProjects, config, platformSource);
    const summaries = querySummariesMulti(db, queryProjects, config, platformSource);

    if (observations.length === 0 && summaries.length === 0) {
      return { text: withObserverHealthWarning(renderEmptyState(project, forHuman), forHuman), stats: null };
    }

    // `--full` is an explicit human request for everything; only the block that
    // has to survive a hook's 10,000-character delivery limit is fitted (#3802).
    return fitContextForDelivery(
      observations,
      summaries,
      config,
      observerHealthWarning(forHuman),
      (items, cfg) =>
        buildContextOutput(project, items, summaries, cfg, cwd, input?.session_id, forHuman),
      input?.full ? Number.POSITIVE_INFINITY : CONTEXT_OUTPUT_LIMIT,
      Boolean(input?.full)
    );
  } finally {
    rawDb.close();
  }
}

export async function generateContext(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<string> {
  return (await generateContextWithStats(input, forHuman)).text;
}
