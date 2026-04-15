/**
 * ContextBuilder - Main orchestrator for context generation
 *
 * Coordinates all context generation components to build the final output.
 * This is the primary entry point for context generation.
 */

import path from 'path';
import { homedir } from 'os';
import { unlinkSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';

import type { ContextInput, ContextConfig, Observation, SessionSummary } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  queryObservations,
  queryObservationsMulti,
  querySummaries,
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

// Version marker path for native module error handling
const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'thedotmack',
  'plugin',
  '.install-version'
);

// Module-level singleton — avoids re-opening the database and re-running
// migration checks on every context inject call.
let _sharedDb: SessionStore | null | undefined;

/**
 * Return the shared database connection, creating it on first call.
 * Returns null when the native module needs a rebuild (ERR_DLOPEN_FAILED).
 */
function getDatabase(): SessionStore | null {
  if (_sharedDb !== undefined) return _sharedDb;
  try {
    _sharedDb = new SessionStore();
  } catch (error: any) {
    // APPROVED OVERRIDE: ERR_DLOPEN_FAILED requires process-level filesystem cleanup
    // (unlinking the version marker) so the native module rebuilds on next startup.
    // This intentionally sets _sharedDb = null to short-circuit all future calls
    // without rethrowing, keeping the worker alive in a degraded state.
    if (error.code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        logger.debug('SYSTEM', 'Marker file cleanup failed (may not exist)', {}, unlinkError as Error);
      }
      logger.debug('SYSTEM', 'ERR_DLOPEN_FAILED detail', {}, error as Error);
      logger.error('SYSTEM', 'Native module rebuild needed - restart Claude Code to auto-fix');
      _sharedDb = null;
    } else {
      throw error;
    }
  }
  return _sharedDb;
}

/**
 * Close the shared database connection and reset the singleton.
 * Call this from the worker shutdown path alongside DatabaseManager.close().
 */
export function closeSharedDatabase(): void {
  try {
    if (_sharedDb) {
      _sharedDb.close();
    }
  } finally {
    _sharedDb = undefined;
  }
}

/**
 * Render empty state when no data exists
 */
function renderEmptyState(project: string, forHuman: boolean): string {
  return forHuman ? renderHumanEmptyState(project) : renderAgentEmptyState(project);
}

/**
 * Build context output from loaded data
 */
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

  // Calculate token economics
  const economics = calculateTokenEconomics(observations);

  // Render header section
  output.push(...renderHeader(project, economics, config, forHuman));

  // Prepare timeline data
  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  // Render timeline
  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, forHuman));

  // Render most recent summary if applicable
  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, forHuman));
  }

  // Render previously section (prior assistant message)
  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, forHuman));

  // Render footer
  output.push(...renderFooter(economics, config, forHuman));

  return output.join('\n').trimEnd();
}

/**
 * Generate context for a project
 *
 * Main entry point for context generation. Orchestrates loading config,
 * querying data, and rendering the final context string.
 */
export async function generateContext(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<string> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const context = getProjectContext(cwd);
  const project = context.primary;
  const platformSource = input?.platform_source;

  // Use provided projects array (for worktree support) or fall back to all known projects
  const projects = input?.projects ?? context.allProjects;

  // Full mode: fetch all observations but keep normal rendering (level 1 summaries)
  if (input?.full) {
    config.totalObservationCount = 999999;
    config.sessionCount = 999999;
  }

  // Reuse the shared database connection (singleton) — avoids reopening the
  // database and rerunning migration checks on every context inject call.
  const db = getDatabase();
  if (!db) {
    return '';
  }

  // Query data for all projects (supports worktree: parent + worktree combined)
  const observations = projects.length > 1
    ? queryObservationsMulti(db, projects, config, platformSource)
    : queryObservations(db, project, config, platformSource);
  const summaries = projects.length > 1
    ? querySummariesMulti(db, projects, config, platformSource)
    : querySummaries(db, project, config, platformSource);

  // Handle empty state
  if (observations.length === 0 && summaries.length === 0) {
    return renderEmptyState(project, forHuman);
  }

  // Build and return context
  return buildContextOutput(
    project,
    observations,
    summaries,
    config,
    cwd,
    input?.session_id,
    forHuman
  );
}
