
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { NOT_DISMISSED_SQL } from '../sqlite/observations/dismiss-filter.js';
import { logger } from '../../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../../utils/tag-stripping.js';
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
import { NOT_DISMISSED_SQL } from '../sqlite/observations/dismiss-filter.js';

function isDreamProject(project: string | null | undefined): boolean {
  return Boolean(project?.endsWith(':dream'));
}

function rawProjectName(project: string): string {
  return isDreamProject(project) ? project.slice(0, -':dream'.length) : project;
}

function uniqueProjects(projects: string[]): string[] {
  return Array.from(new Set(projects.filter(Boolean)));
}

function rawProjectsForFallback(projects: string[]): string[] {
  return uniqueProjects(projects.map(rawProjectName));
}

function rowMatchesRawProject(
  row: { project?: string | null; merged_into_project?: string | null },
  rawProjects: Set<string>
): boolean {
  return Boolean(
    (row.project && !isDreamProject(row.project) && rawProjects.has(row.project))
    || (row.merged_into_project && rawProjects.has(row.merged_into_project))
  );
}

function sortRowsForContext<T extends { project?: string | null; merged_into_project?: string | null; created_at_epoch: number }>(
  rows: T[],
  rawProjects: string[]
): T[] {
  const rawProjectSet = new Set(rawProjects);
  return [...rows].sort((a, b) => {
    const aIsDream = isDreamProject(a.project) && !rowMatchesRawProject(a, rawProjectSet);
    const bIsDream = isDreamProject(b.project) && !rowMatchesRawProject(b, rawProjectSet);
    if (aIsDream !== bIsDream) return aIsDream ? -1 : 1;
    return b.created_at_epoch - a.created_at_epoch;
  });
}

function includeRawFallback(
  rows: Observation[],
  fallback: Observation | null,
  rawProjects: string[],
  limit: number
): Observation[] {
  const rawProjectSet = new Set(rawProjects);
  const selected = rows.slice(0, limit);
  if (!fallback || selected.length === 0 || selected.some(row => rowMatchesRawProject(row, rawProjectSet))) {
    return selected;
  }
  const duplicateIndex = selected.findIndex(row => row.id === fallback.id);
  if (duplicateIndex >= 0) return selected;
  return [...selected.slice(0, Math.max(0, limit - 1)), fallback];
}

function queryLatestRawObservation(
  db: SessionStore,
  rawProjects: string[],
  typeArray: string[],
  conceptArray: string[],
  platformSource?: string
): Observation | null {
  if (rawProjects.length === 0) return null;

  const projectPlaceholders = rawProjects.map(() => '?').join(',');
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  const row = db.db.prepare(`
    SELECT
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
      o.project,
      o.merged_into_project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${projectPlaceholders})
           OR o.merged_into_project IN (${projectPlaceholders}))
      AND o.project NOT LIKE '%:dream'
      AND (? IS NULL OR s.platform_source = ?)
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${conceptPlaceholders})
      )
      AND ${NOT_DISMISSED_SQL}
    ORDER BY o.created_at_epoch DESC
    LIMIT 1
  `).get(
    ...rawProjects,
    ...rawProjects,
    platformSource ?? null,
    platformSource ?? null,
    ...typeArray,
    ...conceptArray
  ) as Observation | undefined;

  return row ?? null;
}

export function queryObservationsMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig,
  platformSource?: string
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  const projectPlaceholders = projects.map(() => '?').join(',');
  const rawProjects = rawProjectsForFallback(projects);
  const hasDreamProjects = projects.some(isDreamProject);
  const queryLimit = hasDreamProjects
    ? Math.max(config.totalObservationCount * 2, config.totalObservationCount + rawProjects.length)
    : config.totalObservationCount;

  const rows = db.db.prepare(`
    SELECT
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
      o.project,
      o.merged_into_project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${projectPlaceholders})
           OR o.merged_into_project IN (${projectPlaceholders}))
      AND (? IS NULL OR s.platform_source = ?)
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${conceptPlaceholders})
      )
      AND ${NOT_DISMISSED_SQL}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(
    ...projects,
    ...projects,
    platformSource ?? null,
    platformSource ?? null,
    ...typeArray,
    ...conceptArray,
    queryLimit
  ) as Observation[];

  if (!hasDreamProjects) return rows;

  const sorted = sortRowsForContext(rows, rawProjects);
  const rawFallback = queryLatestRawObservation(db, rawProjects, typeArray, conceptArray, platformSource);
  return includeRawFallback(sorted, rawFallback, rawProjects, config.totalObservationCount);
}

export function countObservationsByProjects(db: SessionStore, projects: string[], platformSource?: string): number {
  if (projects.length === 0) return 0;
  const projectPlaceholders = projects.map(() => '?').join(',');
  const row = db.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${projectPlaceholders})
       OR o.merged_into_project IN (${projectPlaceholders}))
      AND (? IS NULL OR s.platform_source = ?)
      AND ${NOT_DISMISSED_SQL}
  `).get(...projects, ...projects, platformSource ?? null, platformSource ?? null) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function querySummariesMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig,
  platformSource?: string
): SessionSummary[] {
  const projectPlaceholders = projects.map(() => '?').join(',');
  const rawProjects = rawProjectsForFallback(projects);
  const hasDreamProjects = projects.some(isDreamProject);
  const queryLimit = hasDreamProjects
    ? Math.max((config.sessionCount + SUMMARY_LOOKAHEAD) * 2, config.sessionCount + SUMMARY_LOOKAHEAD + rawProjects.length)
    : config.sessionCount + SUMMARY_LOOKAHEAD;

  const rows = db.db.prepare(`
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
      ss.project,
      ss.merged_into_project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${projectPlaceholders})
           OR ss.merged_into_project IN (${projectPlaceholders}))
      AND (? IS NULL OR s.platform_source = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(
    ...projects,
    ...projects,
    platformSource ?? null,
    platformSource ?? null,
    queryLimit
  ) as SessionSummary[];

  return hasDreamProjects
    ? sortRowsForContext(rows, rawProjects).slice(0, config.sessionCount + SUMMARY_LOOKAHEAD)
    : rows;
}

export function countSummariesByProjects(db: SessionStore, projects: string[], platformSource?: string): number {
  if (projects.length === 0) return 0;
  const projectPlaceholders = projects.map(() => '?').join(',');
  const row = db.db.prepare(`
    SELECT COUNT(*) as count
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${projectPlaceholders})
       OR ss.merged_into_project IN (${projectPlaceholders}))
      AND (? IS NULL OR s.platform_source = ?)
  `).get(...projects, ...projects, platformSource ?? null, platformSource ?? null) as { count: number } | undefined;
  return row?.count ?? 0;
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

  const priorSessionObs = observations.find(obs =>
    obs.memory_session_id !== currentSessionId && !isDreamProject(obs.project)
  );
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
    // Each summary is a "Session started" marker, so back-date it to the start
    // of its session: the next-older summary in the SAME project (its previous
    // session). This applies to every entry, including the newest. In
    // multi-project context allSummaries interleaves projects ordered by time,
    // so we skip summaries from other projects rather than blindly taking
    // allSummaries[i + 1]. allSummaries is over-fetched by SUMMARY_LOOKAHEAD so
    // the last displayed summary still has an older neighbor to anchor to.
    // (Single-project queries don't select `project`, so it is undefined for
    // every row and this matches the immediate next summary, as before.)
    let olderSummary: SessionSummary | null = null;
    for (let j = i + 1; j < allSummaries.length; j++) {
      if (allSummaries[j].project === summary.project) {
        olderSummary = allSummaries[j];
        break;
      }
    }
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
