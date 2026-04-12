/**
 * File Context Handler - PreToolUse
 *
 * Injects relevant observation history when Claude reads/edits a file,
 * so it can avoid duplicating past work.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { parseJsonArray } from '../../shared/timeline-formatting.js';
import { statSync } from 'fs';
import path from 'path';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';

/** Skip the gate for files smaller than this — timeline overhead exceeds file read cost. */
const FILE_READ_GATE_MIN_BYTES = 1_500;

/** Fetch more candidates than the display limit so dedup still fills 15 slots. */
const FETCH_LOOKAHEAD_LIMIT = 40;

/** Maximum observations to show in the timeline. */
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

/**
 * Deduplicate and rank observations for the timeline display.
 *
 * 1. Same-session dedup: keep only the most recent observation per session
 *    (input is already sorted newest-first by SQL).
 * 2. Specificity scoring: rank by how specifically the observation is about
 *    the target file (modified > read-only, fewer total files > many).
 * 3. Truncate to displayLimit.
 */
function deduplicateObservations(
  observations: ObservationRow[],
  targetPath: string,
  displayLimit: number
): ObservationRow[] {
  // Phase 1: Keep only the most recent observation per session
  const seenSessions = new Set<string>();
  const dedupedBySession: ObservationRow[] = [];
  for (const obs of observations) {
    const sessionKey = obs.memory_session_id ?? `no-session-${obs.id}`;
    if (!seenSessions.has(sessionKey)) {
      seenSessions.add(sessionKey);
      dedupedBySession.push(obs);
    }
  }

  // Phase 2: Score by specificity to the target file
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
    // totalFiles > 8: no bonus (survey-like observation)

    return { obs, specificityScore };
  });

  // Stable sort: higher specificity first, preserve chronological order within same score
  scored.sort((a, b) => b.specificityScore - a.specificityScore);

  return scored.slice(0, displayLimit).map(s => s.obs);
}

