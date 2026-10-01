
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../../utils/tag-stripping.js';
import { CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
import { mainAgentRowSql } from '../../shared/subagent-predicate.js';
import { poolSize, rankByStrength } from '../reinforcement/rank.js';
import type {
  ContextConfig,
  LocalObservation,
  LocalSessionSummary,
  Observation,
  SessionSummary,
  SummaryTimelineItem,
  TimelineItem,
  PriorMessages,
} from './types.js';
import { SUMMARY_LOOKAHEAD } from './types.js';

type DatabaseOwner = { db: Database };

const OBSERVATION_SELECT = `
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      o.project
`;

export function queryObservationsMulti(
  db: DatabaseOwner,
  projects: string[],
  config: ContextConfig,
  platformSource?: string
): LocalObservation[] {
  // Opt-in ACT-R ranking (CLAUDE_MEM_REINFORCE_ALPHA > 0): fetch a wider
  // recency pool and let re-confirmed older observations climb into the
  // window. With alpha = 0 the pool is exactly the configured count and the
  // rows come back as queried, i.e. the N most recent.
  const alpha = config.reinforcementAlpha ?? 0;
  const pool = queryObservationsNewest(db, config, {
    limit: poolSize(config.totalObservationCount, alpha),
    platformSource,
    projects,
    excludeSubagents: config.mainAgentOnly,
    withReinforcementDates: alpha > 0,
  });
  return rankByStrength(pool, config.totalObservationCount, alpha);
}

/**
 * Newest observations matching the active mode filters.
 *
 * Pass `projects` to stay on the SessionStart / `/api/context/inject` path
 * (strict project scope). Omit `projects` for a house-wide newest feed — used
 * only by the Grok Bot INDEX writer when a seat diary is thin. Do not add a
 * house-fallback query param to `/api/context/inject`.
 *
 * `includeManualSaves` also admits rows from `/api/memory/save` (session
 * `manual-<project>`), which are stored with no concepts and so never pass the
 * mode concept filter. The Grok Bot seat query sets it so seat self-saves land
 * in the live INDEX.
 */
export function queryObservationsNewest(
  db: DatabaseOwner,
  config: ContextConfig,
  options: {
    limit: number;
    platformSource?: string;
    projects?: string[];
    includeManualSaves?: boolean;
    excludeSubagents?: boolean;
    /** Also select the reinforcement history (only needed while ranking is on). */
    withReinforcementDates?: boolean;
  }
): LocalObservation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');
  const projects = (options.projects ?? []).filter(project => project.trim().length > 0);
  const projectClause = projects.length > 0
    ? `AND (o.project COLLATE NOCASE IN (${projects.map(() => '?').join(',')})
           OR o.merged_into_project COLLATE NOCASE IN (${projects.map(() => '?').join(',')}))`
    : '';

  const manualClause = options.includeManualSaves
    ? `substr(o.memory_session_id, 1, 7) = 'manual-' OR`
    : '';

  // #3274: SessionStart injection opts in. The seat INDEX passes `projects`
  // too, and must keep agent-tagged rows. A subagent row carries BOTH agent_id
  // and agent_type: transcript-watch rows (Grok Bot seats) carry agent_id alone
  // and must stay injected, or `session_start_context` returns nothing for them.
  const agentFilter = options.excludeSubagents ? `AND ${mainAgentRowSql('o')}` : '';

  const reinforcementColumn = options.withReinforcementDates ? ',\n      o.reinforcement_dates' : '';

  return db.db.prepare(`
    SELECT
      ${OBSERVATION_SELECT}${reinforcementColumn}
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (? IS NULL OR s.platform_source = ?)
      ${projectClause}
      ${agentFilter}
      AND (${manualClause} (
        type IN (${typePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(o.concepts)
          WHERE value IN (${conceptPlaceholders})
        )
      ))
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(
    options.platformSource ?? null,
    options.platformSource ?? null,
    ...(projects.length > 0 ? [...projects, ...projects] : []),
    ...typeArray,
    ...conceptArray,
    options.limit
  ) as LocalObservation[];
}

export function countObservationsByProjects(db: DatabaseOwner, projects: string[], platformSource?: string): number {
  if (projects.length === 0) return 0;
  const projectPlaceholders = projects.map(() => '?').join(',');
  const row = db.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project COLLATE NOCASE IN (${projectPlaceholders})
       OR o.merged_into_project COLLATE NOCASE IN (${projectPlaceholders}))
      AND (? IS NULL OR s.platform_source = ?)
  `).get(...projects, ...projects, platformSource ?? null, platformSource ?? null) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function querySummariesMulti(
  db: DatabaseOwner,
  projects: string[],
  config: ContextConfig,
  platformSource?: string
): LocalSessionSummary[] {
  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch,
      ss.project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project COLLATE NOCASE IN (${projectPlaceholders})
           OR ss.merged_into_project COLLATE NOCASE IN (${projectPlaceholders}))
      AND (? IS NULL OR s.platform_source = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(
    ...projects,
    ...projects,
    platformSource ?? null,
    platformSource ?? null,
    config.sessionCount + SUMMARY_LOOKAHEAD
  ) as LocalSessionSummary[];
}

export function cwdToDashed(cwd: string): string {
  // Claude Code encodes a project's transcript directory by replacing BOTH path
  // separators AND dots with dashes (e.g. `/Users/john.doe/proj` ->
  // `-Users-john-doe-proj`). Replacing only `/` left a literal `.` in the dir
  // name, so "Include last message" silently no-opped for any cwd component
  // containing a dot — Unix usernames like `john.doe`, dotted dirs, etc. (#2401).
  return cwd.replace(/[/.]/g, '-');
}

function parseAssistantTextFromLine(line: string): string | null {
  if (!line.includes('"type":"assistant"')) return null;

  const entry = JSON.parse(line);
  if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
    let text = '';
    for (const block of entry.message.content) {
      if (block.type === 'text') text += block.text;
    }
    text = text.replace(SYSTEM_REMINDER_REGEX, '').trim();
    if (text) return text;
  }
  return null;
}

