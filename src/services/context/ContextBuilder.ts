/**
 * ContextBuilder - Main orchestrator for context generation
 *
 * Coordinates all context generation components to build the final output.
 * This is the primary entry point for context generation.
 */

import path from 'path';
import { unlinkSync } from 'fs';
import { PLUGIN_ROOT } from '../../shared/worker-utils.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { getProjectName } from '../../utils/project-name.js';

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
import { renderMarkdownEmptyState } from './formatters/MarkdownFormatter.js';
import { renderColorEmptyState } from './formatters/ColorFormatter.js';

// Version marker path for native module error handling
const VERSION_MARKER_PATH = path.join(PLUGIN_ROOT, '.install-version');

/**
 * Initialize database connection with error handling
 */
function initializeDatabase(): SessionStore | null {
  try {
    return new SessionStore();
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        logger.debug('SYSTEM', 'Marker file cleanup failed (may not exist)', {}, unlinkError as Error);
      }
      logger.error('SYSTEM', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

/**
 * Render empty state when no data exists
 */
function renderEmptyState(project: string, useColors: boolean): string {
  return useColors ? renderColorEmptyState(project) : renderMarkdownEmptyState(project);
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
  useColors: boolean,
  economics: ReturnType<typeof calculateTokenEconomics>
): string {
  const output: string[] = [];

  // Render header section
  output.push(...renderHeader(project, economics, config, useColors));

  // Prepare timeline data
  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  // Render timeline
  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, useColors));

  // Render most recent summary if applicable
  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, useColors));
  }

  // Render previously section (prior assistant message)
  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, useColors));

  // Render footer
  output.push(...renderFooter(economics, config, useColors));

  return output.join('\n').trimEnd();
}

/**
 * Result from context generation with analytics metadata
 */
export interface ContextResult {
  /** Formatted context text ready for display */
  text: string;
  /** IDs of all observations included in the context */
  observationIds: number[];
  /** Estimated read tokens for all included observations */
  totalReadTokens: number;
}

/**
 * Generate context for a project
 *
 * Main entry point for context generation. Orchestrates loading config,
 * querying data, and rendering the final context string.
 */
export function generateContext(
  input?: ContextInput,
  useColors: boolean = false
): string {
  return generateContextWithMeta(input, useColors).text;
}

/**
 * Generate context for a project and return analytics metadata alongside the text.
 *
 * Returns the same formatted context as generateContext() plus the observation
 * IDs and estimated read token count needed for injection tracking.
 */
export function generateContextWithMeta(
  input?: ContextInput,
  useColors: boolean = false
): ContextResult {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const project = getProjectName(cwd);

  // Use provided projects array (for worktree support) or fall back to single project
  const projects = input?.projects || [project];

  // Initialize database
  const db = initializeDatabase();
  if (!db) {
    return { text: '', observationIds: [], totalReadTokens: 0 };
  }

  try {
    // Query data for all projects (supports worktree: parent + worktree combined)
    const observations = projects.length > 1
      ? queryObservationsMulti(db, projects, config)
      : queryObservations(db, project, config);
    const summaries = projects.length > 1
      ? querySummariesMulti(db, projects, config)
      : querySummaries(db, project, config);

    // Handle empty state
    if (observations.length === 0 && summaries.length === 0) {
      return {
        text: renderEmptyState(project, useColors),
        observationIds: [],
        totalReadTokens: 0,
      };
    }

    // Compute metadata from observations (single call, shared with buildContextOutput)
    const observationIds = observations.map(obs => obs.id);
    const economics = calculateTokenEconomics(observations);

    // Build and return context with metadata
    return {
      text: buildContextOutput(
        project,
        observations,
        summaries,
        config,
        cwd,
        input?.session_id,
        useColors,
        economics
      ),
      observationIds,
      totalReadTokens: economics.totalReadTokens,
    };
  } finally {
    db.close();
  }
}