function formatFileTimeline(
  observations: ObservationRow[],
  filePath: string,
  truncated: boolean
): string {
  // Escape filePath for safe interpolation into recovery hints (quotes, backslashes, newlines)
  const safePath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  // Group observations by day
  const byDay = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    const day = formatDate(obs.created_at_epoch);
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day)!.push(obs);
  }

  // Sort days chronologically (use earliest observation in each group, not first — which is specificity-sorted)
  const sortedDays = Array.from(byDay.entries()).sort((a, b) => {
    const aEpoch = Math.min(...a[1].map(o => o.created_at_epoch));
    const bEpoch = Math.min(...b[1].map(o => o.created_at_epoch));
    return aEpoch - bEpoch;
  });

  // Include current date/time so the model can judge recency of observations
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const currentTime = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase().replace(' ', '');
  const currentTimezone = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();

  const headerLine = truncated
    ? `This file has prior observations. Only line 1 was read to save tokens.`
    : `This file has prior observations. The requested section was read normally.`;

  const lines: string[] = [
    `Current: ${currentDate} ${currentTime} ${currentTimezone}`,
    headerLine,
    `- **Already know enough?** The timeline below may be all you need (semantic priming).`,
    `- **Need details?** get_observations([IDs]) — ~300 tokens each.`,
    `- **Need full file?** Read again with offset/limit for the section you need.`,
    `- **Need to edit?** Edit works — the file is registered as read. Use smart_outline("${safePath}") for line numbers.`,
  ];

  for (const [day, dayObservations] of sortedDays) {
    // Sort within each day chronologically (deduplicateObservations reorders by specificity)
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
    // Extract file_path from toolInput
    const toolInput = input.toolInput as Record<string, unknown> | undefined;
    const filePath = toolInput?.file_path as string | undefined;

    if (!filePath) {
      return { continue: true, suppressOutput: true };
    }

    // Preserve user-supplied offset/limit to avoid read-dedup collisions (fixes #1719)
    const userOffset = typeof toolInput?.offset === 'number' && Number.isFinite(toolInput.offset) && toolInput.offset >= 0
      ? Math.floor(toolInput.offset) : undefined;
    const userLimit = typeof toolInput?.limit === 'number' && Number.isFinite(toolInput.limit) && toolInput.limit > 0
      ? Math.floor(toolInput.limit) : undefined;
    const isTargetedRead = userOffset !== undefined || userLimit !== undefined;

    // Stat the file once: size (gate) + mtime (cache invalidation).
    // 0 = stat failed non-fatally (e.g. EPERM) — skip mtime check, fall through to truncation.
    let fileMtimeMs = 0;
    try {
      const statPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(input.cwd || process.cwd(), filePath);
      const stat = statSync(statPath);
      // Skip gate for files below the token-economics threshold — timeline (~370 tokens)
      // costs more than reading small files directly.
      if (stat.size < FILE_READ_GATE_MIN_BYTES) {
        return { continue: true, suppressOutput: true };
      }
      fileMtimeMs = stat.mtimeMs;
    } catch (err: any) {
      if (err.code === 'ENOENT') return { continue: true, suppressOutput: true };
      // Other errors (symlink, permission denied) — fall through and let gate proceed
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (input.cwd && isProjectExcluded(input.cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file context', { cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    }

    // Ensure worker is running
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return { continue: true, suppressOutput: true };
    }

    // Query worker for observations related to this file
    try {
      const context = getProjectContext(input.cwd);
      // Observations store relative paths — convert absolute to relative using cwd
      const cwd = input.cwd || process.cwd();
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");
      const queryParams = new URLSearchParams({ path: relativePath });
      // Pass all project names (parent + worktree) for unified lookup
      if (context.allProjects.length > 0) {
        queryParams.set('projects', context.allProjects.join(','));
      }
      queryParams.set('limit', String(FETCH_LOOKAHEAD_LIMIT));

      const response = await workerHttpRequest(`/api/observations/by-file?${queryParams.toString()}`, {
        method: 'GET',
      });

      if (!response.ok) {
        logger.warn('HOOK', 'File context query failed, skipping', { status: response.status, filePath });
        return { continue: true, suppressOutput: true };
      }

      const data = await response.json() as { observations: ObservationRow[]; count: number };

      if (!data.observations || data.observations.length === 0) {
        return { continue: true, suppressOutput: true };
      }

      // mtime invalidation: bypass truncation when the file is newer than the latest observation.
      // Uses >= to handle same-millisecond edits (cost: one extra full read vs risk of stuck truncation).
      if (fileMtimeMs > 0) {
        const newestObservationMs = Math.max(...data.observations.map(o => o.created_at_epoch));
        if (fileMtimeMs >= newestObservationMs) {
          logger.debug('HOOK', 'File modified since last observation, skipping truncation', {
            filePath: relativePath,
            fileMtimeMs,
            newestObservationMs,
          });
          return { continue: true, suppressOutput: true };
        }
      }

      // Deduplicate: one per session, ranked by specificity to this file
      const dedupedObservations = deduplicateObservations(data.observations, relativePath, DISPLAY_LIMIT);
      if (dedupedObservations.length === 0) {
        return { continue: true, suppressOutput: true };
      }

      // Unconstrained → truncate to 1 line; targeted → preserve offset/limit.
      const truncated = !isTargetedRead;
      const timeline = formatFileTimeline(dedupedObservations, filePath, truncated);
      const updatedInput: Record<string, unknown> = { file_path: filePath };
      if (isTargetedRead) {
        if (userOffset !== undefined) updatedInput.offset = userOffset;
        if (userLimit !== undefined) updatedInput.limit = userLimit;
      } else {
        updatedInput.limit = 1;
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: timeline,
          permissionDecision: 'allow',
          updatedInput,
        },
      };
    } catch (error) {
      logger.warn('HOOK', 'File context fetch error, skipping', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { continue: true, suppressOutput: true };
    }
  },
};
