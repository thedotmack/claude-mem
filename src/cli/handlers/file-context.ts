
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { parseJsonArray } from '../../shared/timeline-formatting.js';
import { statSync } from 'fs';
import path from 'path';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { getProjectContext } from '../../utils/project-name.js';

const FILE_READ_GATE_MIN_BYTES = 1_500;

const FETCH_LOOKAHEAD_LIMIT = 40;

const DISPLAY_LIMIT = 15;

const TYPE_ICONS: Record<string, string> = {
  decision: '\u2696\uFE0F',
  bugfix: '\uD83D\uDD34',
  feature: '\uD83D\uDFE3',
  refactor: '\uD83D\uDD04',
  discovery: '\uD83D\uDD35',
  change: '\u2705',
};

function compactTime(timeStr: string): string {
  return timeStr.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

function formatTime(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(epoch: number): string {
  const date = new Date(epoch);
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface ObservationRow {
  id: number;
  memory_session_id: string;
  title: string | null;
  type: string;
  created_at_epoch: number;
  files_read: string | null;
  files_modified: string | null;
}

function deduplicateObservations(
  observations: ObservationRow[],
  targetPath: string,
  displayLimit: number
): ObservationRow[] {
  const seenSessions = new Set<string>();
  const dedupedBySession: ObservationRow[] = [];
  for (const obs of observations) {
    const sessionKey = obs.memory_session_id ?? `no-session-${obs.id}`;
    if (!seenSessions.has(sessionKey)) {
      seenSessions.add(sessionKey);
      dedupedBySession.push(obs);
    }
  }

  const scored = dedupedBySession.map(obs => {
    const filesRead = parseJsonArray(obs.files_read);
    const filesModified = parseJsonArray(obs.files_modified);
    const totalFiles = filesRead.length + filesModified.length;
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    const inModified = filesModified.some(f => f.replace(/\\/g, '/') === normalizedTarget);

    let specificityScore = 0;
    if (inModified) specificityScore += 2;
    if (totalFiles <= 3) specificityScore += 2;
    else if (totalFiles <= 8) specificityScore += 1;

    return { obs, specificityScore };
  });

  scored.sort((a, b) => b.specificityScore - a.specificityScore);

  return scored.slice(0, displayLimit).map(s => s.obs);
}

function formatFileTimeline(
  observations: ObservationRow[],
  filePath: string
): string {
  const safePath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const byDay = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    const day = formatDate(obs.created_at_epoch);
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day)!.push(obs);
  }

  const sortedDays = Array.from(byDay.entries()).sort((a, b) => {
    const aEpoch = Math.min(...a[1].map(o => o.created_at_epoch));
    const bEpoch = Math.min(...b[1].map(o => o.created_at_epoch));
    return aEpoch - bEpoch;
  });

  const now = new Date();
  const currentDate = now.toLocaleDateString('en-CA'); 
  const currentTime = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase().replace(' ', '');
  const currentTimezone = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();

  const lines: string[] = [
    `Current: ${currentDate} ${currentTime} ${currentTimezone}`,
    `This file has prior observations — supplementary context follows. The Read result below is the full requested section.`,
    `- **Need details on a past observation?** get_observations([IDs]) — ~300 tokens each.`,
    `- **Need a structural map first?** smart_outline("${safePath}") — line numbers only, cheaper than re-reading.`,
  ];

  for (const [day, dayObservations] of sortedDays) {
    const chronological = [...dayObservations].sort((a, b) => a.created_at_epoch - b.created_at_epoch);
    lines.push(`### ${day}`);
    for (const obs of chronological) {
      const title = (obs.title || 'Untitled').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      const icon = TYPE_ICONS[obs.type] || '\u2753';
      const time = compactTime(formatTime(obs.created_at_epoch));
      lines.push(`${obs.id} ${time} ${icon} ${title}`);
    }
  }

  return lines.join('\n');
}

export const fileContextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const toolInput = input.toolInput as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;

    if (!filePath) {
      return { continue: true, suppressOutput: true };
    }

    let fileMtimeMs = 0;
    try {
      const statPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(input.cwd || process.cwd(), filePath);
      const stat = statSync(statPath);
      if (stat.size < FILE_READ_GATE_MIN_BYTES) {
        return { continue: true, suppressOutput: true };
      }
      fileMtimeMs = stat.mtimeMs;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { continue: true, suppressOutput: true };
      }
      logger.debug('HOOK', 'File stat failed, proceeding with gate', { error: err instanceof Error ? err.message : String(err) });
    }

    if (input.cwd && !shouldTrackProject(input.cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file context', { cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    }

    const context = getProjectContext(input.cwd);
    const cwd = input.cwd || process.cwd();
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");
    const queryParams = new URLSearchParams({ path: relativePath });
    if (context.allProjects.length > 0) {
      queryParams.set('projects', context.allProjects.join(','));
    }
    queryParams.set('limit', String(FETCH_LOOKAHEAD_LIMIT));

    const result = await executeWithWorkerFallback<{ observations: ObservationRow[]; count: number }>(
      `/api/observations/by-file?${queryParams.toString()}`,
      'GET',
    );
    if (isWorkerFallback(result)) {
      return { continue: true, suppressOutput: true };
    }
    if (!result || !Array.isArray((result as any).observations)) {
      logger.warn('HOOK', 'File context query returned malformed body, skipping', { filePath });
      return { continue: true, suppressOutput: true };
    }
    const data = result;

    if (!data.observations || data.observations.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    if (fileMtimeMs > 0) {
      const newestObservationMs = Math.max(...data.observations.map(o => o.created_at_epoch));
      if (fileMtimeMs >= newestObservationMs) {
        logger.debug('HOOK', 'File modified since last observation, skipping context injection', {
          filePath: relativePath,
          fileMtimeMs,
          newestObservationMs,
        });
        return { continue: true, suppressOutput: true };
      }
    }

    const dedupedObservations = deduplicateObservations(data.observations, relativePath, DISPLAY_LIMIT);
    if (dedupedObservations.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    const timeline = formatFileTimeline(dedupedObservations, filePath);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: timeline,
        permissionDecision: 'allow',
      },
    };
  },
};