function findLastAssistantMessage(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const result = parseAssistantTextFromLine(lines[i]);
      if (result) return result;
    } catch (parseError) {
      if (parseError instanceof Error) {
        logger.debug('WORKER', 'Skipping malformed transcript line', { lineIndex: i }, parseError);
      } else {
        logger.debug('WORKER', 'Skipping malformed transcript line', { lineIndex: i, error: String(parseError) });
      }
      continue;
    }
  }
  return '';
}

export function extractPriorMessages(transcriptPath: string): PriorMessages {
  try {
    if (!existsSync(transcriptPath)) return { assistantMessage: '' };
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return { assistantMessage: '' };

    const lines = content.split('\n').filter(line => line.trim());
    const lastAssistantMessage = findLastAssistantMessage(lines);
    return { assistantMessage: lastAssistantMessage };
  } catch (error) {
    if (error instanceof Error) {
      logger.failure('WORKER', 'Failed to extract prior messages from transcript', { transcriptPath }, error);
    } else {
      logger.warn('WORKER', 'Failed to extract prior messages from transcript', { transcriptPath, error: String(error) });
    }
    return { assistantMessage: '' };
  }
}

export function getPriorSessionMessages(
  observations: Observation[],
  config: ContextConfig,
  currentSessionId: string | undefined,
  cwd: string
): PriorMessages {
  if (!config.showLastMessage || observations.length === 0) {
    return { assistantMessage: '' };
  }

  const priorSessionObs = observations.find(obs => obs.memory_session_id !== currentSessionId);
  if (!priorSessionObs) {
    return { assistantMessage: '' };
  }

  const priorSessionId = priorSessionObs.memory_session_id;
  const dashedCwd = cwdToDashed(cwd);
  const transcriptPath = path.join(CLAUDE_CONFIG_DIR, 'projects', dashedCwd, `${priorSessionId}.jsonl`);
  return extractPriorMessages(transcriptPath);
}

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

export function buildTimeline(
  observations: Observation[],
  summaries: SummaryTimelineItem[]
): TimelineItem[] {
  const timeline: TimelineItem[] = [
    ...observations.map(obs => ({ type: 'observation' as const, data: obs })),
    ...summaries.map(summary => ({ type: 'summary' as const, data: summary }))
  ];

  timeline.sort((a, b) => {
    const aEpoch = a.type === 'observation' ? a.data.created_at_epoch : a.data.displayEpoch;
    const bEpoch = b.type === 'observation' ? b.data.created_at_epoch : b.data.displayEpoch;
    return aEpoch - bEpoch;
  });

  return timeline;
}

export function getFullObservationIds(observations: Observation[], count: number): Set<Observation['id']> {
  return new Set(
    observations
      .slice(0, count)
      .map(obs => obs.id)
  );
}
