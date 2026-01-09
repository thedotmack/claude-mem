/**
 * ObservationCompiler - Query building and data retrieval for context
 *
 * Handles database queries for observations and summaries, plus transcript extraction.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
import type {
  ContextConfig,
  Observation,
  SessionSummary,
  SummaryTimelineItem,
  TimelineItem,
  PriorMessages,
} from './types.js';
import { SUMMARY_LOOKAHEAD } from './types.js';

/**
 * Query observations from database with type and concept filtering
 */
export function queryObservations(
  db: SessionStore,
  project: string,
  config: ContextConfig
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, ...typeArray, ...conceptArray, config.totalObservationCount) as Observation[];
}

/**
 * Query recent session summaries from database
 */
export function querySummaries(
  db: SessionStore,
  project: string,
  config: ContextConfig
): SessionSummary[] {
  return db.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];
}

/**
 * Query observations from multiple projects (for worktree support)
 *
 * Returns observations from all specified projects, interleaved chronologically.
 * Used when running in a worktree to show both parent repo and worktree observations.
 */
export function queryObservationsMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  // Build IN clause for projects
  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch, project
    FROM observations
    WHERE project IN (${projectPlaceholders})
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...projects, ...typeArray, ...conceptArray, config.totalObservationCount) as Observation[];
}

/**
 * Query session summaries from multiple projects (for worktree support)
 *
 * Returns summaries from all specified projects, interleaved chronologically.
 * Used when running in a worktree to show both parent repo and worktree summaries.
 */
export function querySummariesMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig
): SessionSummary[] {
  // Build IN clause for projects
  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch, project
    FROM session_summaries
    WHERE project IN (${projectPlaceholders})
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...projects, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];
}

/**
 * Convert cwd path to dashed format for transcript lookup
 */
function cwdToDashed(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Extract prior messages from transcript file
 */
export function extractPriorMessages(transcriptPath: string): PriorMessages {
  try {
    if (!existsSync(transcriptPath)) {
      return { userMessage: '', assistantMessage: '' };
    }

    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return { userMessage: '', assistantMessage: '' };
    }

    const lines = content.split('\n').filter(line => line.trim());
    let lastAssistantMessage = '';

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = lines[i];
        if (!line.includes('"type":"assistant"')) {
          continue;
        }

        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
          let text = '';
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          if (text) {
            lastAssistantMessage = text;
            break;
          }
        }
      } catch (parseError) {
        logger.debug('PARSER', 'Skipping malformed transcript line', { lineIndex: i }, parseError as Error);
        continue;
      }
    }

    return { userMessage: '', assistantMessage: lastAssistantMessage };
  } catch (error) {
    logger.failure('WORKER', `Failed to extract prior messages from transcript`, { transcriptPath }, error as Error);
    return { userMessage: '', assistantMessage: '' };
  }
}

/**
 * Get prior session messages if enabled
 */
export function getPriorSessionMessages(
  observations: Observation[],
  config: ContextConfig,
  currentSessionId: string | undefined,
  cwd: string
): PriorMessages {
  if (!config.showLastMessage || observations.length === 0) {
    return { userMessage: '', assistantMessage: '' };
  }

  const priorSessionObs = observations.find(obs => obs.memory_session_id !== currentSessionId);
  if (!priorSessionObs) {
    return { userMessage: '', assistantMessage: '' };
  }

  const priorSessionId = priorSessionObs.memory_session_id;
  const dashedCwd = cwdToDashed(cwd);
  // Use CLAUDE_CONFIG_DIR to support custom Claude config directories
  const transcriptPath = path.join(CLAUDE_CONFIG_DIR, 'projects', dashedCwd, `${priorSessionId}.jsonl`);
  return extractPriorMessages(transcriptPath);
}

/**
 * Prepare summaries for timeline display
 */
export function prepareSummariesForTimeline(
  displaySummaries: SessionSummary[],
  allSummaries: SessionSummary[]
): SummaryTimelineItem[] {
  const mostRecentSummaryId = allSummaries[0]?.id;

  return displaySummaries.map((summary, i) => {
    const olderSummary = i === 0 ? null : allSummaries[i + 1];
    return {
      ...summary,
      displayEpoch: olderSummary ? olderSummary.created_at_epoch : summary.created_at_epoch,
      displayTime: olderSummary ? olderSummary.created_at : summary.created_at,
      shouldShowLink: summary.id !== mostRecentSummaryId
    };
  });
}

/**
 * Build unified timeline from observations and summaries
 */
export function buildTimeline(
  observations: Observation[],
  summaries: SummaryTimelineItem[]
): TimelineItem[] {
  const timeline: TimelineItem[] = [
    ...observations.map(obs => ({ type: 'observation' as const, data: obs })),
    ...summaries.map(summary => ({ type: 'summary' as const, data: summary }))
  ];

  // Sort chronologically
  timeline.sort((a, b) => {
    const aEpoch = a.type === 'observation' ? a.data.created_at_epoch : a.data.displayEpoch;
    const bEpoch = b.type === 'observation' ? b.data.created_at_epoch : b.data.displayEpoch;
    return aEpoch - bEpoch;
  });

  return timeline;
}

/**
 * Get set of observation IDs that should show full details
 */
export function getFullObservationIds(observations: Observation[], count: number): Set<number> {
  return new Set(
    observations
      .slice(0, count)
      .map(obs => obs.id)
  );
}
